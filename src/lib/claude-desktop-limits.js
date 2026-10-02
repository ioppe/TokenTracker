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
const AGENT_USAGE_CACHE_VERSION = 2;
const AGENT_USAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const AGENT_USAGE_CACHE_DIR = "claude-desktop-usage";
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const STALE_AFTER_MS = 10 * 60 * 1000;
const TOKEN_USAGE_SOURCE = "local-agent-session";
const USAGE_SCOPE_PER_EVENT = "per-event";
const USAGE_SCOPE_CUMULATIVE = "cumulative";
const USAGE_SCOPE_AMBIGUOUS = "ambiguous";
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

async function readBoundedBytes(filePath, startOffset, maxBytes) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > AGENT_JSONL_MAX_BYTES) {
      return {
        skipped: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: Number(stat.ino) || 0,
        dev: Number(stat.dev) || 0,
      };
    }
    const start = Math.max(0, Math.min(Number(startOffset) || 0, stat.size));
    const length = stat.size - start;
    if (length > maxBytes) {
      return {
        skipped: true,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: Number(stat.ino) || 0,
        dev: Number(stat.dev) || 0,
      };
    }
    const handle = await fs.open(filePath, "r");
    try {
      const raw = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const result = await handle.read({
          buffer: raw,
          offset: bytesRead,
          length: length - bytesRead,
          position: start + bytesRead,
        });
        if (!result.bytesRead) break;
        bytesRead += result.bytesRead;
      }
      return {
        raw: bytesRead === length ? raw : raw.subarray(0, bytesRead),
        startOffset: start,
        bytes: bytesRead,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: Number(stat.ino) || 0,
        dev: Number(stat.dev) || 0,
      };
    } finally {
      await handle.close().catch(() => {});
    }
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

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function usageScopeMarker(...values) {
  for (const value of values) {
    if (typeof value === "boolean") {
      if (value) return USAGE_SCOPE_CUMULATIVE;
      continue;
    }
    if (typeof value !== "string") continue;
    const marker = value.trim().toLowerCase();
    if (!marker) continue;
    if (marker.includes("cumulative") || marker.includes("session") || marker === "total") {
      return USAGE_SCOPE_CUMULATIVE;
    }
    if (marker.includes("delta") || marker.includes("turn") || marker.includes("request")) {
      return USAGE_SCOPE_PER_EVENT;
    }
  }
  return null;
}

function inferUsageScope(usage, ...records) {
  const usageMarker = usageScopeMarker(
    usage?.scope,
    usage?.kind,
    usage?.type,
    usage?.usage_type,
    usage?.usageType,
    usage?.cumulative,
    usage?.is_cumulative,
    usage?.isCumulative,
  );
  if (usageMarker) return usageMarker;
  const recordMarker = usageScopeMarker(...records.flatMap((record) => [
    record?.usage_scope,
    record?.usageScope,
    record?.usage_type,
    record?.usageType,
    record?.scope,
    record?.kind,
    record?.type,
    record?.cumulative,
    record?.is_cumulative,
    record?.isCumulative,
  ]));
  return recordMarker || USAGE_SCOPE_PER_EVENT;
}

function usageEventParts(record) {
  const message = record?.message && typeof record.message === "object" ? record.message : null;
  const event = record?.event && typeof record.event === "object" ? record.event : null;
  const eventMessage = event?.message && typeof event.message === "object" ? event.message : null;
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : null;
  const cumulativeUsage = firstObject(
    record?.cumulative_usage,
    record?.cumulativeUsage,
    record?.session_usage,
    record?.sessionUsage,
    record?.total_usage,
    record?.totalUsage,
    message?.cumulative_usage,
    message?.cumulativeUsage,
    eventMessage?.cumulative_usage,
    eventMessage?.cumulativeUsage,
    event?.cumulative_usage,
    event?.cumulativeUsage,
    payload?.cumulative_usage,
    payload?.cumulativeUsage,
  );
  const regularUsage = firstObject(
    message?.usage,
    record?.usage,
    eventMessage?.usage,
    event?.usage,
    payload?.usage,
  );
  const usage = cumulativeUsage || regularUsage;
  const model = firstText(
    message?.model,
    record?.model,
    eventMessage?.model,
    event?.model,
    payload?.model,
  ) || "unknown";
  const messageId = firstText(
    message?.id,
    record?.message_id,
    record?.messageId,
    eventMessage?.id,
    event?.message_id,
    event?.messageId,
    payload?.message_id,
    payload?.messageId,
  );
  const requestId = firstText(record?.requestId, record?.request_id, event?.requestId, event?.request_id);
  const fallbackId = firstText(record?.uuid, event?.uuid, record?.id, event?.id);
  const sessionId = firstText(
    message?.session_id,
    message?.sessionId,
    record?.session_id,
    record?.sessionId,
    record?.conversation_id,
    record?.conversationId,
    record?.thread_id,
    record?.threadId,
    event?.session_id,
    event?.sessionId,
    event?.conversation_id,
    event?.conversationId,
    event?.thread_id,
    event?.threadId,
    payload?.session_id,
    payload?.sessionId,
    payload?.conversation_id,
    payload?.conversationId,
  );
  const usageScope = cumulativeUsage
    ? USAGE_SCOPE_CUMULATIVE
    : inferUsageScope(regularUsage, record, event, eventMessage, payload);
  return {
    usage,
    usageScope,
    model,
    messageId,
    requestId,
    fallbackId,
    sessionId: sessionId ? eventIdentityDigest(`session:${sessionId}`) : null,
    event,
  };
}

