const COURSE_HOST_SUFFIXES = [
  'xetslk.com',
  'xet.tech',
  'xiaoeknow.com',
  'pomoho.com'
];
const ACCOUNT_HOST = 'study.xiaoe-tech.com';
const GATEWAY_EXACT_HOSTS = new Set(['h5.xiaoecloud.com']);
const APP_XIAOE_TECH_HOST_PATTERN = /^app[a-z0-9]+\.(?:h5|pc)\.xiaoe-tech\.com$/i;

function parseHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function hostMatchesSuffix(host, suffixes) {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowedCourseUrl(value) {
  const url = parseHttpsUrl(value);
  return Boolean(url && hostMatchesSuffix(url.hostname.toLowerCase(), COURSE_HOST_SUFFIXES));
}

function isAllowedAccountUrl(value) {
  const url = parseHttpsUrl(value);
  return Boolean(url && url.hostname.toLowerCase() === ACCOUNT_HOST);
}

function isAllowedGatewayUrl(value) {
  const url = parseHttpsUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return GATEWAY_EXACT_HOSTS.has(host)
    || hostMatchesSuffix(host, COURSE_HOST_SUFFIXES)
    || APP_XIAOE_TECH_HOST_PATTERN.test(host);
}

function isAllowedXiaoeUrl(value) {
  return isAllowedAccountUrl(value) || isAllowedGatewayUrl(value);
}

function extractXiaoeCourseIdentity(value) {
  const url = parseHttpsUrl(value);
  if (!url || !isAllowedCourseUrl(url.href)) return null;
  const appMatch = /^((?:app)[a-z0-9]+)\./i.exec(url.hostname);
  const resourceMatch = /\/v\d+\/course\/(alive|video|detail)\/([^/?#]+)/i.exec(url.pathname);
  if (!appMatch || !resourceMatch) return null;
  return {
    appId: appMatch[1].toLowerCase(),
    resourceId: resourceMatch[2],
    resourceType: resourceMatch[1].toLowerCase(),
    resolvedUrl: url.href
  };
}

function isSameXiaoeCourse(value, identity) {
  const candidate = extractXiaoeCourseIdentity(value);
  return Boolean(
    candidate
    && identity
    && candidate.appId === String(identity.appId || '').toLowerCase()
    && candidate.resourceId === String(identity.resourceId || '')
  );
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
  ACCOUNT_HOST,
  ALLOWED_HOST_SUFFIXES: COURSE_HOST_SUFFIXES,
  COURSE_HOST_SUFFIXES,
  GATEWAY_EXACT_HOSTS,
  extractXiaoeCourseIdentity,
  extractM3u8Candidates,
  isAllowedAccountUrl,
  isAllowedCourseUrl,
  isAllowedGatewayUrl,
  isAllowedXiaoeUrl,
  isSameXiaoeCourse,
  isSafeMediaUrl,
  redactSensitiveUrl,
  tryDecode
};
