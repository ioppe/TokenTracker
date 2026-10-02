"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(t, { background = true, failure = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dmg-ci-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "project", "scripts");
  const bin = path.join(root, "bin");
  const app = path.join(root, "app with spaces", "TokenTracker.app");
  const record = path.join(root, "record.json");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "marker"), "app-payload");
  fs.copyFileSync(path.join(__dirname, "..", "TokenTrackerBar", "scripts", "create-dmg.sh"),
    path.join(scripts, "create-dmg.sh"));
  if (background) fs.writeFileSync(path.join(scripts, "dmg-background.png"), "background-fixture");
  fs.writeFileSync(path.join(bin, "create-dmg"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const source = args.at(-1);
const output = args.at(-2);
const payload = fs.readFileSync(path.join(source, "TokenTracker.app", "Contents", "marker"), "utf8");
const entries = fs.readdirSync(source);
fs.writeFileSync(process.env.CAPTURE_JSON, JSON.stringify({ args, source, output, payload, entries }));
if (Number(process.env.FAILURE_CODE)) process.exit(Number(process.env.FAILURE_CODE));
fs.writeFileSync(output, "disk-image-fixture");
`, { mode: 0o755 });
  for (const command of ["hdiutil", "osascript"]) {
    fs.writeFileSync(path.join(bin, command), "#!/bin/sh\necho Unexpected local packaging command >&2\nexit 90\n", { mode: 0o755 });
  }
  return {
    root, record,
    run: () => spawnSync("bash", [path.join(scripts, "create-dmg.sh"), app], {
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        CI: "true", CAPTURE_JSON: record, FAILURE_CODE: String(failure) },
      encoding: "utf8", timeout: 30_000,
    }),
  };
}

for (const background of [true, false]) {
  test(`CI packages a containing directory and preserves layout (background=${background})`,
    { skip: process.platform === "win32" }, (t) => {
      const f = fixture(t, { background });
      const result = f.run();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const record = JSON.parse(fs.readFileSync(f.record, "utf8"));
      assert.equal(record.payload, "app-payload");
      assert.deepEqual(record.entries, ["TokenTracker.app"]);
      assert.ok(record.args.includes("--app-drop-link"));
      assert.ok(record.args.includes("--icon"));
      assert.equal(record.args.includes("--background"), background);
      assert.ok(!record.args.includes("--skip-jenkins"));
      assert.ok(!record.args.includes("--sandbox-safe"));
      assert.equal(fs.existsSync(record.source), false, "staging is cleaned after success");
      assert.equal(fs.readFileSync(record.output, "utf8"), "disk-image-fixture");
      assert.ok(!result.stdout.includes("Creating temporary DMG"));
    });
}

test("CI propagates packaging failures without a fake successful output", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t, { failure: 64 });
  const result = f.run();
  assert.equal(result.status, 64, result.stdout + result.stderr);
  const record = JSON.parse(fs.readFileSync(f.record, "utf8"));
  assert.equal(fs.existsSync(record.source), false, "staging is cleaned after failure");
  assert.equal(fs.existsSync(record.output), false);
  assert.ok(!result.stdout.includes("DMG created successfully"));
});
