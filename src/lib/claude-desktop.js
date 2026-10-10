"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function expand(value, home) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  return path.resolve(home, raw === "~" ? "" : raw.startsWith("~/") ? raw.slice(2) : raw);
}

function claudeDesktopDefaultRoot({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  return platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude")
    : platform === "win32"
      ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude")
      : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
}

// Discovery uses only known profile roots, never process arguments or auth files.
// Numbered .claudeN directories are the isolated user-data-dir convention
// used by account launchers such as CodexQuotaViewer.
function discoverClaudeDesktopProfiles({
  home = os.homedir(), env = process.env, config = null,
  platform = process.platform, deps = {},
} = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const statSync = deps.statSync || fs.statSync;
  const realpathSync = deps.realpathSync || fs.realpathSync;
  const defaultRoot = claudeDesktopDefaultRoot({ home, env, platform });
  const candidates = [defaultRoot, expand(env.TOKENTRACKER_CLAUDE_DESKTOP_HOME, home)];
  try {
    const entries = readdirSync(home, { withFileTypes: true });
    candidates.push(...entries
      .filter((entry) => entry.isDirectory() && /^\.claude[1-9]\d*$/.test(entry.name))
      .map((entry) => path.join(home, entry.name))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  } catch (_e) { /* An unreadable home must not stop other collectors. */ }

  // Explicit Claude scan roots can also point to an Electron profile. Admit
  // them as desktop roots only when they contain one of the known session
  // directories. This covers ordinary Code sessions and Cowork/Agent data.
  const configured = config?.scanRoots?.claude;
  const explicit = [env.CLAUDE_CONFIG_DIR,
    ...(Array.isArray(configured) ? configured : [configured])];
  for (const value of explicit) {
    const root = expand(value, home);
    if (!root) continue;
    try {
      const hasKnownSessionDir = ["claude-code-sessions", "local-agent-mode-sessions", "projects"]
        .some((name) => {
          try {
            return statSync(path.join(root, name)).isDirectory();
          } catch (_e) {
            return false;
          }
        });
      if (hasKnownSessionDir) {
        candidates.push(root);
      }
    } catch (_e) { }
  }

  const seen = new Set();
  const profiles = [];
  for (const root of candidates) {
    if (!root) continue;
    try {
      if (!statSync(root).isDirectory()) continue;
      const real = realpathSync(root);
      if (seen.has(real)) continue;
      seen.add(real);
      profiles.push(root);
    } catch (_e) { }
  }
  return profiles;
}

function claudeDesktopTranscriptDirs(profiles) {
  // Do NOT walk local-agent-mode-sessions/Cowork workspaces, Electron caches
  // or quota history: none is a reliable per-message token source.
  return profiles.flatMap((root) => [
    path.join(root, "projects"),
    path.join(root, "claude-code-sessions"),
  ]);
}

function claudeDesktopAgentSessionDirs(profiles) {
  // This list is intentionally separate from claudeDesktopTranscriptDirs().
  // The legacy sync collector treats Cowork workspaces as unrelated to the
  // background token queue; usage-limits needs them only for local usage data.
  return profiles.flatMap((root) => [
    path.join(root, "projects"),
    path.join(root, "claude-code-sessions"),
    path.join(root, "local-agent-mode-sessions"),
  ]);
}

module.exports = {
  claudeDesktopDefaultRoot,
  discoverClaudeDesktopProfiles,
  claudeDesktopTranscriptDirs,
  claudeDesktopAgentSessionDirs,
};
