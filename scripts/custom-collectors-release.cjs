"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { assertReleaseVersion } = require("./version-files.cjs");

function buildMetadata(env, version) {
  assertReleaseVersion(version, "Custom build version");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(env.GITHUB_REPOSITORY || "")) {
    throw new Error("Missing or invalid custom update repository");
  }
  if (!/^[a-f0-9]{40}$/.test(env.CUSTOM_SOURCE_SHA || "")) throw new Error("Missing custom source SHA");
  const build = Number(env.GITHUB_RUN_NUMBER);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(build) || build <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) {
    throw new Error("Missing custom build identity");
  }
  return {
    version, channel: "custom-collectors", repository: env.GITHUB_REPOSITORY,
    source_sha: env.CUSTOM_SOURCE_SHA, build_number: build, build_attempt: attempt,
  };
}

function validateBundledCollectors(app) {
  const embedded = path.join(app, "Contents", "Resources", "EmbeddedServer", "tokentracker");
  for (const name of ["claude-desktop.js", "claude-desktop-limits.js"]) {
    if (!fs.statSync(path.join(embedded, "src", "lib", name)).isFile()) {
      throw new Error(`Missing bundled collector: ${name}`);
    }
  }
  const limits = fs.readFileSync(path.join(embedded, "src", "lib", "usage-limits.js"), "utf8");
  if (!limits.includes('require("./claude-desktop-limits")')) {
    throw new Error("Bundled limits API does not load the custom Claude Desktop collector");
  }
  const assets = path.join(embedded, "dashboard", "dist", "assets");
  const hasDesktopUI = fs.readdirSync(assets).filter((name) => name.endsWith(".js"))
    .some((name) => fs.readFileSync(path.join(assets, name), "utf8")
      .includes("usage.claude_desktop.local_scope"));
  if (!hasDesktopUI) throw new Error("Bundled dashboard is missing Claude Desktop collection status");
}

function stampApp(app, metadata, run = execFileSync) {
  validateBundledCollectors(app);
  const plist = path.join(app, "Contents", "Info.plist");
  const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8" }).trim();
  if (version !== metadata.version) throw new Error("App version does not match custom release version");
  const fields = {
    TTUpdateChannel: metadata.channel, TTUpdateRepository: metadata.repository,
    TTUpdateRevision: metadata.source_sha, TTUpdateBuildNumber: String(metadata.build_number),
    TTUpdateBuildAttempt: String(metadata.build_attempt),
  };
  for (const [key, value] of Object.entries(fields)) {
    try { run("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plist], { stdio: "pipe" }); } catch (_e) { }
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist], { stdio: "pipe" });
  }
}

async function releaseManifest(metadata, dmg) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(dmg)) hash.update(chunk);
  return { ...metadata, dmg_sha256: hash.digest("hex") };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { app: { type: "string" }, build: { type: "string" }, dmg: { type: "string" }, output: { type: "string" } },
  });
  let result;
  if (positionals[0] === "stamp" && values.app && values.output) {
    result = buildMetadata(process.env, require("../package.json").version);
    stampApp(values.app, result);
  } else if (positionals[0] === "manifest" && values.build && values.dmg && values.output) {
    result = await releaseManifest(JSON.parse(fs.readFileSync(values.build, "utf8")), values.dmg);
  } else {
    throw new Error("Use stamp --app <app> --output <json> or manifest --build <json> --dmg <dmg> --output <json>");
  }
  fs.writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Custom build metadata: ${values.output}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildMetadata, validateBundledCollectors, stampApp, releaseManifest };
