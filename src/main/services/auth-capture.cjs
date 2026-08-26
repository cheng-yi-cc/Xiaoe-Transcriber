const { BrowserWindow, session } = require('electron');
const {
  isAccountLoginPage,
  isAuthenticatedAccountPage,
  isAuthenticatedCoursePage,
  isInvalidSharePage,
  isLoginPage
} = require('./auth-state.cjs');
const {
  ACCOUNT_HOME_URL,
  buildGatewayExchangeScript,
  gatewayFailureMessage,
  isStoreCookieDomain
} = require('./account-gateway.cjs');
const { inspectHls } = require('./hls-downloader.cjs');
const {
  extractM3u8Candidates,
  extractXiaoeCourseIdentity,
  isAllowedCourseUrl,
  isAllowedGatewayUrl,
  isAllowedXiaoeUrl,
  isSameXiaoeCourse
} = require('./url-utils.cjs');

const AUTH_PARTITION = 'persist:xiaoe-auth';
const REQUEST_FILTER = { urls: ['https://*/*'] };

function getAuthSession() {
  const authSession = session.fromPartition(AUTH_PARTITION);
  authSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  return authSession;
}

async function clearAuthSession() {
  const authSession = getAuthSession();
  await authSession.clearStorageData({
    storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
  });
  await authSession.clearCache();
}

async function clearCourseStoreSession(identity) {
  const authSession = getAuthSession();
  const cookies = await authSession.cookies.get({});
  const removals = cookies
    .filter((cookie) => isStoreCookieDomain(cookie.domain, identity.appId))
    .map((cookie) => {
      const scheme = cookie.secure ? 'https' : 'http';
      const host = String(cookie.domain || '').replace(/^\./, '');
      const cookiePath = String(cookie.path || '/').startsWith('/') ? cookie.path : '/';
      return authSession.cookies.remove(`${scheme}://${host}${cookiePath}`, cookie.name);
    });
  await Promise.all(removals);

  try {
    const origin = new URL(identity.resolvedUrl).origin;
    await authSession.clearStorageData({
      origin,
      storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage']
    });
  } catch {}
  await authSession.clearCache();
  await authSession.flushStorageData();
}

function readPageSnapshot(window) {
  if (window.isDestroyed()) {
    return Promise.resolve({ url: '', text: '', hasVideo: false, accountReady: false });
  }
  return window.webContents.executeJavaScript(`({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 5000),
    hasVideo: Boolean(document.querySelector('video')),
    accountReady: Boolean(document.querySelector('.index-wrapper, .my-participate-page'))
  })`, true);
}

function safeErrorDetail(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s)\]]+/gi, '[已隐藏地址]')
    .slice(0, 180);
}

function logAuthProbeLocation(label, window) {
  if (process.env.XIAOE_AUTH_PROBE_DIAGNOSTICS !== '1' || window.isDestroyed()) return;
  try {
    const url = new URL(window.webContents.getURL());
    console.log(`[授权诊断] ${label}: ${url.hostname}${url.pathname}`);
  } catch {
    console.log(`[授权诊断] ${label}: 无法识别当前页面`);
  }
}

async function logAuthProbeGatewayDocument(window) {
  if (process.env.XIAOE_AUTH_PROBE_DIAGNOSTICS !== '1' || window.isDestroyed()) return;
  try {
    const result = await window.webContents.executeJavaScript(`(() => {
      const raw = String(document.body?.innerText || '').trim();
      try {
        const parsed = JSON.parse(raw);
        return {
          kind: 'json',
          code: parsed?.code ?? null,
          message: String(parsed?.msg || parsed?.message || '').slice(0, 80)
        };
      } catch {
        return {
          kind: document.contentType || 'document',
          textLength: raw.length,
          scriptCount: document.scripts?.length || 0,
          hasMetaRefresh: Boolean(document.querySelector('meta[http-equiv="refresh" i]'))
        };
      }
    })()`, true);
    console.log(`[授权诊断] gateway 响应: ${JSON.stringify(result)}`);
  } catch {
    console.log('[授权诊断] gateway 响应: 无法读取');
  }
}

