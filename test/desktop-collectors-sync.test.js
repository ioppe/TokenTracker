"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { available, createPiDesktopDb, insertTurn } = require("./helpers/pi-desktop-fixture");
const tracker = path.resolve(__dirname, "..", "bin", "tracker.js");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-desktop-sync-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    TOKENTRACKER_NO_TELEMETRY: "1", TOKENTRACKER_WSL_MODE: "native-only",
  };
  // Prevent hooks, provider overrides, real credentials or external roots
  // inherited from the developer's shell from entering these tests.
  for (const key of Object.keys(env)) {
    if ((key.startsWith("TOKENTRACKER_") && !["TOKENTRACKER_NO_TELEMETRY", "TOKENTRACKER_WSL_MODE"].includes(key)) ||
      ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "CODE_HOME", "GEMINI_HOME", "OPENCODE_HOME", "DSH_HOME"].includes(key)) {
      delete env[key];
    }
  }
  const queuePath = path.join(home, ".tokentracker", "tracker", "queue.jsonl");
  const run = (...args) => {
    const result = cp.spawnSync(process.execPath, [tracker, ...args], {
      env, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  return { home, env, queuePath, run };
}

function totals(queuePath, source) {
  if (!fs.existsSync(queuePath)) return 0;
  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const latest = new Map(rows.filter((row) => row.source === source)
    .map((row) => [`${row.model}|${row.hour_start}`, row.total_tokens]));
  return [...latest.values()].reduce((sum, total) => sum + total, 0);
}

function transcript(dir, id, input = 30, output = 10) {
  fs.mkdirSync(dir, { recursive: true });
  const content = [
    { type: "user", timestamp: "2026-09-30T10:03:00Z",
      message: { content: [{ type: "text", text: "PRIVATE PROMPT" }] } },
    { type: "assistant", timestamp: "2026-09-30T10:04:00Z", requestId: `req-${id}`,
      message: { id, model: "claude-sonnet-4", content: "PRIVATE RESPONSE",
        usage: { input_tokens: input, output_tokens: output } } },
  ].map(JSON.stringify).join("\n") + "\n";
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

(available ? test : test.skip)("desktop background refresh reads PI SQLite and Claude profiles but not unrelated CLI trees", (t) => {
  const f = fixture(t);
  insertTurn(createPiDesktopDb(f.home));
  const appFile = transcript(path.join(f.home, ".claude1", "claude-code-sessions", "session"), "app", 5, 2);
  const copied = path.join(f.home, ".claude2", "projects", "project");
  fs.mkdirSync(copied, { recursive: true });
  fs.copyFileSync(appFile, path.join(copied, "copy.jsonl"));
  transcript(path.join(f.home, ".claude", "projects", "cli"), "cli", 900, 90);
  transcript(path.join(f.home, ".claude1", "local-agent-mode-sessions", "cowork-workspace"), "cowork", 5000, 500);
  f.run("sync", "--auto", "--background");
  assert.equal(totals(f.queuePath, "pi-desktop"), 420);
  assert.equal(totals(f.queuePath, "claude"), 7, "desktop copy is deduplicated, CLI and Cowork workspaces excluded");
  const before = fs.readFileSync(f.queuePath, "utf8");
  f.run("sync", "--auto", "--background");
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), before);
  f.run("sync", "--auto", "--from-notify", "--source", "claude");
  assert.equal(totals(f.queuePath, "claude"), 997, "explicit Claude scan includes CLI and desktop logs exactly once");
  assert.equal(totals(f.queuePath, "pi-desktop"), 420);
  assert.ok(!fs.readFileSync(f.queuePath, "utf8").includes("PRIVATE"));
});

(available ? test : test.skip)("source-scoped desktop collectors do not scan the other desktop application", (t) => {
  const f = fixture(t);
  insertTurn(createPiDesktopDb(f.home));
  transcript(path.join(f.home, ".claude1", "projects", "project"), "app");
  f.run("sync", "--auto", "--from-notify", "--background", "--source", "pi-desktop");
  assert.equal(totals(f.queuePath, "pi-desktop"), 420);
  assert.equal(totals(f.queuePath, "claude"), 0);
  f.run("sync", "--auto", "--from-notify", "--background", "--source", "claude-desktop");
  assert.equal(totals(f.queuePath, "claude"), 40);
  assert.equal(totals(f.queuePath, "pi-desktop"), 420);
});

test("Claude Desktop status distinguishes missing token logs from zero usage and ignores quota history", (t) => {
  const f = fixture(t);
  const root = path.join(f.home, ".claude1");
  fs.mkdirSync(path.join(root, "claude-code-sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "claude-code-sessions", "index.json"), '{"sessions": []}');
  fs.writeFileSync(path.join(root, "plan-usage-history.json"), '{"samples": [{"t": 123, "org": "PRIVATE", "u": 0.5}]}');
  let status = JSON.parse(f.run("status", "--json"));
  assert.equal(status.providers.claude_desktop.installed, true);
  assert.equal(status.providers.claude_desktop.profiles, 1);
  assert.equal(status.providers.claude_desktop.collection_status, "token_logs_unavailable");
  assert.equal(status.providers.pi_desktop.installed, false);
  f.run("sync", "--auto", "--from-notify", "--background", "--source", "claude-desktop");
  assert.equal(totals(f.queuePath, "claude"), 0);
  transcript(path.join(root, "claude-code-sessions", "new"), "new");
  status = JSON.parse(f.run("status", "--json"));
  assert.equal(status.providers.claude_desktop.collection_status, "transcripts_detected");
  assert.equal(status.providers.claude_desktop.files, 1);
});

test("full Claude repair includes desktop logs and defers when an earlier desktop profile disappears", (t) => {
  const f = fixture(t);
  transcript(path.join(f.home, ".claude", "projects", "cli"), "cli", 10, 5);
  const root = path.join(f.home, ".claude1");
  transcript(path.join(root, "claude-code-sessions", "app"), "app", 30, 5);
  f.run("sync", "--auto", "--from-notify", "--source", "claude-desktop");
  assert.equal(totals(f.queuePath, "claude"), 35);
  // Move, rather than destroy, a fixture to model an unavailable profile.
  fs.renameSync(root, path.join(f.home, "temporarily-unmounted"));
  f.run("sync");
  assert.equal(totals(f.queuePath, "claude"), 50, "unavailable desktop history survives the repair guard");
  fs.renameSync(path.join(f.home, "temporarily-unmounted"), root);
  f.run("sync");
  assert.equal(totals(f.queuePath, "claude"), 50, "repair covers both desktop and CLI roots");
  f.run("sync");
  assert.equal(totals(f.queuePath, "claude"), 50);
});
