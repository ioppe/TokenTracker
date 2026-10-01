"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { parsePiDesktopIncremental } = require("../src/lib/rollout");
const { buildPiDesktopUsageEvents, readPiDesktopUsageRows,
  resolvePiDesktopDbPath } = require("../src/lib/pi-desktop-usage");
const { available, DatabaseSync, createPiDesktopDb, executeSql, insertTurn, quote } =
  require("./helpers/pi-desktop-fixture");
const sqliteTest = available ? test : test.skip;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pi-desktop-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = createPiDesktopDb(home);
  const queuePath = path.join(home, "tracker", "queue.jsonl");
  const cursors = {};
  return { home, dbPath, queuePath, cursors,
    parse: (overrides = {}) => parsePiDesktopIncremental({ dbPath, queuePath, cursors, ...overrides }) };
}

function latestRows(queuePath) {
  const rows = fs.readFileSync(queuePath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return [...new Map(rows.map((row) => [`${row.source}|${row.model}|${row.hour_start}`, row])).values()];
}

test("PI Desktop paths are home-anchored, distinct from Pi CLI and overridable", () => {
  const home = path.resolve(os.tmpdir(), "pi-path-test");
  assert.equal(resolvePiDesktopDbPath({ HOME: home }), path.join(home, ".pi-desktop", "pi.sqlite"));
  for (const value of ["profiles/pi.sqlite", "~/profiles/pi.sqlite"]) {
    assert.equal(resolvePiDesktopDbPath({ HOME: home, TOKENTRACKER_PI_DESKTOP_DB: value }),
      path.join(home, "profiles", "pi.sqlite"));
  }
  assert.equal(resolvePiDesktopDbPath({ HOME: home, TOKENTRACKER_PI_DESKTOP_DB: "~" }), home);
});

sqliteTest("PI Desktop selects only counters, cache is additional input and reasoning is not doubled", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  const before = crypto.createHash("sha256").update(fs.readFileSync(f.dbPath)).digest("hex");
  const rows = await readPiDesktopUsageRows(f.dbPath);
  assert.ok(!JSON.stringify(rows).includes("PRIVATE"));
  const [event] = buildPiDesktopUsageEvents(rows);
  assert.equal(event.totals.total_tokens, 420);
  assert.equal(event.totals.cached_input_tokens, 300);
  assert.equal(event.totals.input_tokens, 100);
  assert.equal(event.totals.output_tokens, 20);
  assert.equal(event.totals.reasoning_output_tokens, 0);
  assert.match(event.requestId, /^[a-f0-9]{64}$/);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(f.dbPath)).digest("hex"), before);
  const result = await f.parse();
  assert.equal(result.eventsAggregated, 1);
  const [row] = latestRows(f.queuePath);
  assert.equal(row.source, "pi-desktop");
  assert.equal(row.total_tokens, 420);
  assert.equal(row.conversation_count, 1);
  const persisted = fs.readFileSync(f.queuePath, "utf8") + JSON.stringify(f.cursors);
  for (const secret of ["PRIVATE", "turn-1", "session-1", f.home]) assert.ok(!persisted.includes(secret));
});

sqliteTest("PI Desktop includes spent aborted/error turns, ignores running/empty turns and counts each session once", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  insertTurn(f.dbPath, { id: "aborted", status: "aborted", input: 10, output: 5, cache: 0 });
  insertTurn(f.dbPath, { id: "failed", session: "session-2", status: "error", input: 8, output: 2, cache: 0 });
  insertTurn(f.dbPath, { id: "running", status: "running", input: 900 });
  insertTurn(f.dbPath, { id: "empty", input: 0, output: 0, cache: 0 });
  await f.parse();
  const [row] = latestRows(f.queuePath);
  assert.equal(row.total_tokens, 445);
  assert.equal(row.conversation_count, 2);
  assert.equal(Object.keys(f.cursors.piDesktop.turns).length, 3);
  const queue = fs.readFileSync(f.queuePath, "utf8");
  const cursors = JSON.stringify(f.cursors);
  assert.equal((await f.parse()).recordsProcessed, 0);
  assert.equal(fs.readFileSync(f.queuePath, "utf8"), queue);
  assert.equal(JSON.stringify(f.cursors), cursors);
  executeSql(f.dbPath, "UPDATE turns SET status='completed', input_tokens=9, output_tokens=1, usage_json='{}' WHERE id='running'");
  await f.parse();
  assert.equal(latestRows(f.queuePath)[0].total_tokens, 455);
  assert.equal(latestRows(f.queuePath)[0].conversation_count, 2);
});