function usageEventIdentity(parts, usage, timestampMs) {
  if (parts.messageId) return `message:${parts.messageId}`;
  if (parts.requestId) return `request:${parts.requestId}`;
  if (parts.fallbackId) return `event:${parts.fallbackId}`;
  const usageKey = TOKEN_FIELDS
    .filter((key) => key !== "total_tokens")
    .map((key) => usage[key] || 0)
    .join(",");
  return [
    "fingerprint",
    parts.sessionId || "",
    parts.model,
    parts.usageScope || USAGE_SCOPE_PER_EVENT,
    timestampMs,
    usageKey,
  ].join(":");
}

function eventIdentityDigest(identity) {
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
}

function chooseUsageEvent(previous, candidate) {
  if (!previous) return candidate;
  const previousScope = previous.usageScope === USAGE_SCOPE_CUMULATIVE ? 1 : 0;
  const candidateScope = candidate.usageScope === USAGE_SCOPE_CUMULATIVE ? 1 : 0;
  if (candidateScope !== previousScope) return candidateScope > previousScope ? candidate : previous;
  if (candidate.usage.output_tokens > previous.usage.output_tokens) return candidate;
  if (candidate.usage.output_tokens === previous.usage.output_tokens
    && candidate.usage.total_tokens > previous.usage.total_tokens) return candidate;
  if (candidate.usage.output_tokens === previous.usage.output_tokens
    && candidate.usage.total_tokens === previous.usage.total_tokens
    && candidate.timestampMs >= previous.timestampMs) return candidate;
  return previous;
}

function usageCachePath(home, root) {
  const key = crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
  return path.join(home, ".tokentracker", "tracker", AGENT_USAGE_CACHE_DIR, `${key}.json`);
}

async function readAgentUsageCache(cachePath) {
  if (!cachePath) return { version: AGENT_USAGE_CACHE_VERSION, files: {} };
  const raw = await readSmallFile(cachePath, AGENT_USAGE_CACHE_MAX_BYTES);
  if (raw === null) return { version: AGENT_USAGE_CACHE_VERSION, files: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== AGENT_USAGE_CACHE_VERSION
      || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
      return { version: AGENT_USAGE_CACHE_VERSION, files: {} };
    }
    return parsed;
  } catch (_e) {
    return { version: AGENT_USAGE_CACHE_VERSION, files: {} };
  }
}

async function writeAgentUsageCache(cachePath, files) {
  if (!cachePath) return false;
  const payload = JSON.stringify({ version: AGENT_USAGE_CACHE_VERSION, files });
  if (Buffer.byteLength(payload, "utf8") > AGENT_USAGE_CACHE_MAX_BYTES) return false;
  const temporary = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, cachePath);
    return true;
  } catch (_e) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    return false;
  }
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

function diffUsage(current, previous) {
  const reset = Boolean(previous && TOKEN_FIELDS
    .filter((key) => key !== "total_tokens")
    .some((key) => current[key] < previous[key]));
  const delta = emptyUsageTotals();
  for (const key of TOKEN_FIELDS) {
    if (key === "total_tokens") continue;
    delta[key] = !previous || reset ? current[key] : Math.max(0, current[key] - previous[key]);
  }
  delta.total_tokens = TOKEN_FIELDS
    .filter((key) => key !== "total_tokens")
    .reduce((sum, key) => sum + delta[key], 0);
  return { delta, reset };
}

