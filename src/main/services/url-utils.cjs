const ALLOWED_HOST_SUFFIXES = [
  'xetslk.com',
  'xet.tech',
  'xiaoeknow.com',
  'pomoho.com'
];

function isAllowedXiaoeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function tryDecode(value, times = 3) {
  let current = String(value || '');
  for (let index = 0; index < times; index += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function extractM3u8Candidates(requestUrl) {
  const candidates = new Set();
  const decoded = tryDecode(requestUrl);
  const directMatches = decoded.match(/https?:\/\/[^\s"'<>]+?\.m3u8(?:\?[^\s"'<>]*)?/gi) || [];
  for (const match of directMatches) candidates.add(match.replace(/[),\]}]+$/, ''));

  try {
    const url = new URL(requestUrl);
    if (/\.m3u8$/i.test(url.pathname)) candidates.add(url.href);
    for (const [key, value] of url.searchParams.entries()) {
      if (/play_?url|media_?url|video_?url/i.test(key) || /m3u8/i.test(value)) {
        const candidate = tryDecode(value);
        if (/^https?:\/\//i.test(candidate) && /\.m3u8(?:\?|$)/i.test(candidate)) {
          candidates.add(candidate);
        }
      }
    }
  } catch {
    // Network observers sometimes receive partially encoded URLs; regex extraction above still works.
  }

  return [...candidates].filter(isSafeMediaUrl);
}

function isSafeMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
    if (/^(?:0|10|127|169\.254|192\.168)\./.test(host)) return false;
    const private172 = /^172\.(\d{1,2})\./.exec(host);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

function redactSensitiveUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

module.exports = {
  ALLOWED_HOST_SUFFIXES,
  extractM3u8Candidates,
  isAllowedXiaoeUrl,
  isSafeMediaUrl,
  redactSensitiveUrl,
  tryDecode
};