sqliteTest("PI Desktop reconciles corrected counters/model/time, including zero; pruning does not erase history", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  await f.parse();
  executeSql(f.dbPath, `UPDATE turns SET model_id='claude-sonnet-4',
    started_at=${Date.parse("2026-09-30T11:42:00Z")},
    usage_json=${quote(JSON.stringify({ inputTokens: 30, outputTokens: 10, cacheReadTokens: 500 }))}
    WHERE id='turn-1'`);
  await f.parse();
  let rows = latestRows(f.queuePath);
  assert.equal(rows.find((row) => row.model === "gpt-5.4").total_tokens, 0);
  const current = rows.find((row) => row.model === "claude-sonnet-4");
  assert.equal(current.total_tokens, 540);
  assert.equal(current.hour_start, "2026-09-30T11:30:00.000Z");
  assert.equal(rows.reduce((sum, row) => sum + row.conversation_count, 0), 1);
  executeSql(f.dbPath, "DELETE FROM turns");
  await f.parse();
  assert.equal(latestRows(f.queuePath).reduce((sum, row) => sum + row.total_tokens, 0), 540);
  insertTurn(f.dbPath, { input: 0, output: 0, cache: 0, model: "claude-sonnet-4" });
  await f.parse();
  rows = latestRows(f.queuePath);
  assert.equal(rows.reduce((sum, row) => sum + row.total_tokens, 0), 0);
});

sqliteTest("PI Desktop malformed/missing usage JSON falls back to columns without inventing tokens", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath, { rawUsage: "{bad JSON", input: 4, output: 3 });
  insertTurn(f.dbPath, { id: "bad-fields", input: 6, output: 2,
    rawUsage: JSON.stringify({ inputTokens: -1, outputTokens: "1000", cacheReadTokens: -50, totalTokens: 99999 }) });
  insertTurn(f.dbPath, { id: "cache-write", input: 1, output: 1, creation: 100 });
  await f.parse();
  const [row] = latestRows(f.queuePath);
  assert.equal(row.input_tokens, 11);
  assert.equal(row.output_tokens, 6);
  assert.equal(row.cache_creation_input_tokens, 100);
  assert.equal(row.total_tokens, 417);
});

sqliteTest("PI Desktop failed append does not publish ledger/fingerprint or mutate another provider", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  await f.parse();
  f.cursors.hourly.buckets["codex|gpt-5.4|2026-09-30T10:00:00.000Z"] = {
    totals: { input_tokens: 123, total_tokens: 123 }, queuedKey: "123",
  };
  executeSql(f.dbPath, "UPDATE turns SET usage_json='{}', input_tokens=30, output_tokens=10");
  const before = JSON.stringify(f.cursors);
  const blockedQueue = path.join(f.home, "directory-not-file");
  fs.mkdirSync(blockedQueue);
  await assert.rejects(f.parse({ queuePath: blockedQueue }));
  assert.equal(JSON.stringify(f.cursors), before);
  await f.parse();
  assert.equal(latestRows(f.queuePath)[0].total_tokens, 40);
  assert.equal(f.cursors.hourly.buckets["codex|gpt-5.4|2026-09-30T10:00:00.000Z"].totals.total_tokens, 123);
});

sqliteTest("PI Desktop unreadable schema retries without advancing cursors; missing database is never created", async (t) => {
  const f = fixture(t);
  const missing = path.join(f.home, "missing.sqlite");
  assert.equal((await f.parse({ dbPath: missing })).bucketsQueued, 0);
  assert.equal(fs.existsSync(missing), false);
  executeSql(f.dbPath, "DROP TABLE turns");
  const before = JSON.stringify(f.cursors);
  await assert.rejects(f.parse(), /Cannot read PI Desktop/);
  assert.equal(JSON.stringify(f.cursors), before);
});

sqliteTest("PI Desktop never acknowledges changes made during a read", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  const rows = await readPiDesktopUsageRows(f.dbPath);
  let changed = false;
  await f.parse({ sqliteOptions: { execFile: async (_command, args) => {
    assert.ok(args.includes("-readonly"));
    if (!changed) {
      changed = true;
      insertTurn(f.dbPath, { id: "late-turn", session: "session-2", input: 5, output: 5, cache: 0 });
    }
    return { stdout: JSON.stringify(rows) };
  } } });
  assert.equal(latestRows(f.queuePath)[0].total_tokens, 420);
  await f.parse();
  assert.equal(latestRows(f.queuePath)[0].total_tokens, 430);
});

(DatabaseSync ? test : test.skip)("PI Desktop sees real WAL-only writes without changing the application database", async (t) => {
  const f = fixture(t);
  insertTurn(f.dbPath);
  const db = new DatabaseSync(f.dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    await f.parse();
    const before = fs.statSync(f.dbPath).mtimeMs;
    db.exec("UPDATE turns SET usage_json='{}', input_tokens=12, output_tokens=3");
    assert.equal(fs.statSync(f.dbPath).mtimeMs, before, "only the WAL changed");
    await f.parse();
    assert.equal(latestRows(f.queuePath)[0].total_tokens, 15);
    assert.equal(fs.statSync(f.dbPath).mtimeMs, before, "reader must not checkpoint or write to the app DB");
    assert.equal((await f.parse()).recordsProcessed, 0);
  } finally { db.close(); }
});
