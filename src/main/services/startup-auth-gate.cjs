const { WebContentsView } = require('electron');
const { isAuthenticatedCoursePage, isLoginPage } = require('./auth-state.cjs');
const { AUTH_PARTITION, getAuthSession } = require('./auth-capture.cjs');
const { isAllowedXiaoeUrl } = require('./url-utils.cjs');

function normalizeBounds(bounds = {}) {
  return {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds.width) || 1)),
    height: Math.max(1, Math.round(Number(bounds.height) || 1))
  };
}

async function readSnapshot(view) {
  if (!view || view.webContents.isDestroyed()) return { url: '', text: '', hasVideo: false };
  return view.webContents.executeJavaScript(`({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 5000),
    hasVideo: Boolean(document.querySelector('video'))
  })`, true);
}

class StartupAuthGate {
  constructor({ mainWindow, onStatus = () => {} }) {
    this.mainWindow = mainWindow;
    this.onStatus = onStatus;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.view = null;
    this.operation = null;
  }

  setBounds(bounds) {
    this.bounds = normalizeBounds(bounds);
    this.view?.setBounds(this.bounds);
  }

  close() {
    this.operation?.cancel?.();
    this.operation = null;
    this.destroyView();
  }

  destroyView() {
    if (!this.view) return;
    this.mainWindow.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }

  async login(sourceUrl) {
    if (!isAllowedXiaoeUrl(sourceUrl)) {
      throw new Error('请输入有效的小鹅通 HTTPS 视频播放页链接。');
    }
    if (this.operation) this.operation.cancel();
    this.destroyView();

    const authSession = getAuthSession();
    const view = new WebContentsView({
      webPreferences: {
        partition: AUTH_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    });
    this.view = view;
    view.setBounds(this.bounds);
    view.setBackgroundColor('#fffdf7');
    view.setVisible(false);
    view.webContents.setAudioMuted(true);
    view.webContents.setZoomFactor(0.82);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedXiaoeUrl(url)) void view.webContents.loadURL(url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedXiaoeUrl(url)) event.preventDefault();
    });
    this.mainWindow.contentView.addChildView(view);

    try {
      return await new Promise((resolve, reject) => {
      let settled = false;
      let pollTimer = null;
      let initialTimer = null;
      let authenticatedSince = 0;
      let loginWasShown = false;

      const cleanup = () => {
        if (pollTimer) clearInterval(pollTimer);
        if (initialTimer) clearTimeout(initialTimer);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.operation = null;
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () => finish(new Error('登录检测已取消。'));
      this.operation = { cancel };

      const inspect = async () => {
        if (settled || view.webContents.isDestroyed() || view.webContents.isLoadingMainFrame()) return;
        try {
          const snapshot = await readSnapshot(view);
          if (isLoginPage(snapshot)) {
            authenticatedSince = 0;
            loginWasShown = true;
            view.setVisible(true);
            this.onStatus({ status: 'logged-out', message: '请使用微信扫码登录。' });
            return;
          }
          if (isAuthenticatedCoursePage(snapshot)) {
            view.setVisible(false);
            if (!authenticatedSince) authenticatedSince = Date.now();
            if (Date.now() - authenticatedSince >= 1200) {
              this.onStatus({ status: 'logged-in', message: '小鹅通已登录。' });
              finish(null, { status: 'logged-in', sourceUrl });
            }
            return;
          }
          authenticatedSince = 0;
          this.onStatus({ status: 'checking', message: '正在确认小鹅通登录状态…' });
        } catch {
          // Navigation can invalidate the frame between polling ticks.
        }
      };

      view.webContents.on('did-finish-load', () => void inspect());
      view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) finish(new Error(`登录页打开失败：${errorDescription}`));
      });
      view.webContents.on('render-process-gone', () => finish(new Error('登录页面意外停止，请重试。')));
      this.onStatus({ status: 'checking', message: '正在确认小鹅通登录状态…' });
      pollTimer = setInterval(() => void inspect(), 900);
      initialTimer = setTimeout(() => {
        if (!settled && !loginWasShown) finish(new Error('无法确认小鹅通登录状态，请检查网络后重试。'));
      }, 25000);
      view.webContents.loadURL(sourceUrl).then(() => void inspect()).catch((error) => {
        finish(new Error(`登录页打开失败：${error.message}`));
      });
      });
    } finally {
      if (this.view === view) this.destroyView();
    }
  }
}

module.exports = { StartupAuthGate, normalizeBounds };
