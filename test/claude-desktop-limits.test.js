"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeClaudeDesktopHistory, readClaudeDesktopUsageLimits } = require("../src/lib/claude-desktop-limits");

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
