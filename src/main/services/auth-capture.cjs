const { BrowserWindow, session } = require('electron');
const { isAuthenticatedCoursePage, isLoginPage } = require('./auth-state.cjs');
const { inspectHls } = require('./hls-downloader.cjs');
const { extractM3u8Candidates, isAllowedXiaoeUrl } = require('./url-utils.cjs');

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

function readPageSnapshot(window) {
  if (window.isDestroyed()) return Promise.resolve({ url: '', text: '', hasVideo: false });
  return window.webContents.executeJavaScript(`({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 5000),
    hasVideo: Boolean(document.querySelector('video'))
  })`, true);
}

function safeErrorDetail(error) {
  return String(error?.message || error || '未知错误')
    .replace(/https?:\/\/[^\s)\]]+/gi, '[已隐藏地址]')
    .slice(0, 180);
}

function createAuthWindow(parent, title) {
  const window = new BrowserWindow({
    parent,
    modal: true,
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
    if (isAllowedXiaoeUrl(url)) window.loadURL(url);
    return { action: 'deny' };
  });
  return window;
}

function ensureXiaoeLogin({ parent, sourceUrl, signal, onStatus = () => {} }) {
  if (!isAllowedXiaoeUrl(sourceUrl)) {
    return Promise.reject(new Error('请输入有效的小鹅通 HTTPS 视频播放页链接。'));
  }

  return new Promise((resolve, reject) => {
    const window = createAuthWindow(parent, '小鹅通微信登录');
    let settled = false;
    let pollTimer = null;
    let initialTimer = null;
    let authenticatedSince = 0;
    let loginWasShown = false;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (initialTimer) clearTimeout(initialTimer);
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

    const inspectPage = async () => {
      if (settled || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isLoginPage(snapshot)) {
          authenticatedSince = 0;
          if (!loginWasShown) {
            loginWasShown = true;
            window.show();
            window.focus();
          }
          onStatus({ status: 'logged-out', message: '登录已失效，请使用微信扫码登录；窗口已静音。' });
          return;
        }
        if (isAuthenticatedCoursePage(snapshot)) {
          if (!authenticatedSince) authenticatedSince = Date.now();
          if (Date.now() - authenticatedSince >= 1800) {
            onStatus({ status: 'logged-in', message: '小鹅通已登录。' });
            finish(null, { status: 'logged-in', sourceUrl });
          }
          return;
        }
        authenticatedSince = 0;
        onStatus({ status: 'checking', message: '正在检测小鹅通登录状态…' });
      } catch {}
    };

    window.on('closed', () => {
      if (!settled) finish(new Error(loginWasShown ? '微信登录尚未完成。' : '登录状态检测窗口已关闭。'));
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) finish(new Error(`登录页打开失败：${errorDescription}`));
    });

    onStatus({ status: 'checking', message: '正在检测小鹅通登录状态…' });
    pollTimer = setInterval(() => void inspectPage(), 900);
    initialTimer = setTimeout(() => {
      if (!settled && !loginWasShown) finish(new Error('无法确认小鹅通登录状态，请检查网络后重试。'));
    }, 25000);
    window.loadURL(sourceUrl).then(() => void inspectPage()).catch((error) => {
      finish(new Error(`登录页打开失败：${error.message}`));
    });
  });
}

function captureAuthorizedReplay({ parent, sourceUrl, signal, onStatus = () => {} }) {
  if (!isAllowedXiaoeUrl(sourceUrl)) {
    return Promise.reject(new Error('请输入有效的小鹅通 HTTPS 视频播放页链接。'));
  }

  return new Promise((resolve, reject) => {
    const authSession = getAuthSession();
    const candidateAttempts = new Map();
    const candidatesInFlight = new Set();
    let settled = false;
    let pollTimer = null;
    let pageTitle = '小鹅通视频';

    const window = createAuthWindow(parent, '登录小鹅通并获取视频');
    let loginWasShown = false;
    let authenticatedWasReported = false;

    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
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
        const referer = window.webContents.getURL() || sourceUrl;
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
        if (!signal?.aborted) {
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

    const updateWindowForAuthState = async () => {
      if (settled || window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
      try {
        const snapshot = await readPageSnapshot(window);
        if (isLoginPage(snapshot)) {
          authenticatedWasReported = false;
          if (!loginWasShown) {
            loginWasShown = true;
            window.show();
            window.focus();
          }
          onStatus({ authStatus: 'logged-out', message: '登录已失效，请使用微信扫码登录；窗口已静音。' });
        } else if (isAuthenticatedCoursePage(snapshot)) {
          if (loginWasShown) window.hide();
          if (!authenticatedWasReported) {
            authenticatedWasReported = true;
            onStatus({ authStatus: 'logged-in', message: '登录成功，正在静默获取授权回放流…' });
          }
        }
      } catch {}
    };

    window.webContents.on('page-title-updated', (_event, title) => {
      const normalized = String(title || '').replace(/\s*[—–|-]\s*小鹅通.*$/i, '').trim();
      if (normalized && !/登录|小鹅通/i.test(normalized)) pageTitle = normalized;
    });
    window.webContents.on('did-finish-load', () => {
      void updateWindowForAuthState();
      void window.webContents.executeJavaScript('document.title', true).then((title) => {
        const normalized = String(title || '').trim();
        if (normalized && !/登录|小鹅通/i.test(normalized)) pageTitle = normalized;
      }).catch(() => {});
    });
    window.on('closed', () => {
      if (!settled) finish(new Error('已关闭登录窗口，任务未开始。'));
    });

    pollTimer = setInterval(() => {
      if (window.isDestroyed() || settled) return;
      void updateWindowForAuthState();
      void window.webContents.executeJavaScript(
        "performance.getEntriesByType('resource').map((entry) => entry.name).filter((url) => url.includes('m3u8') || url.includes('play_url')).slice(-80)",
        true
      ).then((urls) => {
        for (const requestUrl of urls || []) {
          for (const candidate of extractM3u8Candidates(requestUrl)) void inspectCandidate(candidate);
        }
      }).catch(() => {});
    }, 1500);

    window.loadURL(sourceUrl).catch((error) => finish(new Error(`视频页面打开失败：${error.message}`)));
  });
}

module.exports = {
  AUTH_PARTITION,
  captureAuthorizedReplay,
  clearAuthSession,
  ensureXiaoeLogin,
  getAuthSession
};
