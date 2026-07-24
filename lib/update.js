const GITHUB_REPO = 'VG-IT/ebay-tracking-collector';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function parseVersion(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(cleaned)) return null;
  return cleaned.split('.').map((part) => Number(part));
}

/** Returns true if `remote` is strictly newer than `local`. */
export function isNewerVersion(local, remote) {
  const a = parseVersion(local);
  const b = parseVersion(remote);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

export function getInstalledVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

export async function checkForUpdate() {
  const localVersion = getInstalledVersion();

  const response = await fetch(RELEASES_LATEST_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub release check failed: HTTP ${response.status}`);
  }

  const release = await response.json();
  const remoteVersion = String(release.tag_name || '').replace(/^v/i, '');
  if (!isNewerVersion(localVersion, remoteVersion)) return null;

  const zipAsset =
    (release.assets || []).find((asset) =>
      String(asset.name || '').endsWith(
        `ebay-tracking-collector-${remoteVersion}.zip`,
      ),
    ) ||
    (release.assets || []).find((asset) =>
      String(asset.name || '').endsWith('.zip'),
    );

  return {
    version: remoteVersion,
    zipUrl: zipAsset?.browser_download_url || null,
    htmlUrl:
      release.html_url ||
      `https://github.com/${GITHUB_REPO}/releases/latest`,
    notes: String(release.body || '').trim(),
  };
}
