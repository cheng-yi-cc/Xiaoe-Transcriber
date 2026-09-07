const { WebContentsView } = require('electron');
const { isAccountLoginPage, isAuthenticatedAccountPage } = require('./auth-state.cjs');
const { ACCOUNT_HOME_URL } = require('./account-gateway.cjs');
const { AUTH_PARTITION } = require('./auth-capture.cjs');
const { isAllowedXiaoeUrl } = require('./url-utils.cjs');

function normalizeBounds(bounds = {}) {
  return {
    x: Math.max(0, Math.round(Number(bounds.x) || 0)),
    y: Math.max(0, Math.round(Number(bounds.y) || 0)),
    width: Math.max(1, Math.round(Number(bounds.width) || 1)),
    height: Math.max(1, Math.round(Number(bounds.height) || 1))
  };
}

function isUsableBounds(bounds = {}) {
  return Math.round(Number(bounds.width) || 0) >= 50 && Math.round(Number(bounds.height) || 0) >= 50;
}

function buildLoginQrScrollScript() {
  return `(() => {
    try {
      const textPattern = /微信.{0,8}(?:扫码|登录)|(?:扫码|登录).{0,8}微信|扫码登录/;
      const roots = [document];
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) roots.push({ document: frame.contentDocument, frame });
        } catch {}
      }
      const rectOf = (element) => {
        try {
          return element.getBoundingClientRect();
        } catch {
          return null;
        }
      };
      let target = null;
      let targetFrame = null;
      for (const root of roots) {
        const doc = root.document || root;
        const frame = root.frame || null;
        let elements = [];
        try {
          elements = [...doc.querySelectorAll('div, section, p, h1, h2, img, canvas')];
        } catch {
          continue;
        }
        for (const element of elements) {
          let text = '';
          try {
            text = String(element.innerText || element.textContent || '').slice(0, 120);
          } catch {
            continue;
          }
          if (!text || !textPattern.test(text)) continue;
          const rect = rectOf(element);
          if (!rect || rect.width <= 40 || rect.height <= 40) continue;
          if (!target) {
            target = element;
            targetFrame = frame;
          } else {
            const current = rect.width * rect.height;
            const bestRect = rectOf(target);
            const best = bestRect ? bestRect.width * bestRect.height : Number.MAX_SAFE_INTEGER;
            if (current < best) {
              target = element;
              targetFrame = frame;
            }
          }
        }
      }
      if (!target) {
        for (const root of roots) {
          const doc = root.document || root;
          const frame = root.frame || null;
          let graphics = [];
          try {
            graphics = [...doc.querySelectorAll('img, canvas')];
          } catch {
            continue;
          }
          for (const element of graphics) {
            const rect = rectOf(element);
            if (!rect || rect.width < 120 || rect.width > 320) continue;
            const ratio = rect.width / Math.max(1, rect.height);
            if (ratio < 0.8 || ratio > 1.25) continue;
            target = element;
            targetFrame = frame;
            break;
          }
          if (target) break;
        }
      }
      if (!target) {
        const bodyText = String(document.body?.innerText || '');
        if (!/微信|扫码|登录/.test(bodyText)) return false;
        target = document.querySelector('#app, #root, main') || document.body;
      }
      if (!target) return false;
      if (targetFrame) {
        try {
          targetFrame.scrollIntoView({ block: 'center', inline: 'center' });
        } catch {}
      }
      target.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    } catch {
      return false;
    }
  })()`;
}

async function readSnapshot(view) {
  if (!view || view.webContents.isDestroyed()) return { url: '', text: '', accountReady: false };
  return view.webContents.executeJavaScript(`({
    url: location.href,
    text: (document.body?.innerText || '').slice(0, 5000),
    accountReady: Boolean(document.querySelector('.index-wrapper, .my-participate-page'))
  })`, true);
}

class StartupAuthGate {
  constructor({ mainWindow, onStatus = () => {} }) {
    this.mainWindow = mainWindow;
    this.onStatus = onStatus;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.hasUsableBounds = false;
    this.loginVisible = false;
    this.lastQrScrollAt = 0;
    this.view = null;
    this.operation = null;
  }

  setBounds(bounds) {
    this.bounds = normalizeBounds(bounds);
    this.hasUsableBounds = isUsableBounds(this.bounds);
    if (!this.view || this.view.webContents.isDestroyed()) return;
    this.view.setBounds(this.bounds);
    if (this.loginVisible && this.hasUsableBounds) {
      this.view.setVisible(true);
      this.scrollLoginQrIntoView();
    }
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
    this.loginVisible = false;
  }

  scrollLoginQrIntoView() {
    const now = Date.now();
    if (now - this.lastQrScrollAt < 2500) return;
    this.lastQrScrollAt = now;
    if (!this.view || this.view.webContents.isDestroyed()) return;
    try {
      this.view.webContents.executeJavaScript(buildLoginQrScrollScript(), true).catch(() => {});
    } catch {}
  }

  async login() {
    if (this.operation) this.operation.cancel();
    this.destroyView();
    this.hasUsableBounds = isUsableBounds(this.bounds);
    this.lastQrScrollAt = 0;

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
          if (isAccountLoginPage(snapshot)) {
            authenticatedSince = 0;
            loginWasShown = true;
            this.loginVisible = true;
            if (this.hasUsableBounds) {
              view.setVisible(true);
              this.scrollLoginQrIntoView();
            }
            this.onStatus({ status: 'logged-out', message: '请使用微信扫码登录小鹅通账号。' });
            return;
          }
          if (isAuthenticatedAccountPage(snapshot)) {
            this.loginVisible = false;
            view.setVisible(false);
            if (!authenticatedSince) authenticatedSince = Date.now();
            if (Date.now() - authenticatedSince >= 1200) {
              this.onStatus({ status: 'logged-in', message: '小鹅通账号已登录。' });
              finish(null, { status: 'logged-in' });
            }
            return;
          }
          authenticatedSince = 0;
          this.loginVisible = false;
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
      view.webContents.loadURL(ACCOUNT_HOME_URL).then(() => void inspect()).catch((error) => {
        finish(new Error(`登录页打开失败：${error.message}`));
      });
      });
    } finally {
      if (this.view === view) this.destroyView();
    }
  }
}

module.exports = { StartupAuthGate, normalizeBounds, isUsableBounds, buildLoginQrScrollScript };
