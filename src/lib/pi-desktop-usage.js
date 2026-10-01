"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { readSqliteJsonRowsAsync } = require("./sqlite-reader");

const PI_DESKTOP_SOURCE = "pi-desktop";

function resolvePiDesktopDbPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const override = env.TOKENTRACKER_PI_DESKTOP_DB;
  if (typeof override === "string" && override.trim()) {
    const value = override.trim();
    const relative = value === "~" ? "" : value.startsWith("~/") ? value.slice(2) : value;
    return path.resolve(home, relative);
  }
  return path.join(home, ".pi-desktop", "pi.sqlite");
}

// Select counters only. Never fetch messages, session titles, credentials or
// the complete usage_json blob (which may acquire unrelated fields later).
const PI_DESKTOP_USAGE_SQL = `
  WITH usage_rows AS (
    SELECT id, session_id, model_id, started_at, ended_at,
           input_tokens, output_tokens,
           CASE WHEN json_valid(usage_json) THEN usage_json ELSE '{}' END AS usage
    FROM turns
    WHERE lower(status) IN ('completed', 'aborted', 'error')
  )
  SELECT id, session_id, model_id, started_at, ended_at,
         input_tokens, output_tokens,
         json_extract(usage, '$.inputTokens') AS usage_input,
         json_extract(usage, '$.outputTokens') AS usage_output,
         json_extract(usage, '$.cacheReadTokens') AS cache_read,
         COALESCE(json_extract(usage, '$.cacheCreationTokens'),
                  json_extract(usage, '$.cacheWriteTokens')) AS cache_creation
  FROM usage_rows
  ORDER BY started_at, id
`;

async function readPiDesktopUsageRows(dbPath, sqliteOptions = {}) {
  return readSqliteJsonRowsAsync(dbPath, PI_DESKTOP_USAGE_SQL, {
    ...sqliteOptions,
    label: "PI Desktop",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    readOnly: true,
    throwOnReadFailure: true,
  });
}

function counter(value, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function timestamp(value) {
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 100_000_000_000 ? n * 1000 : n;
  return Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

function identity(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildPiDesktopUsageEvents(rows) {
  const events = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.id !== "string" || !row.id) continue;
    const tsMs = timestamp(row.started_at) || timestamp(row.ended_at);
    if (!tsMs) continue;
    const input = counter(row.usage_input, counter(row.input_tokens));
    const output = counter(row.usage_output, counter(row.output_tokens));
    const cached = counter(row.cache_read);
    const creation = counter(row.cache_creation);
    const total = input + output + cached + creation;
    if (!Number.isSafeInteger(total)) continue;
    events.push({
      requestId: identity(row.id),
      sessionId: identity(typeof row.session_id === "string" && row.session_id
        ? row.session_id : `turn:${row.id}`),
      model: typeof row.model_id === "string" && row.model_id.trim()
        ? row.model_id.trim() : "unknown",
      tsMs,
      totals: {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_creation_input_tokens: creation,
        output_tokens: output,
        // PI Desktop's outputTokens already includes reasoningTokens. Adding
        // that subset again would inflate both tokens and estimated cost.
        reasoning_output_tokens: 0,
        total_tokens: total,
        request_count: 1,
        conversation_count: 0,
      },
    });
  }
  return events;
}

module.exports = {
  PI_DESKTOP_SOURCE,
  buildPiDesktopUsageEvents,
  readPiDesktopUsageRows,
  resolvePiDesktopDbPath,
};
