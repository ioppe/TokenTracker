"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { claudeDesktopDefaultRoot, discoverClaudeDesktopProfiles } = require("./claude-desktop");

const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const STALE_AFTER_MS = 10 * 60 * 1000;

async function readSmallFile(filePath, maxBytes) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await fs.readFile(filePath, "utf8");
  } catch (_e) {
    return null;
  }
}

async function readJson(filePath, maxBytes) {
  const raw = await readSmallFile(filePath, maxBytes);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

function quotaWindow(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return { utilization: value, resets_at: null };
}

function normalizeClaudeDesktopHistory(history, { nowMs = Date.now() } = {}) {
  if (history?.version !== 2 || !Array.isArray(history.samples) || !Number.isFinite(nowMs)) return null;
  let latest = null;
  for (const sample of history.samples) {
    if (!Number.isSafeInteger(sample?.t) || sample.t <= 0 || sample.t > nowMs
      || typeof sample.org !== "string" || !sample.org.trim()) continue;
    if (!latest || sample.t >= latest.t) latest = sample;
  }
  // Choose the newest account observation before validating its windows: an
  // empty new account must not resurrect percentages from a previous login.
  if (!latest) return null;
  const fiveHour = quotaWindow(latest.u?.fh);
  const sevenDay = quotaWindow(latest.u?.sd);
  if (!fiveHour && !sevenDay) return null;
  const capturedAt = new Date(latest.t).toISOString();
  const ageMs = nowMs - latest.t;
  return {
    configured: true,
    source: "local-history",
    metric: "quota-percent",
    cached: true,
    cached_at: capturedAt,
    stale: ageMs > STALE_AFTER_MS,
    five_hour: fiveHour,
    seven_day: sevenDay,
    provenance: {
      source: "local-history",
      confidence: "observed",
      captured_at: capturedAt,
      stale: ageMs > STALE_AFTER_MS,
      age_seconds: Math.round(ageMs / 1000),
    },
  };
}

function profileMetadata(root, { home, env, platform }) {
  if (root === claudeDesktopDefaultRoot({ home, env, platform })) {
    return { profile_id: "default", profile_number: null, profile_name: null };
  }
  const name = path.basename(root);
  const numbered = path.dirname(root) === home && /^\.claude[1-9]\d*$/.test(name);
  const number = numbered ? Number(name.slice(".claude".length)) : null;
  return {
    profile_id: numbered ? name : `custom-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
    profile_number: Number.isSafeInteger(number) ? number : null,
    profile_name: Number.isSafeInteger(number) ? null : name.slice(0, 100),
  };
}

async function readClaudeDesktopUsageLimits({
  home = os.homedir(), env = process.env, platform = process.platform,
  config = null, nowMs = Date.now(),
} = {}) {
  const support = path.join(home, "Library", "Application Support", "CodexQuotaViewer");
  const [trackerConfig, names, selected] = await Promise.all([
    config || readJson(path.join(home, ".tokentracker", "tracker", "config.json"), 256 * 1024),
    readJson(path.join(support, "ClaudeAccountNames.json"), 64 * 1024),
    readSmallFile(path.join(support, "SelectedClaudeAccount.txt"), 1024),
  ]);
  const profiles = discoverClaudeDesktopProfiles({ home, env, platform, config: trackerConfig });
  const accounts = await Promise.all(profiles.map(async (root) => {
    const history = await readJson(path.join(root, "plan-usage-history.json"), HISTORY_MAX_BYTES);
    const limits = normalizeClaudeDesktopHistory(history, { nowMs });
    if (!limits) return null;
    const metadata = profileMetadata(root, { home, env, platform });
    const displayName = names?.[metadata.profile_id];
    return {
      ...limits,
      ...metadata,
      display_name: typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 100) : null,
      is_selected: selected?.trim() === metadata.profile_id,
    };
  }));
  return accounts.filter(Boolean);
}

module.exports = { normalizeClaudeDesktopHistory, readClaudeDesktopUsageLimits };
