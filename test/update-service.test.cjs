const assert = require('node:assert/strict');
const test = require('node:test');
const {
  LATEST_RELEASE_URL,
  checkForUpdate,
  compareVersions,
  describeUpdate,
  findInstallerAsset
} = require('../src/main/services/update-service.cjs');

test('compareVersions orders semver numbers numerically', () => {
  assert.equal(compareVersions('0.1.4', '0.1.10'), -1);
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
  assert.equal(compareVersions('0.1', '0.1.0'), 0);
});

function releasePayload(overrides = {}) {
  return {
    tag_name: 'v0.2.0',
    name: 'v0.2.0',
    html_url: 'https://github.com/cheng-yi-cc/Xiaoe-Transcriber/releases/tag/v0.2.0',
    published_at: '2026-08-26T00:00:00Z',
    assets: [
      { name: 'Xiaoe-Transcriber-Setup-0.2.0.exe', size: 104857600, browser_download_url: 'https://example.com/setup.exe' },
      { name: 'source.zip', size: 2048, browser_download_url: 'https://example.com/source.zip' }
    ],
    ...overrides
  };
}

test('describeUpdate reports a newer release with the installer asset', () => {
  const status = describeUpdate({ currentVersion: '0.1.4', release: releasePayload() });
  assert.equal(status.available, true);
  assert.equal(status.latestVersion, 'v0.2.0');
  assert.equal(status.currentVersion, '0.1.4');
  assert.equal(status.asset.name, 'Xiaoe-Transcriber-Setup-0.2.0.exe');
  assert.equal(status.asset.size, 104857600);
  assert.equal(status.releaseUrl, 'https://github.com/cheng-yi-cc/Xiaoe-Transcriber/releases/tag/v0.2.0');
});

test('describeUpdate ignores drafts, prereleases, same or older versions and releases without installers', () => {
  for (const overrides of [
    { draft: true },
    { prerelease: true },
    { tag_name: 'v0.1.3' },
    { assets: [{ name: 'source.zip', size: 10, browser_download_url: 'https://example.com/s.zip' }] }
  ]) {
    const status = describeUpdate({ currentVersion: '0.1.4', release: releasePayload(overrides) });
    assert.equal(status.available, false, JSON.stringify(overrides));
  }
});

test('checkForUpdate queries the latest GitHub release and maps the response', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => releasePayload() };
  };
  const status = await checkForUpdate({ currentVersion: '0.1.4', fetchImpl });
  assert.deepEqual(calls, [LATEST_RELEASE_URL]);
  assert.equal(status.available, true);
  await assert.rejects(
    checkForUpdate({ currentVersion: '0.1.4', fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /403/
  );
});
