const GITHUB_REPOSITORY = 'cheng-yi-cc/Xiaoe-Transcriber';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`;
const INSTALLER_ASSET_PATTERN = /Setup.*\.exe$/i;

function normalizeVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(text)) return null;
  return text.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function findInstallerAsset(release) {
  return (release?.assets || []).find(
    (asset) => !asset.draft && INSTALLER_ASSET_PATTERN.test(asset.name) && Number.isFinite(asset.size) && asset.size > 0
  ) || null;
}

function describeUpdate({ currentVersion, release }) {
  if (!release || release.draft || release.prerelease) {
    return { available: false, currentVersion };
  }
  const latestVersion = String(release.tag_name || '').trim();
  if (!normalizeVersion(latestVersion)) return { available: false, currentVersion };
  const asset = findInstallerAsset(release);
  if (!asset || compareVersions(latestVersion, currentVersion) <= 0) {
    return { available: false, currentVersion, latestVersion };
  }
  return {
    available: true,
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url,
    releaseName: release.name || latestVersion,
    publishedAt: release.published_at,
    asset: {
      id: asset.id,
      name: asset.name,
      size: asset.size,
      downloadUrl: asset.browser_download_url
    }
  };
}

async function checkForUpdate({ currentVersion, fetchImpl }) {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Xiaoe-Transcriber-Update-Check'
    }
  });
  if (!response.ok) throw new Error(`GitHub 返回了 ${response.status}，暂时无法检查更新。`);
  const release = await response.json();
  return describeUpdate({ currentVersion, release });
}

module.exports = {
  GITHUB_REPOSITORY,
  LATEST_RELEASE_URL,
  checkForUpdate,
  compareVersions,
  describeUpdate,
  findInstallerAsset,
  normalizeVersion
};
