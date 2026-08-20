const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell
} = require('electron');
const { clearAuthSession, ensureXiaoeLogin } = require('./services/auth-capture.cjs');
const { DependencyManager } = require('./services/dependency-manager.cjs');
const { SettingsStore } = require('./services/settings-store.cjs');
const { probeNvidiaGpu, probeVcRuntime } = require('./services/system-probe.cjs');
const { installVcRuntime } = require('./services/vc-runtime-installer.cjs');
const { JobController } = require('./job-controller.cjs');

let mainWindow = null;
let settings = null;
let jobController = null;
let dependencyInstall = null;
let authOperation = null;
let authStatus = { status: 'unknown', message: '尚未检测小鹅通登录状态。' };
let lastAuthVerification = null;

function defaultModelDirectory() {
  if (process.platform === 'win32' && fs.existsSync('D:\\')) {
    return 'D:\\Xiaoe-Transcriber\\Models';
  }
  return path.join(app.getPath('localAppData'), 'Xiaoe Transcriber', 'Models');
}

function dependencyManifest() {
  const manifestPath = path.join(app.getAppPath(), 'assets', 'dependencies.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function createDependencyManager() {
  return new DependencyManager({
    rootDirectory: settings.get('modelDirectory'),
    manifest: dependencyManifest(),
    fetchImpl: (url, options) => net.fetch(url, options),
    onProgress: (event) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('dependencies:progress', event);
    }
  });
}

function publishAuthStatus(event) {
  authStatus = {
    status: event.status || event.authStatus || 'unknown',
    message: event.message || '小鹅通登录状态已更新。'
  };
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('auth:status', authStatus);
  return authStatus;
}

async function ensureLoginForSource(sourceUrl) {
  const normalizedUrl = String(sourceUrl || settings.get('lastSourceUrl') || '').trim();
  if (!normalizedUrl) {
    return publishAuthStatus({ status: 'needs-link', message: '粘贴视频链接后自动检测登录。' });
  }

  settings.set({ lastSourceUrl: normalizedUrl });
  if (
    lastAuthVerification
    && lastAuthVerification.sourceUrl === normalizedUrl
    && Date.now() - lastAuthVerification.checkedAt < 30000
  ) {
    return publishAuthStatus({ status: 'logged-in', message: '小鹅通已登录。' });
  }
  if (authOperation) return authOperation;

  authOperation = ensureXiaoeLogin({
    parent: mainWindow,
    sourceUrl: normalizedUrl,
    onStatus: publishAuthStatus
  }).then((result) => {
    lastAuthVerification = { sourceUrl: normalizedUrl, checkedAt: Date.now() };
    return result;
  }).finally(() => {
    authOperation = null;
  });
  return authOperation;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 680,
    title: 'Xiaoe Transcriber',
    backgroundColor: '#eef2ef',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(app.getAppPath(), 'assets', 'icon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') console.error(`[renderer] ${details.message}`);
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  const screenshotPath = process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH;
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const initialized = await mainWindow.webContents.executeJavaScript(
            "document.querySelector('#outputPath')?.textContent !== '正在读取…'",
            true
          );
          if (initialized) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, image.toPNG());
        app.quit();
      })();
    });
  }
}

function registerIpc() {
  ipcMain.handle('app:get-state', async () => {
    const manager = createDependencyManager();
    const dependencies = await manager.getStatus();
    const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
    if (dependencies.ready) {
      try {
        await manager.verifyInstalledEngines();
      } catch (error) {
        dependencies.ready = false;
        dependencies.runtimeError = error.message;
      }
    }
    const appSettings = settings.getAll();
    if (process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH) {
      appSettings.outputDirectory = 'D:\\课程文字稿';
      appSettings.lastSourceUrl = '';
    }
    return {
      version: app.getVersion(),
      settings: appSettings,
      auth: {
        ...authStatus,
        autoCheck: !process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH
      },
      dependencies,
      gpu,
      vcRuntime
    };
  });

  ipcMain.handle('settings:choose-output-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择总结和文字稿的保存位置',
      defaultPath: settings.get('outputDirectory'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return settings.set({ outputDirectory: result.filePaths[0] });
  });

  ipcMain.handle('settings:choose-model-directory', async () => {
    if (dependencyInstall) throw new Error('模型正在安装，暂时不能更改目录。');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地模型安装位置',
      defaultPath: settings.get('modelDirectory'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return settings.set({ modelDirectory: result.filePaths[0] });
  });

  ipcMain.handle('dependencies:status', () => createDependencyManager().getStatus());
  ipcMain.handle('dependencies:install', async () => {
    if (dependencyInstall) return dependencyInstall;
    const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
    if (!gpu.supported) throw new Error('未检测到可用的 NVIDIA 显卡或驱动，请先安装 NVIDIA 驱动。');
    if (!vcRuntime.supported) throw new Error('请先安装 Microsoft Visual C++ 2015–2022 x64 运行库。');
    const manager = createDependencyManager();
    dependencyInstall = manager.installAll();
    try {
      return await dependencyInstall;
    } finally {
      dependencyInstall = null;
    }
  });

  ipcMain.handle('job:start', async (_event, payload) => {
    const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
    if (!gpu.supported) throw new Error('未检测到可用的 NVIDIA 显卡或驱动。');
    if (!vcRuntime.supported) throw new Error('请先安装最新 Microsoft Visual C++ 2015–2022 x64 运行库。');
    await ensureLoginForSource(payload?.sourceUrl);
    return jobController.start(payload);
  });
  ipcMain.handle('job:cancel', () => {
    jobController.cancel();
    return true;
  });
  ipcMain.handle('shell:open-path', async (_event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return '无效路径';
    return shell.openPath(targetPath);
  });
  ipcMain.handle('auth:logout', async () => {
    await clearAuthSession();
    lastAuthVerification = null;
    publishAuthStatus({ status: 'logged-out', message: '小鹅通登录已退出。' });
    return true;
  });
  ipcMain.handle('auth:ensure-login', async (_event, payload = {}) => {
    try {
      return await ensureLoginForSource(payload.sourceUrl);
    } catch (error) {
      const result = publishAuthStatus({ status: 'logged-out', message: error.message });
      return { ...result, error: error.message };
    }
  });
  ipcMain.handle('system:install-vc-runtime', async () => {
    return installVcRuntime({
      fetchImpl: (url, options) => net.fetch(url, options),
      onProgress: (event) => {
        if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('system:vc-runtime-progress', event);
      }
    });
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), {
      outputDirectory: path.join(app.getPath('documents'), 'Xiaoe Transcriber'),
      modelDirectory: defaultModelDirectory(),
      lastSourceUrl: ''
    });
    createMainWindow();
    jobController = new JobController({
      mainWindow,
      settings,
      createDependencyManager,
      onAuthStatus: publishAuthStatus
    });
    registerIpc();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
