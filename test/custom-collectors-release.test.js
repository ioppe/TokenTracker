"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildMetadata, validateBundledCollectors, stampApp, releaseManifest } = require("../scripts/custom-collectors-release.cjs");

const env = {
  GITHUB_REPOSITORY: "ioppe/TokenTracker", CUSTOM_SOURCE_SHA: "a".repeat(40),
  GITHUB_RUN_NUMBER: "13", GITHUB_RUN_ATTEMPT: "1",
};

function fixture(t) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "tt-custom-app-"));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const embedded = path.join(app, "Contents", "Resources", "EmbeddedServer", "tokentracker");
  const lib = path.join(embedded, "src", "lib");
  const assets = path.join(embedded, "dashboard", "dist", "assets");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(lib, "claude-desktop.js"), "module.exports = {};");
  fs.writeFileSync(path.join(lib, "claude-desktop-limits.js"), "module.exports = {};");
  fs.writeFileSync(path.join(lib, "usage-limits.js"), 'require("./claude-desktop-limits");');
  fs.writeFileSync(path.join(assets, "index.js"), 'copy("usage.claude_desktop.local_scope");');
  return { app, lib, assets };
}

test("custom build identity requires a repository, source SHA and CI build number", () => {
  const data = buildMetadata(env, "1.1.9");
  assert.equal(data.channel, "custom-collectors");
  assert.equal(data.version, "1.1.9");
  assert.equal(data.build_number, 13);
  assert.throws(() => buildMetadata({ ...env, GITHUB_REPOSITORY: "../bad" }, "1.1.9"));
  assert.throws(() => buildMetadata({ ...env, CUSTOM_SOURCE_SHA: "" }, "1.1.9"));
  assert.throws(() => buildMetadata({ ...env, GITHUB_RUN_NUMBER: "0" }, "1.1.9"));
});

test("custom package validation rejects an official or stale embedded payload", (t) => {
  const f = fixture(t);
  validateBundledCollectors(f.app);
  fs.writeFileSync(path.join(f.lib, "usage-limits.js"), "module.exports = {};");
  assert.throws(() => validateBundledCollectors(f.app), /does not load/);
  fs.writeFileSync(path.join(f.lib, "usage-limits.js"), 'require("./claude-desktop-limits");');
  fs.writeFileSync(path.join(f.assets, "index.js"), "old dashboard");
  assert.throws(() => validateBundledCollectors(f.app), /missing Claude Desktop/);
});

test("custom app stamping preserves the stable platform version and pins the fork feed", (t) => {
  const f = fixture(t);
  const commands = [];
  stampApp(f.app, buildMetadata(env, "1.1.9"), (_command, args) => {
    commands.push(args[1]);
    return "1.1.9\n";
  });
  assert.ok(commands.includes("Add :TTUpdateChannel string custom-collectors"));
  assert.ok(commands.includes("Add :TTUpdateRepository string ioppe/TokenTracker"));
  assert.ok(commands.includes("Add :TTUpdateBuildNumber string 13"));
  assert.ok(!commands.some((command) => command.startsWith("Add :CFBundleShortVersionString")));
  assert.throws(() => stampApp(f.app, buildMetadata(env, "1.1.9"), () => "1.1.8"), /App version/);
});

test("release manifest binds the custom build to the exact DMG bytes", async (t) => {
  const f = fixture(t);
  const dmg = path.join(f.app, "test.dmg");
  fs.writeFileSync(dmg, "custom collectors dmg");
  const result = await releaseManifest(buildMetadata(env, "1.1.9"), dmg);
  assert.equal(result.dmg_sha256, crypto.createHash("sha256").update("custom collectors dmg").digest("hex"));
  assert.equal(result.source_sha, env.CUSTOM_SOURCE_SHA);
  const appZip = path.join(f.app, "app.zip");
  fs.writeFileSync(appZip, "signed custom app zip");
  const zipResult = await releaseManifest(buildMetadata(env, "1.1.9"), dmg, appZip);
  assert.equal(zipResult.app_zip_sha256, crypto.createHash("sha256").update("signed custom app zip").digest("hex"));
});
