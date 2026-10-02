"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  claudeDesktopDefaultRoot,
  discoverClaudeDesktopProfiles,
  claudeDesktopAgentSessionDirs,
} = require("./claude-desktop");
const { computeRowCost, getModelPricing } = require("./pricing");

const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const AGENT_JSONL_MAX_BYTES = 16 * 1024 * 1024;
const AGENT_MAX_FILES = 600;
const AGENT_MAX_DEPTH = 16;
const AGENT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const TOKEN_USAGE_SOURCE = "local-agent-session";
const TOKEN_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "total_tokens",
];

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

async function readBoundedText(filePath, maxBytes) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      return { skipped: true, mtimeMs: stat.mtimeMs, bytes: stat.size };
    }
    return {
      raw: await fs.readFile(filePath, "utf8"),
      mtimeMs: stat.mtimeMs,
      bytes: stat.size,
    };
  } catch (_e) {
    return null;
  }
}

function nonNegativeSafeInteger(value) {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeClaudeDesktopUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const raw = {
    input_tokens: usage.input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cached_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    output_tokens: usage.output_tokens,
  };
  const normalized = {};
  let hasField = false;
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) {
      normalized[key] = 0;
      continue;
    }
    hasField = true;
    const count = nonNegativeSafeInteger(value);
    if (count == null) return null;
    normalized[key] = count;
  }
  if (!hasField) return null;
  normalized.total_tokens = TOKEN_FIELDS
    .filter((key) => key !== "total_tokens")
    .reduce((sum, key) => sum + normalized[key], 0);
  return normalized;
}

function addUsageTotals(target, delta) {
  for (const key of TOKEN_FIELDS) target[key] += delta[key] || 0;
}

function emptyUsageTotals() {
  return Object.fromEntries(TOKEN_FIELDS.map((key) => [key, 0]));
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    return Number.isFinite(millis) ? millis : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return parseTimestamp(Number(value));
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function safeObservedTimestamp(values, fallbackMs, nowMs) {
  for (const value of values) {
    const millis = parseTimestamp(value);
    if (millis == null || millis <= 0 || millis > nowMs + MAX_FUTURE_SKEW_MS) continue;
    return millis;
  }
  if (Number.isFinite(fallbackMs) && fallbackMs > 0 && fallbackMs <= nowMs + MAX_FUTURE_SKEW_MS) {
    return fallbackMs;
  }
  return nowMs;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function usageEventParts(record) {
  const message = record?.message && typeof record.message === "object" ? record.message : null;
  const event = record?.event && typeof record.event === "object" ? record.event : null;
  const eventMessage = event?.message && typeof event.message === "object" ? event.message : null;
  const usage = message?.usage || record?.usage || eventMessage?.usage || event?.usage;
  const model = firstText(message?.model, record?.model, eventMessage?.model, event?.model) || "unknown";
  const messageId = firstText(message?.id, record?.message_id, eventMessage?.id, event?.message_id);
  const requestId = firstText(record?.requestId, record?.request_id, event?.requestId, event?.request_id);
  const fallbackId = firstText(record?.uuid, event?.uuid, record?.id, event?.id);
  return { usage, model, messageId, requestId, fallbackId, event };
}

function usageEventIdentity(parts, filePath, lineNumber) {
  if (parts.messageId && parts.requestId) return `message:${parts.messageId}:${parts.requestId}`;
  if (parts.messageId) return `message:${parts.messageId}`;
  if (parts.requestId) return `request:${parts.requestId}`;
  if (parts.fallbackId) return `event:${parts.fallbackId}`;
  return `line:${filePath}:${lineNumber}`;
}

async function listJsonlFiles(root, {
  maxFiles = AGENT_MAX_FILES,
  maxDepth = AGENT_MAX_DEPTH,
} = {}) {
  const files = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root, 0);
  return { files, truncated };
}

function estimateClaudeDesktopCost(model, totals) {
  const pricing = getModelPricing(model, { source: "claude" });
  const hasPricing = [pricing.input, pricing.output, pricing.cache_read, pricing.cache_write]
    .some((value) => Number(value) > 0);
  if (!hasPricing) return null;
  return computeRowCost({
    source: "claude",
    model,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cached_input_tokens: totals.cache_read_input_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
  });
}

function buildTokenUsage(events) {
  const totals = emptyUsageTotals();
  const byModel = new Map();
  for (const event of events) {
    addUsageTotals(totals, event.usage);
    const current = byModel.get(event.model) || emptyUsageTotals();
    addUsageTotals(current, event.usage);
    byModel.set(event.model, current);
  }

  const models = Array.from(byModel.entries())
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([model, modelTotals]) => ({
      model,
      ...modelTotals,
      estimated_cost_usd: estimateClaudeDesktopCost(model, modelTotals),
    }));
  const priced = models.filter((model) => model.estimated_cost_usd != null);
  const estimatedCost = priced.length > 0
    ? priced.reduce((sum, model) => sum + model.estimated_cost_usd, 0)
    : null;
  return {
    ...totals,
    messages: events.length,
    models,
    estimated_cost_usd: estimatedCost,
    estimated_cost_status: priced.length === 0
      ? "unavailable"
      : priced.length === models.length ? "complete" : "partial",
  };
}

