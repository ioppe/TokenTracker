"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeClaudeDesktopHistory,
  normalizeClaudeDesktopUsage,
  readClaudeDesktopAgentUsage,
  readClaudeDesktopUsageLimits,
} = require("../src/lib/claude-desktop-limits");

const nowMs = Date.parse("2026-10-02T12:00:00Z");
const sample = (u, t = nowMs - 60_000, org = "private-org") => ({ t, org, u });
const history = (...samples) => ({ version: 2, samples });

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-desktop-limits-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "Library", "Application Support", "Claude");
  function write(dir, data) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "plan-usage-history.json"), JSON.stringify(data));
  }
  return { home, root, write, options: { home, env: {}, platform: "darwin", nowMs } };
}

test("desktop history selects the latest observation, not a sum or peak", () => {
  const result = normalizeClaudeDesktopHistory(history(
    sample({ fh: 95, sd: 80 }, nowMs - 120_000),
    sample({ fh: 0, sd: 2.5 }),
    sample({ fh: 90, sd: 70 }, nowMs - 180_000),
  ), { nowMs });
  assert.deepEqual(result.five_hour, { utilization: 0, resets_at: null });
  assert.deepEqual(result.seven_day, { utilization: 2.5, resets_at: null });
  assert.equal(result.cached_at, new Date(nowMs - 60_000).toISOString());
  assert.equal(result.metric, "quota-percent");
  assert.equal(result.source, "local-history");
  assert.equal(result.cached, true);
  assert.equal(result.stale, false);
  assert.equal(result.provenance.confidence, "observed");
  assert.equal(result.provenance.age_seconds, 60);
  assert.ok(!JSON.stringify(result).includes("private-org"));
  assert.ok(!Object.keys(result).some((key) => /token|cost/.test(key)));
});

test("desktop history preserves partial windows without inventing zeros or resets", () => {
  const result = normalizeClaudeDesktopHistory(history(sample({ sd: 100 })), { nowMs });
  assert.equal(result.five_hour, null);
  assert.deepEqual(result.seven_day, { utilization: 100, resets_at: null });
});

test("a newer account sample never borrows quota from an earlier account", () => {
  const result = normalizeClaudeDesktopHistory(history(
    sample({ fh: 90, sd: 95 }, nowMs - 120_000, "previous-account"),
    sample({}, nowMs - 60_000, "new-account"),
  ), { nowMs });
  assert.equal(result, null);
});

test("desktop history marks old observations stale without erasing the sample time", () => {
  const result = normalizeClaudeDesktopHistory(history(sample({ fh: 30 }, nowMs - 3_600_000)), { nowMs });
  assert.equal(result.stale, true);
  assert.equal(result.provenance.stale, true);
  assert.equal(result.cached_at, "2026-10-02T11:00:00.000Z");
});

test("desktop history rejects malformed schemas, timestamps and percentages", () => {
  for (const invalid of [null, {}, { version: 1, samples: [sample({ fh: 20 })] }, history(),
    history({ ...sample({ fh: 20 }), t: "2026-10-02" }),
    history(sample({ fh: 20 }, nowMs + 1)),
    history({ ...sample({ fh: 20 }), org: null }),
    history(sample({ fh: "40", sd: false })),
    history(sample({ fh: -1, sd: 101 })),
    history(sample({ fh: NaN, sd: Infinity })),
    history(sample({ fh: null, sd: null }))]) {
    assert.equal(normalizeClaudeDesktopHistory(invalid, { nowMs }), null);
  }
});

test("desktop usage normalizes only structured non-negative token fields", () => {
  assert.deepEqual(normalizeClaudeDesktopUsage({
    input_tokens: 100,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
    output_tokens: "7",
  }), {
    input_tokens: 100,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 5,
    output_tokens: 7,
    total_tokens: 132,
  });
  assert.equal(normalizeClaudeDesktopUsage({ total_tokens: 100 }), null);
  assert.equal(normalizeClaudeDesktopUsage({ input_tokens: -1, output_tokens: 2 }), null);
  assert.equal(normalizeClaudeDesktopUsage({ input_tokens: "not-a-number" }), null);
});

