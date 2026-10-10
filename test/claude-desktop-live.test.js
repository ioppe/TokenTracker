"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { readClaudeDesktopLiveQuota, normalizeDesktopQuota, decryptClaudeValue, resetClaudeDesktopLiveCacheForTests } = require("../src/lib/claude-desktop-live");
const { readClaudeDesktopUsageLimits } = require("../src/lib/claude-desktop-limits");

const nowMs = Date.parse("2026-10-02T18:00:00Z");
const org = "11111111-1111-1111-1111-111111111111";
const account = "22222222-2222-2222-2222-222222222222";
const client = "33333333-3333-3333-3333-333333333333";
const body = { five_hour: { utilization: 18, resets_at: "2026-10-02T20:00:00Z" }, seven_day: { utilization: 42, resets_at: "2026-10-08T12:00:00Z" } };
const response = (value = body, status = 200, retryAfter = null) => ({ ok: status === 200, status, json: async () => value, headers: { get: () => retryAfter } });

function fixture(t) {
  resetClaudeDesktopLiveCacheForTests();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-live-desktop-"));
  const root = path.join(home, "Library", "Application Support", "Claude");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "Cookies"), "fixture");
  const rows = [{ host_key: ".claude.ai", name: "sessionKey", value: "PRIVATE-SESSION" }, { host_key: ".claude.ai", name: "lastActiveOrg", value: org }];
  const requests = [];
  const options = { nowMs, platform: "darwin", sqliteReader: async () => rows,
    fetchImpl: async (url, opts) => { requests.push({ url, ...opts }); return response(); } };
  t.after(() => { resetClaudeDesktopLiveCacheForTests(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, root, rows, requests, options };
}

function encrypt(text, key) {
  const encoder = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([Buffer.from("v10"), encoder.update(text), encoder.final()]);
}

test("live quota comes from the signed-in Desktop account and carries real resets", async (t) => {
  const f = fixture(t);
  const result = await readClaudeDesktopLiveQuota(f.root, f.options);
  assert.equal(result.source, "desktop-api");
  assert.equal(result.quota_refresh_status, "live");
  assert.equal(result.cached_at, new Date(nowMs).toISOString());
  assert.equal(result.five_hour.utilization, body.five_hour.utilization);
  assert.equal(Date.parse(result.five_hour.resets_at), Date.parse(body.five_hour.resets_at));
  assert.equal(f.requests[0].headers.Cookie, "sessionKey=PRIVATE-SESSION");
  assert.equal(f.requests[0].redirect, "error");
  assert.ok(!JSON.stringify(result).includes("PRIVATE-SESSION"));
  assert.ok(!JSON.stringify(result).includes(org));
});

test("quota normalization never treats missing or malformed counters as zero", () => {
  for (const invalid of [{}, { five_hour: {} }, { five_hour: { utilization: "50" } }, { five_hour: { utilization: 101 } }, { five_hour: { utilization: -1 } }]) assert.equal(normalizeDesktopQuota(invalid, nowMs), null);
  assert.equal(normalizeDesktopQuota({ seven_day: { utilization: 0 } }, nowMs).five_hour, null);
});

test("polls reuse fresh data but manual refresh and a reset trigger another GET", async (t) => {
  const f = fixture(t);
  f.options.fetchImpl = async () => { f.requests.push(1); return response({ ...body, five_hour: { ...body.five_hour, resets_at: new Date(nowMs + 30_000).toISOString() } }); };
  await readClaudeDesktopLiveQuota(f.root, f.options);
  assert.equal((await readClaudeDesktopLiveQuota(f.root, { ...f.options, nowMs: nowMs + 1000 })).cached, true);
  assert.equal(f.requests.length, 1);
  await readClaudeDesktopLiveQuota(f.root, { ...f.options, nowMs: nowMs + 31_000 });
  await readClaudeDesktopLiveQuota(f.root, { ...f.options, forceRefresh: true });
  assert.equal(f.requests.length, 3);
});

test("a profile account switch never reuses the previous account's quota", async (t) => {
  const f = fixture(t);
  await readClaudeDesktopLiveQuota(f.root, f.options);
  f.rows[0].value = "NEW-PRIVATE-SESSION";
  f.rows[1].value = account;
  f.options.fetchImpl = async () => response(null, 401);
  const result = await readClaudeDesktopLiveQuota(f.root, { ...f.options, nowMs: nowMs + 1000 });
  assert.equal(result.quota_refresh_error, "desktop-sign-in-required");
  assert.equal(result.five_hour, undefined);
});

test("network failure retains the last good sample time and explicitly marks it stale", async (t) => {
  const f = fixture(t);
  await readClaudeDesktopLiveQuota(f.root, f.options);
  f.options.fetchImpl = async () => { throw new Error("PRIVATE network detail"); };
  const result = await readClaudeDesktopLiveQuota(f.root, { ...f.options, forceRefresh: true, nowMs: nowMs + 60_000 });
  assert.equal(result.quota_refresh_error, "desktop-api-unavailable");
  assert.equal(result.cached_at, new Date(nowMs).toISOString());
  assert.equal(result.stale, true);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("HTTP 429 cooldown cannot be bypassed by repeated manual refresh", async (t) => {
  const f = fixture(t);
  f.options.fetchImpl = async () => { f.requests.push(1); return response(null, 429, "600"); };
  await readClaudeDesktopLiveQuota(f.root, f.options);
  await readClaudeDesktopLiveQuota(f.root, { ...f.options, forceRefresh: true, nowMs: nowMs + 1000 });
  assert.equal(f.requests.length, 1);
  await readClaudeDesktopLiveQuota(f.root, { ...f.options, nowMs: nowMs + 601_000 });
  assert.equal(f.requests.length, 2);
});

test("concurrent refreshes share one upstream request", async (t) => {
  const f = fixture(t);
  await Promise.all(Array.from({ length: 5 }, () => readClaudeDesktopLiveQuota(f.root, f.options)));
  assert.equal(f.requests.length, 1);
});

test("even a fetch implementation that ignores abort is bounded", async (t) => {
  const f = fixture(t);
  const result = await readClaudeDesktopLiveQuota(f.root, { ...f.options, timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(result.quota_refresh_error, "desktop-request-timeout");
});

test("denied keychain access exposes an action reason without credentials or repeated prompts", async (t) => {
  const f = fixture(t);
  f.rows[0] = { ...f.rows[0], value: "", encrypted: "763130" };
  let reads = 0;
  const opts = { ...f.options, securityRunner: async () => { reads += 1; throw new Error("PRIVATE password detail"); } };
  const result = await readClaudeDesktopLiveQuota(f.root, opts);
  await readClaudeDesktopLiveQuota(f.root, { ...opts, nowMs: nowMs + 1000 });
  assert.equal(reads, 1);
  assert.equal(result.quota_refresh_error, "keychain-access-required");
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.equal(f.requests.length, 0);
});

test("Electron v10 cookies strip the Chromium host digest; Safe Storage JSON does not", () => {
  const key = crypto.pbkdf2Sync("fixture-password", "saltysalt", 1003, 16, "sha1");
  const text = Buffer.from("PRIVATE-SESSION");
  const cookie = encrypt(Buffer.concat([crypto.createHash("sha256").update(".claude.ai").digest(), text]), key);
  assert.equal(decryptClaudeValue(cookie, key, ".claude.ai"), text.toString());
  assert.equal(decryptClaudeValue(encrypt(Buffer.from("{}"), key), key), "{}");
  assert.equal(decryptClaudeValue(Buffer.from("v20bad"), key), null);
});

test("Desktop's existing OAuth cache is used without rotating or writing its refresh token", async (t) => {
  const f = fixture(t);
  const password = "fixture-password";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const entry = { token: "PRIVATE-OAUTH", refreshToken: "PRIVATE-REFRESH", expiresAt: nowMs + 3600_000 };
  const config = { lastKnownAccountUuid: account, "oauth:tokenCacheV2": encrypt(Buffer.from(JSON.stringify({
    [`acct:${account}|${client}:${org}:https://api.anthropic.com:user:profile user:inference`]: entry,
  })), key).toString("base64") };
  fs.writeFileSync(path.join(f.root, "config.json"), JSON.stringify(config));
  const result = await readClaudeDesktopLiveQuota(f.root, { ...f.options, securityRunner: async () => ({ stdout: password }) });
  assert.equal(result.quota_refresh_status, "live");
  assert.equal(f.requests[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(f.requests[0].headers.Authorization, "Bearer PRIVATE-OAUTH");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, "config.json"))), config);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
});

test("an account-scoped OAuth cache works without cookies; an unscoped cache needs an active organization", async (t) => {
  const f = fixture(t);
  f.rows.length = 0;
  const password = "fixture-password";
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const entry = { token: "PRIVATE-OAUTH", expiresAt: nowMs + 3600_000 };
  const identity = `${client}:${org}:https://api.anthropic.com:user:profile`;
  const config = { lastKnownAccountUuid: account };
  const writeCache = (name) => {
    config["oauth:tokenCacheV2"] = encrypt(Buffer.from(JSON.stringify({ [name]: entry })), key).toString("base64");
    fs.writeFileSync(path.join(f.root, "config.json"), JSON.stringify(config));
  };
  const options = { ...f.options, securityRunner: async () => ({ stdout: password }) };
  writeCache(`acct:${account}|${identity}`);
  assert.equal((await readClaudeDesktopLiveQuota(f.root, options)).quota_refresh_status, "live");
  writeCache(identity);
  assert.equal((await readClaudeDesktopLiveQuota(f.root, options)).quota_refresh_error, "desktop-sign-in-required");
  assert.equal(f.requests.length, 1);
});

test("a failed active account never inherits another organization's history or a fake sample date", async (t) => {
  const f = fixture(t);
  const old = Date.parse("2026-09-23T05:31:22Z");
  fs.writeFileSync(path.join(f.root, "plan-usage-history.json"), JSON.stringify({
    version: 2, samples: [{ t: old, org: account, u: { fh: 95, sd: 55 } }],
  }));
  f.options.fetchImpl = async () => response(null, 401);
  const liveQuotaReader = (root) => readClaudeDesktopLiveQuota(root, f.options);
  const [failed] = await readClaudeDesktopUsageLimits({ home: f.home, env: {}, platform: "darwin", nowMs, liveQuotaReader });
  assert.equal(failed.five_hour, null);
  assert.equal(failed.cached_at, null);
  assert.equal(failed.provenance.captured_at, null);
  assert.equal(failed.token_usage, null);
  assert.equal(failed.quota_refresh_error, "desktop-sign-in-required");
  assert.ok(!JSON.stringify(failed).includes(org));
  assert.equal(failed.active_org_hash, undefined);
});

test("live results replace September history; failed refresh never advances history's date", async (t) => {
  const f = fixture(t);
  const old = Date.parse("2026-09-23T05:31:22Z");
  fs.writeFileSync(path.join(f.root, "plan-usage-history.json"), JSON.stringify({ version: 2, samples: [{ t: old, org, u: { fh: 95, sd: 55 } }] }));
  const liveQuotaReader = (root) => readClaudeDesktopLiveQuota(root, f.options);
  const [current] = await readClaudeDesktopUsageLimits({ home: f.home, env: {}, platform: "darwin", nowMs, liveQuotaReader });
  assert.equal(current.five_hour.utilization, 18);
  assert.equal(current.cached_at, new Date(nowMs).toISOString());
  resetClaudeDesktopLiveCacheForTests();
  const [failed] = await readClaudeDesktopUsageLimits({ home: f.home, env: {}, platform: "darwin", nowMs,
    liveQuotaReader: async () => ({ quota_refresh_status: "failed", quota_refresh_error: "keychain-access-required" }) });
  assert.equal(failed.cached_at, new Date(old).toISOString());
  assert.equal(failed.stale, true);
  assert.equal(failed.quota_refresh_error, "keychain-access-required");
  assert.equal(failed.token_usage, null);
});
