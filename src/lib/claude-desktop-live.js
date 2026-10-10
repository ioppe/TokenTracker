"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const cp = require("node:child_process");
const { promisify } = require("node:util");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");

const execFile = promisify(cp.execFile);
const CACHE_MS = 3 * 60_000;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const failures = new Map();
const cache = new Map();
const flights = new Map();
let storageKey = null;
let keyFlight = null;
let keyRetryAt = 0;

function failure(code, retryAt = null) {
  return { quota_refresh_status: "failed", quota_refresh_error: code, quota_retry_at: retryAt };
}

async function safeStorageKey({ securityRunner, nowMs, forceRefresh, keychainTimeoutMs }) {
  if (storageKey) return storageKey;
  const waitForKey = async () => {
    let timer;
    try {
      return await Promise.race([keyFlight, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("keychain-access-required")), 2000);
      })]);
    } finally { clearTimeout(timer); }
  };
  if (keyFlight) return waitForKey();
  if (!forceRefresh && nowMs < keyRetryAt) throw new Error("keychain-access-required");
  keyFlight = (async () => {
    try {
      // Only Claude's own Electron encryption key, never the browser keychain.
      const args = ["find-generic-password", "-s", "Claude Safe Storage", "-a", "Claude Key", "-w"];
      const result = securityRunner
        ? await securityRunner("/usr/bin/security", args, { encoding: "utf8", timeout: keychainTimeoutMs })
        : await execFile("/usr/bin/security", args, { encoding: "utf8", timeout: keychainTimeoutMs });
      const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout.toString("utf8") : result?.stdout;
      if (result?.error || (result?.status != null && result.status !== 0) || !stdout?.trim()) throw new Error();
      storageKey = crypto.pbkdf2Sync(stdout.trim(), "saltysalt", 1003, 16, "sha1");
      return storageKey;
    } catch {
      keyRetryAt = nowMs + 15 * 60_000;
      throw new Error("keychain-access-required");
    } finally { keyFlight = null; }
  })();
  return waitForKey();
}

function decryptClaudeValue(bytes, key, host = null) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 19 || bytes.subarray(0, 3).toString() !== "v10") return null;
  try {
    const decoder = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
    const value = Buffer.concat([decoder.update(bytes.subarray(3)), decoder.final()]);
    const digest = host ? crypto.createHash("sha256").update(host).digest() : null;
    return (digest && value.subarray(0, 32).equals(digest) ? value.subarray(32) : value).toString("utf8");
  } catch { return null; }
}

