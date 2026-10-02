const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const WORKFLOW_PATH = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "upstream-sync-nightly-dmg.yml"
);

function loadWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, "utf8");
}

test("nightly workflow file exists", () => {
  assert.ok(fs.existsSync(WORKFLOW_PATH));
});

test("nightly workflow supports scheduled and manual upstream sync", () => {
  const content = loadWorkflow();
  assert.match(content, /schedule:/);
  assert.match(content, /cron:\s*["']15 3 \* \* \*["']/);
  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /UPSTREAM_REPOSITORY:\s*xiufengsun\/TokenTracker/);
  assert.match(content, /git remote add upstream/);
  assert.match(content, /git fetch --no-tags --prune upstream/);
  assert.match(content, /git merge --no-edit "upstream\/\$\{UPSTREAM_REF\}"/);
});

test("upstream conflicts stop before pushing the fork branch", () => {
  const content = loadWorkflow();
  assert.match(content, /git diff --name-only --diff-filter=U/);
  assert.match(content, /git merge --abort/);
  assert.match(content, /Upstream merge conflict/);
  assert.match(content, /git push origin "HEAD:\$\{TARGET_BRANCH\}"/);
});

test("nightly workflow builds a macOS DMG and publishes a rolling release", () => {
  const content = loadWorkflow();
  assert.match(content, /runs-on:\s*macos-26/);
  assert.match(content, /npm run dashboard:build/);
  assert.match(content, /bundle-node\.sh/);
  assert.match(content, /xcodegen generate/);
  assert.match(content, /xcodebuild/);
  assert.match(content, /scripts\/create-dmg\.sh/);
  assert.match(content, /actions\/upload-artifact@v4/);
  assert.match(content, /actions\/download-artifact@v4/);
  assert.match(content, /retention-days:\s*14/);
  assert.match(content, /publish-nightly:/);
  assert.match(content, /tag="nightly"/);
  assert.match(content, /gh release create/);
  assert.match(content, /gh release upload/);
  assert.match(content, /--clobber/);
  assert.match(content, /--prerelease/);
  assert.match(content, /needs:\s*\[sync, build\]/);
});

test("scheduled runs skip redundant builds while manual runs can rebuild", () => {
  const content = loadWorkflow();
  assert.match(
    content,
    /github\.event_name == 'workflow_dispatch' \|\| needs\.sync\.outputs\.changed == 'true'/
  );
});

test("manual build-only mode skips upstream fetch, merge and release publication", () => {
  const content = loadWorkflow();
  assert.match(content, /build_only:[\s\S]*?default: false[\s\S]*?type: boolean/);
  assert.match(content, /BUILD_ONLY: \$\{\{ \(github\.event_name == 'push' \|\| inputs\.build_only\) && 'true' \|\| 'false' \}\}/);
  assert.match(content, /name: Fetch upstream\s+if: \$\{\{ github\.event_name != 'push' && !inputs\.build_only \}\}/);
  assert.match(content, /if \[\[ "\$\{BUILD_ONLY\}" == "true" \]\]; then[\s\S]*?else\s+if ! git merge/);
  assert.match(content, /if: \$\{\{ needs\.build\.result == 'success' && github\.event_name != 'push' && !inputs\.build_only \}\}/);
});

test("custom collector pushes build artifacts without merging or publishing", () => {
  const content = loadWorkflow();
  assert.match(content, /push:\s+branches: \[custom-collectors\]/);
  assert.match(content, /ref: \$\{\{ github\.event_name == 'push' && github\.sha \|\| env\.TARGET_BRANCH \}\}/);
  assert.match(content, /paths:[\s\S]*?- "src\/\*\*"[\s\S]*?- "dashboard\/\*\*"/);
  assert.match(content, /if: \$\{\{ github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'/);
});

test("nightly builds verify desktop snapshots and native reset isolation", () => {
  const content = loadWorkflow();
  assert.match(content, /node-version: 24/);
  assert.match(content, /node --test test\/claude-desktop-limits\.test\.js/);
  assert.match(content, /UsageLimitsPanel\.test\.jsx/);
  assert.match(content, /npm --prefix dashboard run typecheck/);
  assert.match(content, /-only-testing:TokenTrackerBarTests\/UsageLimitsRetentionTests/);
  assert.match(content, /-only-testing:TokenTrackerBarTests\/WeeklyLimitResetDetectorTests/);
});
