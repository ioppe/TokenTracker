"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  discoverClaudeDesktopProfiles,
  claudeDesktopTranscriptDirs,
} = require("../src/lib/claude-desktop");
const { resolveScanRoots, describeScanRootOrigin } = require("../src/lib/scan-roots");

test("Claude Desktop discovers default/numbered/explicit roots, excludes symlinks and unrelated .claude files", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-claude-desktop-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const defaultRoot = path.join(home, "Library", "Application Support", "Claude");
  for (const dir of [defaultRoot, ".claude1", ".claude10", ".claude2", ".claude-backups", ".claude0", ".claude-work"]) {
    fs.mkdirSync(path.resolve(home, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(home, ".claude3"), "not a directory");
  fs.symlinkSync(path.join(home, ".claude1"), path.join(home, ".claude4"), "dir");
  const env = { TOKENTRACKER_CLAUDE_DESKTOP_HOME: "~/.claude-work" };
  const profiles = discoverClaudeDesktopProfiles({ home, env, platform: "darwin" });
  assert.deepEqual(profiles, [defaultRoot, path.join(home, ".claude-work"),
    ...[1, 2, 10].map((n) => path.join(home, `.claude${n}`))]);
  assert.deepEqual(claudeDesktopTranscriptDirs([path.join(home, ".claude1")]), [
    path.join(home, ".claude1", "projects"), path.join(home, ".claude1", "claude-code-sessions"),
  ]);
  assert.ok(!claudeDesktopTranscriptDirs(profiles).some((dir) => dir.includes("local-agent-mode")));
});

test("Claude Desktop root discovery is shared with the root registry and explicit entries keep their origin", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-desktop-roots-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const profile = path.join(home, ".claude1");
  fs.mkdirSync(profile);
  const roots = resolveScanRoots({ home, env: {}, base: { claude: [path.join(home, ".claude")] } });
  assert.equal(roots.claude.find((entry) => entry.path === profile).origin, "desktop");
  assert.equal(describeScanRootOrigin(roots.claude[1], "claude"), "Claude Desktop");
  const explicit = resolveScanRoots({ home, env: {}, config: { scanRoots: { claude: [profile] } } });
  assert.equal(explicit.claude.filter((entry) => entry.path === profile).length, 1);
  assert.equal(explicit.claude[0].origin, "config");
});