async function readClaudeDesktopAgentUsage(root, { nowMs = Date.now() } = {}) {
  const files = [];
  const seen = new Set();
  let truncated = false;
  for (const directory of claudeDesktopAgentSessionDirs([root])) {
    const listed = await listJsonlFiles(directory);
    truncated ||= listed.truncated;
    for (const filePath of listed.files) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      files.push(filePath);
    }
  }

  const events = new Map();
  let latestFileMs = 0;
  let bytesRead = 0;
  for (const filePath of files) {
    if (bytesRead >= AGENT_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const remainingBytes = AGENT_MAX_TOTAL_BYTES - bytesRead;
    const content = await readBoundedText(
      filePath,
      Math.min(AGENT_JSONL_MAX_BYTES, remainingBytes),
    );
    if (!content) continue;
    if (content.skipped) {
      truncated = true;
      break;
    }
    const contentBytes = Buffer.byteLength(content.raw, "utf8");
    if (bytesRead + contentBytes > AGENT_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    bytesRead += contentBytes;
    latestFileMs = Math.max(latestFileMs, Number(content.mtimeMs) || 0);
    const lines = content.raw.split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      const parts = usageEventParts(record);
      const usage = normalizeClaudeDesktopUsage(parts.usage);
      if (!usage) continue;
      const timestampMs = safeObservedTimestamp([
        record.timestamp,
        record.created_at,
        record.time,
        record.message?.created_at,
        parts.event?.timestamp,
        parts.event?.time,
      ], content.mtimeMs, nowMs);
      const identity = usageEventIdentity(parts, filePath, lineNumber);
      const candidate = { model: parts.model, usage, timestampMs };
      const previous = events.get(identity);
      if (!previous
        || usage.total_tokens > previous.usage.total_tokens
        || (usage.total_tokens === previous.usage.total_tokens && timestampMs >= previous.timestampMs)) {
        events.set(identity, candidate);
      }
    }
  }

  const orderedEvents = Array.from(events.values());
  const latestEventMs = orderedEvents.reduce((latest, event) => Math.max(latest, event.timestampMs), 0);
  const capturedAtMs = latestEventMs || latestFileMs || nowMs;
  return {
    detected: files.length > 0,
    session_files: files.length,
    truncated,
    usage_events: orderedEvents.length,
    captured_at: new Date(capturedAtMs).toISOString(),
    token_usage: orderedEvents.length > 0 ? buildTokenUsage(orderedEvents) : null,
  };
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
    const [history, tokenUsage] = await Promise.all([
      readJson(path.join(root, "plan-usage-history.json"), HISTORY_MAX_BYTES),
      readClaudeDesktopAgentUsage(root, { nowMs }),
    ]);
    const limits = normalizeClaudeDesktopHistory(history, { nowMs });
    if (!limits && !tokenUsage.detected) return null;
    const metadata = profileMetadata(root, { home, env, platform });
    const displayName = names?.[metadata.profile_id];
    const tokenUsageStatus = tokenUsage.token_usage
      ? tokenUsage.truncated ? "partial" : "observed"
      : tokenUsage.truncated ? "partial" : "unavailable";
    const tokenFields = tokenUsage.detected ? {
      token_usage_status: tokenUsageStatus,
      token_usage_source: TOKEN_USAGE_SOURCE,
      token_usage_files: tokenUsage.session_files,
      token_usage_truncated: tokenUsage.truncated,
      token_usage_captured_at: tokenUsage.captured_at,
      token_usage: tokenUsage.token_usage,
      token_usage_provenance: {
        source: TOKEN_USAGE_SOURCE,
        confidence: tokenUsageStatus,
        captured_at: tokenUsage.captured_at,
        session_files: tokenUsage.session_files,
      },
    } : {};
    const base = limits || {
      configured: true,
      source: TOKEN_USAGE_SOURCE,
      metric: "token-usage",
      cached: false,
      cached_at: tokenUsage.captured_at,
      stale: false,
      five_hour: null,
      seven_day: null,
      provenance: {
        source: TOKEN_USAGE_SOURCE,
        confidence: tokenUsageStatus,
        captured_at: tokenUsage.captured_at,
        stale: false,
      },
    };
    return {
      ...base,
      ...tokenFields,
      ...metadata,
      display_name: typeof displayName === "string" && displayName.trim()
        ? displayName.trim().slice(0, 100) : null,
      is_selected: selected?.trim() === metadata.profile_id,
    };
  }));
  return accounts.filter(Boolean);
}

module.exports = {
  normalizeClaudeDesktopHistory,
  normalizeClaudeDesktopUsage,
  readClaudeDesktopAgentUsage,
  readClaudeDesktopUsageLimits,
};
