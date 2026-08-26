const LOGIN_PATH_PATTERN = /(?:^|\/)login(?:\/|$)|\/login\/auth(?:\/|$)/i;
const ACCOUNT_LOGIN_PATH_PATTERN = /\/(?:t_l\/learnLogin|studyLogin)(?:\/|$)/i;
const COURSE_PATH_PATTERN = /\/v\d+\/course\/|\/course\/(?:alive|video|detail)\//i;
const LOGIN_TEXT_PATTERN = /微信.{0,8}(?:扫码|登录)|(?:扫码|登录).{0,8}微信|请先登录|登录后(?:继续|观看)/i;
const INVALID_SHARE_PATH_PATTERN = /\/account-center\/common\/notFound(?:\/|$)/i;
const INVALID_SHARE_TEXT_PATTERN = /访问失败[，,]?请检查链接是否正确|分享链接(?:已失效|无效)|页面(?:不存在|已失效)/i;
const ACCOUNT_HOST = 'study.xiaoe-tech.com';

function normalizePageSnapshot(snapshot = {}) {
  return {
    url: String(snapshot.url || ''),
    text: String(snapshot.text || '').replace(/\s+/g, ' ').trim(),
    hasVideo: Boolean(snapshot.hasVideo),
    accountReady: Boolean(snapshot.accountReady)
  };
}

function isAccountLoginPage(snapshot) {
  const page = normalizePageSnapshot(snapshot);
  try {
    const url = new URL(page.url);
    if (url.hostname.toLowerCase() !== ACCOUNT_HOST) return false;
    return ACCOUNT_LOGIN_PATH_PATTERN.test(url.pathname)
      || /#\/(?:acount|account)(?:\/|$)/i.test(url.hash)
      || LOGIN_TEXT_PATTERN.test(page.text);
  } catch {
    return false;
  }
}

function isAuthenticatedAccountPage(snapshot) {
  const page = normalizePageSnapshot(snapshot);
  if (isAccountLoginPage(page)) return false;
  try {
    const url = new URL(page.url);
    if (url.hostname.toLowerCase() !== ACCOUNT_HOST) return false;
    return page.accountReady;
  } catch {
    return false;
  }
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

function isInvalidSharePage(snapshot) {
  const page = normalizePageSnapshot(snapshot);
  try {
    const url = new URL(page.url);
    return INVALID_SHARE_PATH_PATTERN.test(url.pathname) || INVALID_SHARE_TEXT_PATTERN.test(page.text);
  } catch {
    return INVALID_SHARE_TEXT_PATTERN.test(page.text);
  }
}

module.exports = {
  isAccountLoginPage,
  isAuthenticatedAccountPage,
  isAuthenticatedCoursePage,
  isInvalidSharePage,
  isLoginPage,
  normalizePageSnapshot
};