function aggregateSessionUsage(events) {
  const ordered = [...events].sort(
    (a, b) => a.timestampMs - b.timestampMs || a.identity.localeCompare(b.identity, "en"),
  );
  const effectiveEvents = [];
  const cumulativeGroups = new Map();
  const sessionIds = new Set();
  let cumulativeSnapshots = 0;
  let cumulativeEventsCounted = 0;
  let cumulativeUnchanged = 0;
  let cumulativeResets = 0;
  let ambiguousEvents = 0;

  for (const event of ordered) {
    if (event.sessionId) sessionIds.add(event.sessionId);
    if (event.usageScope !== USAGE_SCOPE_CUMULATIVE) {
      effectiveEvents.push(event);
      continue;
    }
    cumulativeSnapshots += 1;
    if (!event.sessionId) {
      // An explicit cumulative snapshot without a session key cannot be
      // safely differenced across files. Keep the observation visible, but
      // mark the aggregation ambiguous instead of silently treating it as a
      // turn delta.
      ambiguousEvents += 1;
      effectiveEvents.push({ ...event, usageScope: USAGE_SCOPE_AMBIGUOUS });
      continue;
    }
    const key = `${event.sessionId}\u0000${event.model}`;
    const group = cumulativeGroups.get(key) || [];
    group.push(event);
    cumulativeGroups.set(key, group);
  }

  for (const group of cumulativeGroups.values()) {
    let previous = null;
    for (const event of group) {
      const { delta, reset } = diffUsage(event.usage, previous);
      if (reset) cumulativeResets += 1;
      previous = event.usage;
      if (delta.total_tokens <= 0) {
        cumulativeUnchanged += 1;
        continue;
      }
      cumulativeEventsCounted += 1;
      effectiveEvents.push({
        ...event,
        usage: delta,
        usageScope: "cumulative-delta",
      });
    }
  }

  effectiveEvents.sort(
    (a, b) => a.timestampMs - b.timestampMs || a.identity.localeCompare(b.identity, "en"),
  );
  const hasCumulative = cumulativeSnapshots > 0;
  const hasPerEvent = ordered.some((event) => event.usageScope !== USAGE_SCOPE_CUMULATIVE);
  const mode = ambiguousEvents > 0
    ? USAGE_SCOPE_AMBIGUOUS
    : hasCumulative && hasPerEvent
      ? "mixed"
      : hasCumulative
        ? "cumulative-delta"
        : USAGE_SCOPE_PER_EVENT;
  return {
    events: effectiveEvents,
    diagnostics: {
      mode,
      confidence: ambiguousEvents > 0 ? USAGE_SCOPE_AMBIGUOUS : "observed",
      sessions: sessionIds.size,
      observed_events: ordered.length,
      cumulative_snapshots: cumulativeSnapshots,
      cumulative_events_counted: cumulativeEventsCounted,
      cumulative_unchanged: cumulativeUnchanged,
      cumulative_resets: cumulativeResets,
      ambiguous_events: ambiguousEvents,
    },
  };
}

function buildTokenUsage(events, scanStats = null) {
  const aggregation = aggregateSessionUsage(events);
  const effectiveEvents = aggregation.events;
  const totals = emptyUsageTotals();
  const byModel = new Map();
  for (const event of effectiveEvents) {
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
    messages: effectiveEvents.length,
    observed_events: events.length,
    models,
    estimated_cost_usd: estimatedCost,
    estimated_cost_status: priced.length === 0
      ? "unavailable"
      : priced.length === models.length ? "complete" : "partial",
    aggregation: aggregation.diagnostics,
    ...(scanStats ? { scan_stats: scanStats } : {}),
  };
}

async function statAgentFile(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: Number(stat.ino) || 0,
      dev: Number(stat.dev) || 0,
    };
  } catch (_e) {
    return null;
  }
}

function cacheEntryMatchesStat(entry, stat) {
  return Boolean(entry
    && Number(entry.size) === stat.size
    && Number(entry.mtimeMs) === stat.mtimeMs
    && Number(entry.ino) === stat.ino
    && Number(entry.dev) === stat.dev
    && Array.isArray(entry.events));
}