async function boundedConfig(root) {
  try {
    const file = path.join(root, "config.json");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function selectOauth(config, key, org, nowMs) {
  for (const name of ["oauth:tokenCacheV2", "oauth:tokenCache"]) {
    if (typeof config[name] !== "string") continue;
    let entries;
    try { entries = JSON.parse(decryptClaudeValue(Buffer.from(config[name], "base64"), key)); }
    catch { continue; }
    for (const [identity, entry] of Object.entries(entries || {})) {
      if (!entry || typeof entry.token !== "string" || !Number.isFinite(entry.expiresAt)
        || entry.expiresAt <= nowMs + 30_000) continue;
      const split = identity.split("|");
      if (split.length === 2 && split[0] !== `acct:${config.lastKnownAccountUuid}`) continue;
      if (split.length > 2) continue;
      if (split.length === 1 && !org) continue;
      // Cache keys include a URL and colon-delimited scopes, not just a hostname.
      const match = split.at(-1).match(/^([^:]+):([^:]+):(?:https:\/\/)?api\.anthropic\.com:(.+)$/);
      if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) continue;
      if (org && match[2] !== org) continue;
      if (!match[3].split(/\s+/).includes("user:profile")) continue;
      if (/\s/.test(entry.token) || entry.token.length > 8192) continue;
      return { token: entry.token, org: match[2] };
    }
  }
  return null;
}

async function readDesktopAuth(root, options) {
  const config = await boundedConfig(root);
  let rows = [];
  for (const relative of ["Cookies", path.join("Network", "Cookies")]) {
    const file = path.join(root, relative);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) continue;
      rows = await (options.sqliteReader || readSqliteJsonRowsAsync)(file,
        "SELECT host_key,name,value,hex(encrypted_value) AS encrypted FROM cookies " +
        "WHERE host_key IN ('.claude.ai','claude.ai') AND name IN ('sessionKey','lastActiveOrg','cf_clearance') ORDER BY last_access_utc DESC",
        { readOnly: true, timeout: 2000, maxBuffer: 64 * 1024, label: "Claude Desktop cookies" });
      if (rows.length) break;
    } catch { /* A locked profile can still have a readable OAuth cache. */ }
  }
  const needsKey = rows.some((row) => !row.value && row.encrypted)
    || typeof config["oauth:tokenCacheV2"] === "string" || typeof config["oauth:tokenCache"] === "string";
  let key = null;
  if (needsKey) {
    try { key = await safeStorageKey(options); }
    catch (error) {
      // A plaintext session cookie remains usable even if an unrelated OAuth cache is locked.
      if (!rows.some((row) => row.name === "sessionKey" && row.value)) throw error;
    }
  }
  const cookies = {};
  for (const row of rows) {
    if (cookies[row.name]) continue;
    const value = row.value || (key && decryptClaudeValue(Buffer.from(row.encrypted || "", "hex"), key, row.host_key));
    if (typeof value === "string" && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value) && !/[;\r\n]/.test(value)) {
      cookies[row.name] = value;
    }
  }
  const cookieOrg = UUID.test(cookies.lastActiveOrg || "") ? cookies.lastActiveOrg : null;
  const oauth = key && selectOauth(config, key, cookieOrg, options.nowMs);
  const org = cookieOrg || oauth?.org || null;
  const token = oauth?.token || null;
  if (!token && !(org && cookies.sessionKey)) throw new Error("desktop-sign-in-required");
  // Cache identity changes on sign-out/account/org switches; no credential leaves memory.
  const identity = crypto.createHash("sha256").update(JSON.stringify([
    config.lastKnownAccountUuid || null, org, cookies.sessionKey || token,
  ])).digest("hex");
  return { cookies, org, token, identity };
}

function normalizeDesktopQuota(body, nowMs = Date.now()) {
  const window = (value) => {
    if (!value || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)
      || value.utilization < 0 || value.utilization > 100) return null;
    const reset = Date.parse(value.resets_at);
    return { utilization: value.utilization, resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : null };
  };
  const fiveHour = window(body?.five_hour);
  const sevenDay = window(body?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const capturedAt = new Date(nowMs).toISOString();
  return {
    configured: true, source: "desktop-api", metric: "quota-percent", cached: false,
    cached_at: capturedAt, stale: false, five_hour: fiveHour, seven_day: sevenDay,
    quota_refresh_status: "live", quota_refresh_error: null,
    provenance: { source: "desktop-api", confidence: "observed", captured_at: capturedAt, stale: false, age_seconds: 0 },
  };
}

async function requestQuota(auth, { fetchImpl, timeoutMs, nowMs }) {
  const requests = [];
  if (auth.token) requests.push({
    url: "https://api.anthropic.com/api/oauth/usage",
    headers: { Authorization: `Bearer ${auth.token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (auth.org && auth.cookies.sessionKey) requests.push({
    url: `https://claude.ai/api/organizations/${auth.org}/usage`,
    headers: { Cookie: `sessionKey=${auth.cookies.sessionKey}${auth.cookies.cf_clearance ? `; cf_clearance=${auth.cookies.cf_clearance}` : ""}` },
  });
  let code = "desktop-api-unavailable";
  for (const request of requests) {
    const controller = new AbortController();
    let timer;
    try {
      const result = await Promise.race([
        (async () => {
          const res = await fetchImpl(request.url, {
            method: "GET", headers: { ...request.headers, Accept: "application/json" },
            redirect: "error", signal: controller.signal,
          });
          if (res.status === 429) {
            const raw = res.headers?.get("retry-after");
            const numeric = Number(raw);
            const seconds = raw && Number.isFinite(numeric) ? numeric : (Date.parse(raw) - nowMs) / 1000;
            return failure("desktop-rate-limited", new Date(nowMs + Math.min(3_600_000, Math.max(60_000, (seconds || 300) * 1000))).toISOString());
          }
          if (!res.ok) return failure(res.status === 401 ? "desktop-sign-in-required"
            : res.status === 403 ? "desktop-access-denied" : "desktop-api-unavailable");
          const body = await res.json();
          return normalizeDesktopQuota(body, nowMs) || failure("desktop-quota-unavailable");
        })(),
        new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(failure("desktop-request-timeout")); }, timeoutMs); }),
      ]);
      if (result.quota_refresh_status === "live" || result.quota_retry_at) return result;
      code = result.quota_refresh_error;
    } catch { code = "desktop-api-unavailable"; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return failure(code);
}