test("desktop Agent/Cowork JSONL usage is deduplicated without returning message content", async (t) => {
  const f = fixture(t);
  const first = path.join(f.root, "local-agent-mode-sessions", "workspace", ".claude", "projects", "one.jsonl");
  const duplicate = path.join(f.root, "claude-code-sessions", "copy.jsonl");
  const records = [
    { type: "user", message: { content: [{ type: "text", text: "PRIVATE PROMPT" }] } },
    { type: "assistant", timestamp: "2026-10-02T11:00:00Z", requestId: "req-1",
      message: { id: "msg-1", model: "claude-sonnet-4", content: "PRIVATE RESPONSE",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } } },
    { type: "assistant", timestamp: "2026-10-02T11:01:00Z",
      message: { id: "msg-2", model: "claude-sonnet-4", usage: { input_tokens: 50, output_tokens: 5 } } },
    { type: "assistant", message: { id: "ignored", usage: { total_tokens: 999 } } },
    "truncated",
  ];
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.mkdirSync(path.dirname(duplicate), { recursive: true });
  fs.writeFileSync(first, `${records.map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n")}\n`);
  fs.writeFileSync(duplicate, `${JSON.stringify(records[1])}\n`);

  const result = await readClaudeDesktopAgentUsage(f.root, { nowMs });
  assert.equal(result.detected, true);
  assert.equal(result.session_files, 2);
  assert.equal(result.usage_events, 2);
  assert.equal(result.token_usage.input_tokens, 150);
  assert.equal(result.token_usage.cache_read_input_tokens, 20);
  assert.equal(result.token_usage.output_tokens, 12);
  assert.equal(result.token_usage.total_tokens, 182);
  assert.equal(result.token_usage.messages, 2);
  assert.equal(result.token_usage.models[0].model, "claude-sonnet-4");
  assert.ok(!JSON.stringify(result).includes("PRIVATE PROMPT"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE RESPONSE"));
});

test("desktop usage keeps the final streaming snapshot for one assistant message", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "claude-code-sessions", "streaming.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { type: "assistant", timestamp: "2026-10-02T11:00:00Z", session_id: "stream-session",
      message: { id: "stream-message", model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 1 } } },
    { type: "assistant", timestamp: "2026-10-02T11:00:01Z", session_id: "stream-session",
      message: { id: "stream-message", model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 9 } } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const result = await readClaudeDesktopAgentUsage(f.root, { nowMs });
  assert.equal(result.usage_events, 1);
  assert.equal(result.token_usage.input_tokens, 100);
  assert.equal(result.token_usage.output_tokens, 9);
  assert.equal(result.token_usage.total_tokens, 109);
  assert.equal(result.token_usage.aggregation.mode, "per-event");
  assert.equal(result.token_usage.scan_stats.usage_events_deduplicated, 1);
  assert.ok(!JSON.stringify(result).includes("stream-session"));
});

test("desktop usage converts explicit cumulative session snapshots into deltas", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "claude-code-sessions", "cumulative.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { type: "usage_snapshot", timestamp: "2026-10-02T11:00:00Z", session_id: "cumulative-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 10, output_tokens: 2 } },
    { type: "usage_snapshot", timestamp: "2026-10-02T11:01:00Z", session_id: "cumulative-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 30, output_tokens: 5 } },
    { type: "usage_snapshot", timestamp: "2026-10-02T11:02:00Z", session_id: "cumulative-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 30, output_tokens: 5 } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const result = await readClaudeDesktopAgentUsage(f.root, { nowMs });
  assert.equal(result.token_usage.input_tokens, 30);
  assert.equal(result.token_usage.output_tokens, 5);
  assert.equal(result.token_usage.total_tokens, 35);
  assert.equal(result.token_usage.messages, 2);
  assert.equal(result.token_usage.observed_events, 3);
  assert.deepEqual(result.token_usage.aggregation, {
    mode: "cumulative-delta",
    confidence: "observed",
    sessions: 1,
    observed_events: 3,
    cumulative_snapshots: 3,
    cumulative_events_counted: 2,
    cumulative_unchanged: 1,
    cumulative_resets: 0,
    ambiguous_events: 0,
  });
});