function cacheEntryEvents(entry) {
  if (!Array.isArray(entry?.events)) return new Map();
  const events = new Map();
  for (const value of entry.events) {
    if (!value || typeof value !== "object" || typeof value.identity !== "string") continue;
    const usage = normalizeClaudeDesktopUsage(value.usage);
    if (!usage || typeof value.model !== "string" || !Number.isFinite(value.timestampMs)) continue;
    const candidate = {
      identity: value.identity,
      model: value.model,
      usage,
      timestampMs: value.timestampMs,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      usageScope: value.usageScope === USAGE_SCOPE_CUMULATIVE
        ? USAGE_SCOPE_CUMULATIVE
        : value.usageScope === USAGE_SCOPE_AMBIGUOUS
          ? USAGE_SCOPE_AMBIGUOUS
          : USAGE_SCOPE_PER_EVENT,
    };
    events.set(value.identity, chooseUsageEvent(events.get(value.identity), candidate));
  }
  return events;
}

function parseAgentUsageBuffer(raw, {
  baseOffset = 0,
  lineCount = 0,
  previousEvents = new Map(),
  fallbackMs = null,
  nowMs,
} = {}) {
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  const events = new Map(previousEvents);
  let usageRecords = 0;
  let duplicateRecords = 0;
  let completedLines = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const terminated = index < lines.length - 1;
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.trim()) {
      let record;
      try {
        record = JSON.parse(line);
      } catch (_e) {
        record = null;
      }
      const parts = usageEventParts(record);
      const usage = normalizeClaudeDesktopUsage(parts.usage);
      if (usage) {
        usageRecords += 1;
        const timestampMs = safeObservedTimestamp([
          record.timestamp,
          record.created_at,
          record.time,
          record.message?.created_at,
          parts.event?.timestamp,
          parts.event?.time,
        ], fallbackMs, nowMs);
        const identity = eventIdentityDigest(usageEventIdentity(parts, usage, timestampMs));
        const candidate = {
          identity,
          model: parts.model,
          usage,
          timestampMs,
          sessionId: parts.sessionId,
          usageScope: parts.usageScope,
        };
        const previous = events.get(identity);
        const selected = chooseUsageEvent(previous, candidate);
        if (previous) duplicateRecords += 1;
        events.set(identity, selected);
      }
    }
    if (terminated) completedLines += 1;
  }

  const lastNewline = raw.lastIndexOf(0x0a);
  return {
    events,
    usageRecords,
    duplicateRecords,
    lineCount: lineCount + completedLines,
    completeOffset: baseOffset + (lastNewline >= 0 ? lastNewline + 1 : 0),
  };
}