async function readClaudeDesktopLiveQuota(root, {
  platform = process.platform, nowMs = Date.now(), fetchImpl = fetch,
  forceRefresh = false, timeoutMs = 4000, keychainTimeoutMs = 30_000,
  securityRunner, sqliteReader,
} = {}) {
  if (platform !== "darwin") return failure("desktop-live-unsupported");
  const options = { nowMs, fetchImpl, forceRefresh, timeoutMs, keychainTimeoutMs, securityRunner, sqliteReader };
  if (flights.has(root)) return flights.get(root);
  const flight = (async () => {
    let auth;
    try { auth = await readDesktopAuth(root, options); }
    catch (error) {
      cache.delete(root);
      return failure(["keychain-access-required", "desktop-sign-in-required"].includes(error.message)
        ? error.message : "desktop-sign-in-required");
    }
    // Used only to select a same-organization history fallback; the public
    // limits collector removes this internal identity metadata.
    const observed = (value) => ({ ...value, auth_detected: true,
      active_org_hash: auth.org ? crypto.createHash("sha256").update(auth.org).digest("hex") : null });
    const previous = cache.get(root);
    const resets = [previous?.five_hour, previous?.seven_day].map((w) => Date.parse(w?.resets_at)).filter(Number.isFinite);
    const captured = Date.parse(previous?.cached_at);
    const expiredWindow = resets.some((reset) => reset > captured && reset <= nowMs);
    const previousForAccount = previous?.identity === auth.identity ? previous : null;
    const cachedFallback = (error) => {
      if (!previousForAccount) return error;
      const { identity: _identity, ...value } = previousForAccount;
      return { ...value, ...error, cached: true, stale: true,
        provenance: { ...value.provenance, stale: true, age_seconds: Math.max(0, Math.round((nowMs - captured) / 1000)) } };
    };
    if (!forceRefresh && previousForAccount && nowMs >= captured && nowMs - captured < CACHE_MS && !expiredWindow) {
      const { identity: _identity, ...value } = previous;
      return observed({ ...value, cached: true });
    }
    const failed = failures.get(root);
    if (failed?.identity === auth.identity && nowMs < failed.retryAt) {
      return observed(cachedFallback(failure(failed.code, new Date(failed.retryAt).toISOString())));
    }
    const result = await requestQuota(auth, options);
    if (result.quota_refresh_status === "live") {
      failures.delete(root);
      cache.set(root, { ...result, identity: auth.identity });
    } else if (result.quota_retry_at) {
      failures.set(root, { identity: auth.identity, retryAt: Date.parse(result.quota_retry_at), code: result.quota_refresh_error });
    }
    return observed(result.quota_refresh_status === "live" ? result : cachedFallback(result));
  })();
  flights.set(root, flight);
  try { return await flight; } finally { flights.delete(root); }
}

function resetClaudeDesktopLiveCacheForTests() {
  storageKey?.fill(0); storageKey = null; keyFlight = null; keyRetryAt = 0;
  cache.clear(); flights.clear(); failures.clear();
}

module.exports = { readClaudeDesktopLiveQuota, normalizeDesktopQuota, decryptClaudeValue, resetClaudeDesktopLiveCacheForTests };
