const LOGIN_PATH_PATTERN = /(?:^|\/)login(?:\/|$)|\/login\/auth(?:\/|$)/i;
const COURSE_PATH_PATTERN = /\/v\d+\/course\/|\/course\/(?:alive|video|detail)\//i;
const LOGIN_TEXT_PATTERN = /微信.{0,8}(?:扫码|登录)|(?:扫码|登录).{0,8}微信|请先登录|登录后(?:继续|观看)/i;

function normalizePageSnapshot(snapshot = {}) {
  return {
    url: String(snapshot.url || ''),
    text: String(snapshot.text || '').replace(/\s+/g, ' ').trim(),
    hasVideo: Boolean(snapshot.hasVideo)
  };
}

function isLoginPage(snapshot) {
  const page = normalizePageSnapshot(snapshot);
  let pathname = '';
  try {
    pathname = new URL(page.url).pathname;
  } catch {}
  return LOGIN_PATH_PATTERN.test(pathname) || LOGIN_TEXT_PATTERN.test(page.text);
}

function isAuthenticatedCoursePage(snapshot) {
  const page = normalizePageSnapshot(snapshot);
  if (isLoginPage(page)) return false;
  let pathname = '';
  try {
    pathname = new URL(page.url).pathname;
  } catch {
    return false;
  }
  return page.hasVideo || COURSE_PATH_PATTERN.test(pathname);
}

module.exports = { isAuthenticatedCoursePage, isLoginPage, normalizePageSnapshot };