function createAuthWindow(parent, title, { modal = true, onAllowedOpen = null } = {}) {
  const window = new BrowserWindow({
    parent,
    modal,
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 620,
    show: false,
    title,
    backgroundColor: '#f4f6f3',
    autoHideMenuBar: true,
    webPreferences: {
      partition: AUTH_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  window.webContents.setAudioMuted(true);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedXiaoeUrl(url)) {
      if (onAllowedOpen) onAllowedOpen(url);
      else void window.loadURL(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedXiaoeUrl(url)) {
      if (process.env.XIAOE_AUTH_PROBE_DIAGNOSTICS === '1') {
        try {
          const blocked = new URL(url);
          console.log(`[授权诊断] 已拦截导航: ${blocked.hostname}${blocked.pathname}`);
        } catch {
          console.log('[授权诊断] 已拦截导航: 无法识别地址');
        }
      }
      event.preventDefault();
    }
  });
  return window;
}

function resolveCourseSource({ parent, sourceUrl, signal, onStatus }) {
  const direct = extractXiaoeCourseIdentity(sourceUrl);
  if (direct) return Promise.resolve({ ...direct, sourceUrl });

  return new Promise((resolve, reject) => {
    const window = createAuthWindow(parent, '正在解析小鹅通课程链接', { modal: false });
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!window.isDestroyed()) window.close();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));
    const inspectUrl = (url) => {
      if (isInvalidSharePage({ url })) {
        finish(new Error('分享链接无效，请重新复制最新的小鹅通课程链接。'));
        return;
      }
      const identity = extractXiaoeCourseIdentity(url);
      if (identity) finish(null, { ...identity, sourceUrl });
    };
    const inspectPage = async () => {
      if (settled || window.isDestroyed()) return;
      inspectUrl(window.webContents.getURL());
      if (settled || window.isDestroyed()) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isInvalidSharePage(snapshot)) {
          finish(new Error('分享链接无效，请重新复制最新的小鹅通课程链接。'));
        }
      } catch {}
    };

    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    window.on('closed', () => {
      if (!settled) finish(new Error('课程链接解析窗口已关闭。'));
    });
    window.webContents.on('will-redirect', (_event, url) => inspectUrl(url));
    window.webContents.on('did-navigate', (_event, url) => inspectUrl(url));
    window.webContents.on('did-navigate-in-page', (_event, url) => inspectUrl(url));
    window.webContents.on('did-finish-load', () => void inspectPage());
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) finish(new Error(`课程链接打开失败：${errorDescription}`));
    });

    onStatus({ message: '正在解析课程短链接…' });
    timeout = setTimeout(() => finish(new Error('无法从该链接识别店铺和课程，请确认它是小鹅通单视频或直播回放页。')), 30000);
    window.loadURL(sourceUrl).then(() => void inspectPage()).catch((error) => {
      finish(new Error(`课程链接打开失败：${safeErrorDetail(error)}`));
    });
  });
}