test("desktop usage treats a lower cumulative snapshot as a session reset", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "claude-code-sessions", "reset.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { type: "usage_snapshot", timestamp: "2026-10-02T11:00:00Z", session_id: "reset-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 20, output_tokens: 5 } },
    { type: "usage_snapshot", timestamp: "2026-10-02T11:01:00Z", session_id: "reset-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 3, output_tokens: 1 } },
    { type: "usage_snapshot", timestamp: "2026-10-02T11:02:00Z", session_id: "reset-session",
      model: "claude-sonnet-4", session_usage: { input_tokens: 4, output_tokens: 2 } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const result = await readClaudeDesktopAgentUsage(f.root, { nowMs });
  assert.equal(result.token_usage.total_tokens, 31);
  assert.equal(result.token_usage.aggregation.cumulative_resets, 1);
  assert.equal(result.token_usage.aggregation.cumulative_events_counted, 3);
});

test("desktop usage marks cumulative snapshots without a session key ambiguous", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "claude-code-sessions", "ambiguous.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [
    { type: "usage_snapshot", timestamp: "2026-10-02T11:00:00Z", model: "claude-sonnet-4",
      session_usage: { input_tokens: 10, output_tokens: 1 } },
    { type: "usage_snapshot", timestamp: "2026-10-02T11:01:00Z", model: "claude-sonnet-4",
      session_usage: { input_tokens: 15, output_tokens: 2 } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const result = await readClaudeDesktopAgentUsage(f.root, { nowMs });
  assert.equal(result.token_usage.total_tokens, 28);
  assert.equal(result.token_usage.aggregation.mode, "ambiguous");
  assert.equal(result.token_usage.aggregation.confidence, "ambiguous");
  assert.equal(result.token_usage.aggregation.ambiguous_events, 2);
});

test("desktop usage cache reuses unchanged files and reads appended records incrementally", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "claude-code-sessions", "incremental.jsonl");
  const cachePath = path.join(f.home, ".tokentracker", "tracker", "claude-desktop-usage.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const firstLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-02T11:00:00Z",
    message: { id: "incremental-1", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 2 } },
  }) + "\n";
  const secondLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-10-02T11:01:00Z",
    message: { id: "incremental-2", model: "claude-sonnet-4", usage: { input_tokens: 20, output_tokens: 4 } },
  }) + "\n";
  fs.writeFileSync(file, firstLine);

  const first = await readClaudeDesktopAgentUsage(f.root, { nowMs, cachePath });
  assert.equal(first.scan_stats.files_reparsed, 1);
  assert.equal(first.scan_stats.files_reused, 0);
  assert.equal(first.token_usage.total_tokens, 12);

  fs.appendFileSync(file, secondLine);
  const second = await readClaudeDesktopAgentUsage(f.root, { nowMs: nowMs + 60_000, cachePath });
  assert.equal(second.scan_stats.files_incremental, 1);
  assert.equal(second.scan_stats.files_reused, 0);
  assert.equal(second.scan_stats.bytes_read, Buffer.byteLength(secondLine));
  assert.equal(second.token_usage.total_tokens, 36);

  const third = await readClaudeDesktopAgentUsage(f.root, { nowMs: nowMs + 120_000, cachePath });
  assert.equal(third.scan_stats.files_reused, 1);
  assert.equal(third.scan_stats.bytes_read, 0);
  assert.equal(third.token_usage.total_tokens, 36);
});

test("desktop accounts expose unavailable usage when Agent files have no usage fields", async (t) => {
  const f = fixture(t);
  f.write(f.root, history(sample({ fh: 12, sd: 30 })));
  const file = path.join(f.root, "local-agent-mode-sessions", "workspace", "session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "PRIVATE PROMPT" } }));

  const [account] = await readClaudeDesktopUsageLimits(f.options);
  assert.equal(account.metric, "quota-percent");
  assert.equal(account.token_usage_status, "unavailable");
  assert.equal(account.token_usage, null);
  assert.equal(account.token_usage_files, 1);
  assert.ok(!JSON.stringify(account).includes("PRIVATE PROMPT"));
});

test("a usage-only desktop profile is returned without inventing quota percentages", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "local-agent-mode-sessions", "workspace", "session.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: "2026-10-02T11:30:00Z",
    message: { id: "msg-1", model: "claude-sonnet-4", usage: { input_tokens: 10, output_tokens: 2 } } }));

  const [account] = await readClaudeDesktopUsageLimits(f.options);
  assert.equal(account.metric, "token-usage");
  assert.equal(account.token_usage_status, "observed");
  assert.equal(account.token_usage.input_tokens, 10);
  assert.equal(account.token_usage.output_tokens, 2);
  assert.equal(account.token_usage.total_tokens, 12);
  assert.equal(account.token_usage.messages, 1);
  assert.equal(account.token_usage.models.length, 1);
  assert.equal(account.token_usage.models[0].model, "claude-sonnet-4");
  assert.ok(!Object.hasOwn(account, "five_hour") || account.five_hour == null);
});

