const path = require('path');
const { assertReleaseVersion, syncCanonicalVersion } = require('./version-files.cjs');

const root = path.resolve(__dirname, '..');
const requestedVersion = process.argv[2];

if (!requestedVersion) {
  console.error('Usage: node scripts/align-release-version.cjs <x.y.z>');
  process.exitCode = 1;
} else {
  const version = assertReleaseVersion(requestedVersion, 'Upstream release version');
  const changed = syncCanonicalVersion(root, version);

  for (const label of changed) console.log(`Aligned ${label} to v${version}`);
  console.log(changed.length === 0
    ? `All release versions already match v${version}.`
    : `Aligned ${changed.length} release version file(s) to v${version}.`);
}
