"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
let DatabaseSync = null;
try { ({ DatabaseSync } = require("node:sqlite")); } catch (_e) { }
const available = Boolean(DatabaseSync) ||
  cp.spawnSync("sqlite3", ["-version"], { encoding: "utf8", windowsHide: true }).status === 0;

function executeSql(dbPath, sql) {
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else cp.execFileSync("sqlite3", [dbPath, sql]);
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createPiDesktopDb(home) {
  const dbPath = path.join(home, ".pi-desktop", "pi.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  executeSql(dbPath, `
    CREATE TABLE turns (
      id TEXT PRIMARY KEY, session_id TEXT, status TEXT, model_id TEXT,
      provider_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      usage_json TEXT, started_at INTEGER, ended_at INTEGER, error_code TEXT
    );
    CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT);
    CREATE TABLE messages (id TEXT, body TEXT);
    INSERT INTO sessions VALUES ('session-1', 'PRIVATE TITLE', '/PRIVATE/WORKSPACE');
    INSERT INTO messages VALUES ('message-1', 'PRIVATE PROMPT AND RESPONSE');
  `);
  return dbPath;
}

function insertTurn(dbPath, {
  id = "turn-1", session = "session-1", status = "completed", model = "gpt-5.4",
  input = 100, output = 20, cache = 300, reasoning = 7, creation = 0,
  startedAt = Date.parse("2026-09-30T10:03:00Z"), rawUsage,
} = {}) {
  const usage = rawUsage === undefined ? JSON.stringify({
    inputTokens: input, outputTokens: output, cacheReadTokens: cache,
    cacheCreationTokens: creation, reasoningTokens: reasoning,
    totalTokens: input + output + cache + creation,
    private: "PRIVATE USAGE PAYLOAD",
  }) : rawUsage;
  executeSql(dbPath, `INSERT INTO turns VALUES (
    ${quote(id)}, ${quote(session)}, ${quote(status)}, ${quote(model)}, 'openai',
    ${Number(input)}, ${Number(output)}, ${quote(usage)}, ${startedAt},
    ${status === "running" ? "NULL" : startedAt + 1000}, 'PRIVATE ERROR'
  );`);
}

module.exports = { available, DatabaseSync, createPiDesktopDb, executeSql, insertTurn, quote };