async function readClaudeDesktopAgentUsage(root, {
  nowMs = Date.now(),
  cachePath = null,
} = {}) {
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

  const cache = await readAgentUsageCache(cachePath);
  const nextCacheFiles = {};
  const events = new Map();
  let latestFileMs = 0;
  let bytesRead = 0;
  const scanStats = {
    files_discovered: files.length,
    files_scanned: 0,
    files_reused: 0,
    files_incremental: 0,
    files_reparsed: 0,
    bytes_read: 0,
    cached_events_reused: 0,
    usage_events_seen: 0,
    usage_events_deduplicated: 0,
    cache_enabled: Boolean(cachePath),
  };

  const addFileEvents = (fileEvents) => {
    for (const [identity, event] of fileEvents.entries()) {
      const previous = events.get(identity);
      if (previous) scanStats.usage_events_deduplicated += 1;
      events.set(identity, chooseUsageEvent(previous, event));
    }
  };

  for (const filePath of files) {
    if (bytesRead >= AGENT_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const stat = await statAgentFile(filePath);
    if (!stat) continue;
    latestFileMs = Math.max(latestFileMs, Number(stat.mtimeMs) || 0);
    const previous = cache.files?.[filePath];

    if (cacheEntryMatchesStat(previous, stat)) {
      const cachedEvents = cacheEntryEvents(previous);
      nextCacheFiles[filePath] = previous;
      scanStats.files_reused += 1;
      scanStats.cached_events_reused += cachedEvents.size;
      addFileEvents(cachedEvents);
      continue;
    }

    const previousEvents = cacheEntryEvents(previous);
    const sameFile = previous
      && Number(previous.ino) === stat.ino
      && Number(previous.dev) === stat.dev
      && stat.size >= Number(previous.size)
      && Number(previous.completeOffset) >= 0
      && Number(previous.completeOffset) <= stat.size
      && Array.isArray(previous.events);
    const startOffset = sameFile ? Number(previous.completeOffset) : 0;
    const remainingBytes = AGENT_MAX_TOTAL_BYTES - bytesRead;
    const content = await readBoundedBytes(
      filePath,
      startOffset,
      Math.min(AGENT_JSONL_MAX_BYTES, remainingBytes),
    );
    if (!content) continue;
    if (content.skipped) {
      truncated = true;
      break;
    }
    const contentBytes = content.bytes;
    if (bytesRead + contentBytes > AGENT_MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    bytesRead += contentBytes;
    const parsed = parseAgentUsageBuffer(content.raw, {
      baseOffset: content.startOffset,
      lineCount: sameFile ? Number(previous.lineCount) || 0 : 0,
      previousEvents: sameFile ? previousEvents : new Map(),
      fallbackMs: sameFile
        ? Number(previous.identityFallbackMs) || Number(content.mtimeMs) || nowMs
        : Number(content.mtimeMs) || nowMs,
      nowMs,
    });
    const entry = {
      size: content.size,
      mtimeMs: content.mtimeMs,
      ino: content.ino,
      dev: content.dev,
      completeOffset: parsed.completeOffset,
      lineCount: parsed.lineCount,
      identityFallbackMs: sameFile
        ? Number(previous.identityFallbackMs) || Number(content.mtimeMs) || nowMs
        : Number(content.mtimeMs) || nowMs,
      events: Array.from(parsed.events.values()),
    };
    nextCacheFiles[filePath] = entry;
    scanStats.files_scanned += 1;
    if (sameFile) scanStats.files_incremental += 1;
    else scanStats.files_reparsed += 1;
    scanStats.bytes_read += contentBytes;
    scanStats.usage_events_seen += parsed.usageRecords;
    scanStats.usage_events_deduplicated += parsed.duplicateRecords;
    addFileEvents(parsed.events);
  }

  await writeAgentUsageCache(cachePath, nextCacheFiles);

  const orderedEvents = Array.from(events.values())
    .sort((a, b) => a.timestampMs - b.timestampMs || a.identity.localeCompare(b.identity, "en"));
  const latestEventMs = orderedEvents.reduce((latest, event) => Math.max(latest, event.timestampMs), 0);
  const capturedAtMs = latestEventMs || latestFileMs || nowMs;
  return {
    detected: files.length > 0,
    session_files: files.length,
    truncated,
    usage_events: orderedEvents.length,
    captured_at: new Date(capturedAtMs).toISOString(),
    scan_stats: scanStats,
    token_usage: orderedEvents.length > 0 ? buildTokenUsage(orderedEvents, scanStats) : null,
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
      readClaudeDesktopAgentUsage(root, {
        nowMs,
        cachePath: usageCachePath(home, root),
      }),
    ]);
    const limits = normalizeClaudeDesktopHistory(history, { nowMs });
    if (!limits && !tokenUsage.detected) return null;
    const metadata = profileMetadata(root, { home, env, platform });
    const displayName = names?.[metadata.profile_id];
    const tokenUsageStatus = tokenUsage.token_usage
      ? tokenUsage.truncated ? "partial" : "observed"
      : tokenUsage.truncated ? "partial" : "unavailable";
    const tokenFields = {
      token_usage_status: tokenUsageStatus,
      token_usage_unavailable_reason: tokenUsage.token_usage ? null
        : tokenUsage.session_files === 0 ? "no-local-usage-files" : "no-usage-counters",
      token_usage_source: TOKEN_USAGE_SOURCE,
      token_usage_files: tokenUsage.session_files,
      token_usage_truncated: tokenUsage.truncated,
      token_usage_captured_at: tokenUsage.detected ? tokenUsage.captured_at : null,
      token_usage: tokenUsage.token_usage,
      token_usage_provenance: {
        source: TOKEN_USAGE_SOURCE,
        confidence: tokenUsageStatus,
        captured_at: tokenUsage.detected ? tokenUsage.captured_at : null,
        session_files: tokenUsage.session_files,
        scan_stats: tokenUsage.scan_stats,
        aggregation: tokenUsage.token_usage?.aggregation || null,
      },
    };
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