async function authorizeCourseStore({
  parent,
  identity,
  signal,
  onStatus,
  keepWindowOnSuccess = false
}) {
  return new Promise((resolve, reject) => {
    let phase = 'account';
    let manualFallback = false;
    let loginWasShown = false;
    let exchangeStarted = false;
    let retryUsed = false;
    let accountReadySince = 0;
    let targetReadySince = 0;
    let targetStartedAt = 0;
    let settled = false;
    let pollTimer = null;
    let initialTimer = null;
    let gatewayFinishTimer = null;
    let targetTimer = null;
    let lastStatusKey = '';

    const publishStatus = (event) => {
      const key = `${event.authStatus || ''}\n${event.message || ''}`;
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      onStatus(event);
    };

    const window = createAuthWindow(parent, '小鹅通账号授权', {
      onAllowedOpen: (url) => {
        if (manualFallback && phase === 'account' && isAllowedGatewayUrl(url)) {
          void navigateGateway(url);
        }
      }
    });

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (initialTimer) clearTimeout(initialTimer);
      if (gatewayFinishTimer) clearTimeout(gatewayFinishTimer);
      if (targetTimer) clearTimeout(targetTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if ((error || !keepWindowOnSuccess) && !window.isDestroyed()) window.close();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));

    const restartAuthorization = async (reason) => {
      if (settled || phase === 'resetting') return;
      if (retryUsed) {
        finish(new Error(reason));
        return;
      }
      retryUsed = true;
      phase = 'resetting';
      if (gatewayFinishTimer) clearTimeout(gatewayFinishTimer);
      if (targetTimer) clearTimeout(targetTimer);
      gatewayFinishTimer = null;
      targetTimer = null;
      manualFallback = false;
      exchangeStarted = false;
      accountReadySince = 0;
      targetReadySince = 0;
      targetStartedAt = 0;
      publishStatus({ message: '检测到目标店铺会话冲突，正在刷新授权后重试…' });
      try {
        await clearCourseStoreSession(identity);
        if (settled || window.isDestroyed()) return;
        phase = 'account';
        await window.loadURL(ACCOUNT_HOME_URL);
        void inspectAccount();
      } catch (error) {
        finish(new Error(`目标店铺会话刷新失败：${safeErrorDetail(error)}`));
      }
    };

    const inspectTarget = async () => {
      if (
        settled
        || phase !== 'target'
        || window.isDestroyed()
        || window.webContents.isLoadingMainFrame()
      ) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isInvalidSharePage(snapshot)) {
          finish(new Error('分享链接无效，请重新复制最新的小鹅通课程链接。'));
          return;
        }
        if (isSameXiaoeCourse(snapshot.url, identity) && isAuthenticatedCoursePage(snapshot)) {
          if (!targetReadySince) targetReadySince = Date.now();
          if (Date.now() - targetReadySince >= 900) {
            publishStatus({ authStatus: 'logged-in', message: '目标课程授权完成，正在获取回放流…' });
            finish(null, {
              status: 'authorized',
              window: keepWindowOnSuccess ? window : null
            });
          }
          return;
        }

        targetReadySince = 0;
        const elapsed = Date.now() - targetStartedAt;
        if (isLoginPage(snapshot)) {
          logAuthProbeLocation('目标课程进入登录页', window);
          if (elapsed >= 5000) {
            void restartAuthorization('目标店铺会话未能生效，请重试；不需要重新扫码。');
          } else {
            publishStatus({ message: '正在等待目标课程完成店铺登录…' });
          }
          return;
        }
        publishStatus({ message: '正在确认目标课程访问权限…' });
      } catch {
        if (Date.now() - targetStartedAt >= 5000) {
          void restartAuthorization('无法确认目标课程访问权限，请重试。');
        }
      }
    };

    const navigateTarget = async () => {
      if (settled || phase === 'target') return;
      phase = 'target';
      targetReadySince = 0;
      targetStartedAt = Date.now();
      window.hide();
      publishStatus({ message: '店铺会话已建立，正在同一窗口打开目标课程…' });
      targetTimer = setTimeout(() => {
        void restartAuthorization('目标课程登录确认超时，请重试；不需要重新扫码。');
      }, 20000);
      try {
        await getAuthSession().flushStorageData();
        await window.loadURL(identity.sourceUrl || identity.resolvedUrl);
        logAuthProbeLocation('目标课程导航完成', window);
        void inspectTarget();
      } catch (error) {
        if (String(error?.code || '') === 'ERR_ABORTED') {
          void inspectTarget();
          return;
        }
        void restartAuthorization(`目标课程打开失败：${safeErrorDetail(error)}`);
      }
    };

    const confirmGatewayCompletion = async (matched) => {
      if (settled || phase !== 'gateway' || window.isDestroyed()) return;
      if (window.webContents.isLoadingMainFrame()) {
        gatewayFinishTimer = setTimeout(() => void confirmGatewayCompletion(matched), 400);
        return;
      }
      try {
        const snapshot = await readPageSnapshot(window);
        if (isSameXiaoeCourse(snapshot.url, identity) && isAuthenticatedCoursePage(snapshot)) {
          phase = 'target';
          targetReadySince = 0;
          targetStartedAt = Date.now();
          targetTimer = setTimeout(() => {
            void restartAuthorization('目标课程登录确认超时，请重试；不需要重新扫码。');
          }, 20000);
          publishStatus({
            message: matched === 'resource'
              ? '资源授权已直达目标课程，正在确认访问权限…'
              : '店铺授权已直达目标课程，正在确认访问权限…'
          });
          void inspectTarget();
          return;
        }
      } catch {}
      void navigateTarget();
    };

    const navigateGateway = async (url, matched = 'shop') => {
      if (settled || phase !== 'account') return;
      if (!isAllowedGatewayUrl(url)) {
        finish(new Error('小鹅通返回了不受信任的授权地址，已停止。'));
        return;
      }
      phase = 'gateway';
      window.hide();
      publishStatus({ message: '正在静默建立目标店铺会话…' });
      try {
        await window.loadURL(url);
        await getAuthSession().flushStorageData();
        logAuthProbeLocation(`gateway 导航完成（${matched}）`, window);
        await logAuthProbeGatewayDocument(window);
        gatewayFinishTimer = setTimeout(() => void confirmGatewayCompletion(matched), 1200);
      } catch (error) {
        void restartAuthorization(`目标店铺授权跳转失败：${safeErrorDetail(error)}`);
      }
    };

    const showManualFallback = (status) => {
      if (manualFallback || settled) return;
      manualFallback = true;
      window.show();
      window.focus();
      publishStatus({
        message: `${gatewayFailureMessage(status)} 请在学习中心点击该课程或所属店铺完成授权；无需重新扫码。`
      });
    };

    const inspectAccount = async () => {
      if (
        settled
        || phase !== 'account'
        || manualFallback
        || window.isDestroyed()
        || window.webContents.isLoadingMainFrame()
      ) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isAccountLoginPage(snapshot)) {
          accountReadySince = 0;
          exchangeStarted = false;
          loginWasShown = true;
          window.show();
          window.focus();
          publishStatus({ authStatus: 'logged-out', message: '账号登录已失效，请使用微信重新扫码。' });
          return;
        }
        if (!isAuthenticatedAccountPage(snapshot)) {
          accountReadySince = 0;
          publishStatus({ message: '正在确认小鹅通账号登录状态…' });
          return;
        }

        if (loginWasShown) window.hide();
        publishStatus({ authStatus: 'logged-in', message: '账号已登录，正在匹配目标店铺…' });
        if (!accountReadySince) accountReadySince = Date.now();
        if (exchangeStarted || Date.now() - accountReadySince < 900) return;
        exchangeStarted = true;
        const result = await window.webContents.executeJavaScript(buildGatewayExchangeScript(identity), true);
        if (result?.status === 'ok') {
          await navigateGateway(result.url, result.matched);
          return;
        }
        if (result?.status === 'company-unsupported') {
          finish(new Error(gatewayFailureMessage(result.status)));
          return;
        }
        showManualFallback(result?.status);
      } catch {
        showManualFallback('request-error');
      }
    };

    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    window.on('closed', () => {
      if (!settled) {
        const message = manualFallback
          ? '已关闭学习中心，目标店铺尚未授权。'
          : (loginWasShown ? '微信登录尚未完成。' : '账号授权窗口已关闭。');
        finish(new Error(message));
      }
    });
    window.webContents.on('did-finish-load', () => {
      if (phase === 'account') void inspectAccount();
      if (phase === 'target') void inspectTarget();
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || settled) return;
      if (phase === 'target') {
        void restartAuthorization(`目标课程打开失败：${errorDescription}`);
      } else if (phase === 'account') {
        finish(new Error(`账号页面打开失败：${errorDescription}`));
      }
    });
    window.webContents.on('render-process-gone', () => finish(new Error('账号授权页面意外停止，请重试。')));

    publishStatus({ message: '正在打开账号学习中心…' });
    pollTimer = setInterval(() => {
      if (phase === 'account') void inspectAccount();
      if (phase === 'target') void inspectTarget();
    }, 700);
    initialTimer = setTimeout(() => {
      if (!settled && phase === 'account' && !loginWasShown && !manualFallback) {
        finish(new Error('无法确认小鹅通账号登录状态，请检查网络后重试。'));
      }
    }, 30000);
    window.loadURL(ACCOUNT_HOME_URL).then(() => void inspectAccount()).catch((error) => {
      finish(new Error(`账号页面打开失败：${safeErrorDetail(error)}`));
    });
  });
}