test("a future sample cannot override an observed sample", () => {
  const result = normalizeClaudeDesktopHistory(history(
    sample({ fh: 35 }), sample({ fh: 99 }, nowMs + 1),
  ), { nowMs });
  assert.equal(result.five_hour.utilization, 35);
});

test("collector returns separate default and numbered account snapshots with launcher labels", async (t) => {
  const f = fixture(t);
  f.write(f.root, history(sample({ fh: 12, sd: 30 })));
  f.write(path.join(f.home, ".claude1"), history(sample({ fh: 80, sd: 40 })));
  const support = path.join(f.home, "Library", "Application Support", "CodexQuotaViewer");
  fs.mkdirSync(support, { recursive: true });
  fs.writeFileSync(path.join(support, "ClaudeAccountNames.json"), JSON.stringify({ ".claude1": "Work" }));
  fs.writeFileSync(path.join(support, "SelectedClaudeAccount.txt"), ".claude1\n");
  const accounts = await readClaudeDesktopUsageLimits(f.options);
  assert.deepEqual(accounts.map((a) => a.profile_id), ["default", ".claude1"]);
  assert.deepEqual(accounts.map((a) => a.five_hour.utilization), [12, 80]);
  assert.equal(accounts[1].profile_number, 1);
  assert.equal(accounts[1].display_name, "Work");
  assert.equal(accounts[1].is_selected, true);
  assert.equal(accounts[0].is_selected, false);
  const output = JSON.stringify(accounts);
  assert.ok(!output.includes(f.home));
  assert.ok(!output.includes("private-org"));
});

test("collector supports explicit desktop profiles from saved scan roots and environment", async (t) => {
  const f = fixture(t);
  const configured = path.join(f.home, "desktop-profile");
  const envRoot = path.join(f.home, "other-profile");
  f.write(configured, history(sample({ fh: 25 })));
  fs.mkdirSync(path.join(configured, "claude-code-sessions"));
  f.write(envRoot, history(sample({ sd: 50 })));
  const tracker = path.join(f.home, ".tokentracker", "tracker");
  fs.mkdirSync(tracker, { recursive: true });
  fs.writeFileSync(path.join(tracker, "config.json"), JSON.stringify({ scanRoots: { claude: [configured] } }));
  const accounts = await readClaudeDesktopUsageLimits({ ...f.options,
    env: { TOKENTRACKER_CLAUDE_DESKTOP_HOME: envRoot } });
  assert.deepEqual(accounts.map((a) => a.profile_name), ["other-profile", "desktop-profile"]);
  assert.ok(accounts.every((a) => a.profile_id.startsWith("custom-")));
});

test("bad or missing histories do not prevent another profile from being read", async (t) => {
  const f = fixture(t);
  f.write(f.root, history(sample({ fh: 10 })));
  f.write(path.join(f.home, ".claude1"), history());
  fs.writeFileSync(path.join(f.home, ".claude1", "plan-usage-history.json"), "{truncated");
  fs.mkdirSync(path.join(f.home, ".claude2"));
  const accounts = await readClaudeDesktopUsageLimits(f.options);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].profile_id, "default");
});

test("collector does not follow history symlinks or read oversized histories", async (t) => {
  const f = fixture(t);
  f.write(f.root, history(sample({ fh: 10 })));
  const one = path.join(f.home, ".claude1");
  const two = path.join(f.home, ".claude2");
  fs.mkdirSync(one);
  fs.mkdirSync(two);
  fs.symlinkSync(path.join(f.root, "plan-usage-history.json"), path.join(one, "plan-usage-history.json"));
  fs.writeFileSync(path.join(two, "plan-usage-history.json"), " ".repeat(4 * 1024 * 1024 + 1));
  assert.equal((await readClaudeDesktopUsageLimits(f.options)).length, 1);
});