function captureReplayPage({
  parent,
  sourceUrl,
  resolvedSourceUrl,
  signal,
  onStatus,
  authorizedWindow = null
}) {
  return new Promise((resolve, reject) => {
    const authSession = getAuthSession();
    const candidateAttempts = new Map();
    const candidatesInFlight = new Set();
    let settled = false;
    let pollTimer = null;
    let captureTimer = null;
    let reloadTimer = null;
    let pageTitle = '小鹅通视频';
    let authenticatedWasReported = false;

    const reusingAuthorizedWindow = Boolean(authorizedWindow && !authorizedWindow.isDestroyed());
    const window = reusingAuthorizedWindow
      ? authorizedWindow
      : createAuthWindow(parent, '获取小鹅通授权回放流');
    window.setTitle('获取小鹅通授权回放流');
    window.hide();

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (captureTimer) clearTimeout(captureTimer);
      if (reloadTimer) clearTimeout(reloadTimer);
      authSession.webRequest.onBeforeRequest(REQUEST_FILTER, null);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!window.isDestroyed()) window.close();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new DOMException('Aborted', 'AbortError'));

    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }

    const inspectCandidate = async (candidate) => {
      const lastAttempt = candidateAttempts.get(candidate) || 0;
      if (settled || candidatesInFlight.has(candidate) || Date.now() - lastAttempt < 2500) return;
      candidateAttempts.set(candidate, Date.now());
      candidatesInFlight.add(candidate);
      try {
        const referer = window.webContents.getURL() || resolvedSourceUrl;
        const headers = {
          Referer: referer,
          'User-Agent': window.webContents.getUserAgent()
        };
        const inspected = await inspectHls({
          fetchImpl: fetch,
          manifestUrl: candidate,
          headers,
          signal
        });
        onStatus({ message: '已获取授权回放流，准备下载。' });
        finish(null, {
          sourceUrl,
          manifestUrl: candidate,
          headers,
          inspected,
          title: pageTitle
        });
      } catch (error) {
        if (!settled && !signal?.aborted) {
          onStatus({ message: `已检测到媒体请求，正在确认回放格式…（${safeErrorDetail(error)}）` });
        }
      } finally {
        candidatesInFlight.delete(candidate);
      }
    };

    const inspectRequest = (details, callback) => {
      for (const candidate of extractM3u8Candidates(details.url)) void inspectCandidate(candidate);
      callback({});
    };
    authSession.webRequest.onBeforeRequest(REQUEST_FILTER, inspectRequest);

    const updatePageState = async () => {
      if (settled || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isLoginPage(snapshot)) {
          finish(new Error('目标店铺会话未生效，请重试；不需要重新扫码。'));
        } else if (isAuthenticatedCoursePage(snapshot) && !authenticatedWasReported) {
          authenticatedWasReported = true;
          onStatus({ authStatus: 'logged-in', message: '店铺会话有效，正在静默获取授权回放流…' });
        }
      } catch {}
    };

    const inspectPerformanceEntries = () => {
      if (window.isDestroyed() || settled) return;
      void window.webContents.executeJavaScript(
        "performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => url.includes('m3u8') || url.includes('play_url')).slice(-80)",
        true
      ).then((urls) => {
        for (const requestUrl of urls || []) {
          for (const candidate of extractM3u8Candidates(requestUrl)) void inspectCandidate(candidate);
        }
      }).catch(() => {});
    };

    window.webContents.on('page-title-updated', (_event, title) => {
      const normalized = String(title || '').replace(/\s*[—–|-]\s*小鹅通.*$/i, '').trim();
      if (normalized && !/登录|小鹅通/i.test(normalized)) pageTitle = normalized;
    });
    window.webContents.on('did-finish-load', () => {
      void updatePageState();
      void window.webContents.executeJavaScript('document.title', true).then((title) => {
        const normalized = String(title || '').trim();
        if (normalized && !/登录|小鹅通/i.test(normalized)) pageTitle = normalized;
      }).catch(() => {});
    });
    window.on('closed', () => {
      if (!settled) finish(new Error('回放获取窗口已关闭，任务未开始。'));
    });

    pollTimer = setInterval(() => {
      if (window.isDestroyed() || settled) return;
      void updatePageState();
      inspectPerformanceEntries();
    }, 1500);
    captureTimer = setTimeout(() => {
      finish(new Error('未检测到可用的直播回放流；请确认直播已经结束并开放回放。'));
    }, 60000);

    if (reusingAuthorizedWindow) {
      void updatePageState();
      inspectPerformanceEntries();
      void window.webContents.executeJavaScript('document.title', true).then((title) => {
        const normalized = String(title || '').trim();
        if (normalized && !/登录|小鹅通/i.test(normalized)) pageTitle = normalized;
      }).catch(() => {});
      reloadTimer = setTimeout(() => {
        if (settled || window.isDestroyed()) return;
        onStatus({ message: '正在刷新已授权课程页以获取回放流…' });
        window.webContents.reload();
      }, 5000);
    } else {
      window.loadURL(resolvedSourceUrl).catch((error) => {
        finish(new Error(`视频页面打开失败：${safeErrorDetail(error)}`));
      });
    }
  });
}

async function captureAuthorizedReplay({ parent, sourceUrl, signal, onStatus = () => {} }) {
  if (!isAllowedCourseUrl(sourceUrl)) {
    throw new Error('请输入有效的小鹅通 HTTPS 视频播放页链接。');
  }
  const identity = await resolveCourseSource({ parent, sourceUrl, signal, onStatus });
  const authorization = await authorizeCourseStore({
    parent,
    identity,
    signal,
    onStatus,
    keepWindowOnSuccess: true
  });
  return captureReplayPage({
    parent,
    sourceUrl,
    resolvedSourceUrl: identity.resolvedUrl,
    signal,
    onStatus,
    authorizedWindow: authorization.window
  });
}

module.exports = {
  AUTH_PARTITION,
  authorizeCourseStore,
  captureAuthorizedReplay,
  clearAuthSession,
  clearCourseStoreSession,
  getAuthSession,
  readPageSnapshot,
  resolveCourseSource
};
