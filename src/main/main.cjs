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
const {
  chooseModelAfterInstall,
  DependencyManager,
  getModelOption,
  selectManifestForModel
} = require('./services/dependency-manager.cjs');
const { HistoryStore } = require('./services/history-store.cjs');
const { SettingsStore } = require('./services/settings-store.cjs');
const { StartupAuthGate } = require('./services/startup-auth-gate.cjs');
const { getSystemProfile, probeNvidiaGpu, probeVcRuntime } = require('./services/system-probe.cjs');
const { installVcRuntime } = require('./services/vc-runtime-installer.cjs');
const { JobController } = require('./job-controller.cjs');

let mainWindow = null;
let settings = null;
let history = null;
let jobController = null;
let startupAuthGate = null;
let dependencyOperation = null;
let authOperation = null;
let startupAuthOperation = null;
let manifestCache = null;
let authStatus = { status: 'unknown', message: '尚未检测小鹅通登录状态。' };
let lastAuthVerification = null;

function defaultModelDirectory() {
  if (process.platform === 'win32' && fs.existsSync('D:\\')) {
    return 'D:\\Xiaoe-Transcriber\\Models';
  }
  return path.join(app.getPath('localAppData'), 'Xiaoe Transcriber', 'Models');
}

function dependencyManifest() {
  if (!manifestCache) {
    const manifestPath = path.join(app.getAppPath(), 'assets', 'dependencies.json');
    manifestCache = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return manifestCache;
}

function createDependencyManager(modelId = settings.get('selectedModelId'), summaryModelId = settings.get('selectedSummaryModelId')) {
  const manifest = selectManifestForModel(dependencyManifest(), modelId, summaryModelId);
  return new DependencyManager({
    rootDirectory: settings.get('modelDirectory'),
    manifest,
    fetchImpl: (url, options) => net.fetch(url, options),
    onProgress: (event) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('dependencies:progress', event);
    }
  });
}

function componentDownloadBytes(component) {
  return component.downloads.reduce((sum, download) => sum + download.size, 0);
}

function summarizeManagerStatus(manager, status) {
  const readyById = new Map(status.components.map((component) => [component.id, component.ready]));
  const remainingDownloadBytes = manager.manifest.components
    .filter((component) => !readyById.get(component.id))
    .reduce((sum, component) => sum + componentDownloadBytes(component), 0);
  return { readyById, remainingDownloadBytes };
}

async function describeModel(option, kind = 'transcribe') {
  const manager = kind === 'summary'
    ? createDependencyManager(settings.get('selectedModelId'), option.id)
    : createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
  const status = await manager.getStatus();
  const { readyById, remainingDownloadBytes } = summarizeManagerStatus(manager, status);
  return {
    ...option,
    kind,
    ready: status.ready,
    modelInstalled: Boolean(status.components.find((component) => component.id === option.componentId)?.ready),
    totalDownloadBytes: status.totalDownloadBytes,
    remainingDownloadBytes
  };
}

const describeSummaryModel = (option) => describeModel(option, 'summary');

async function resolveSelectedModelId(systemProfile) {
  const manifest = dependencyManifest();
  const configured = settings.get('selectedModelId');
  const configuredOption = manifest.modelOptions.find((option) => option.id === configured);
  if (configuredOption && (await describeModel(configuredOption)).ready) return configured;

  const models = await Promise.all(manifest.modelOptions.map((option) => describeModel(option)));
  const installedModel = models.find((model) => (
    model.id === systemProfile.recommendedModelId && model.ready
  )) || models.find((model) => model.ready);
  const selectedModelId = installedModel?.id || configuredOption?.id || systemProfile.recommendedModelId;
  settings.set({ selectedModelId });
  return selectedModelId;
}

async function resolveSelectedSummaryModelId(systemProfile) {
  const manifest = dependencyManifest();
  const configured = settings.get('selectedSummaryModelId');
  const configuredOption = manifest.summaryOptions.find((option) => option.id === configured);
  if (configuredOption && (await describeSummaryModel(configuredOption)).modelInstalled) return configured;

  const models = await Promise.all(manifest.summaryOptions.map((option) => describeSummaryModel(option)));
  const installedModel = models.find((model) => (
    model.id === systemProfile.recommendedSummaryModelId && model.modelInstalled
  )) || models.find((model) => model.modelInstalled);
  const selectedSummaryModelId = installedModel?.id || configuredOption?.id || systemProfile.recommendedSummaryModelId;
  settings.set({ selectedSummaryModelId });
  return selectedSummaryModelId;
}

async function getDependencyState(selectedModelId = settings.get('selectedModelId'), selectedSummaryModelId = settings.get('selectedSummaryModelId')) {
  const manifest = dependencyManifest();
  const fallbackId = manifest.modelOptions[0]?.id;
  const fallbackSummaryId = manifest.summaryOptions[0]?.id;
  const normalizedId = getModelOption(manifest.modelOptions, selectedModelId)?.id || fallbackId;
  const normalizedSummaryId = getModelOption(manifest.summaryOptions, selectedSummaryModelId)?.id || fallbackSummaryId;
  const manager = createDependencyManager(normalizedId, normalizedSummaryId);
  const status = await manager.getStatus();
  const { readyById, remainingDownloadBytes } = summarizeManagerStatus(manager, status);
  const models = await Promise.all(manifest.modelOptions.map((option) => describeModel(option)));
  const summaryModels = await Promise.all(manifest.summaryOptions.map((option) => describeSummaryModel(option)));
  return {
    ...status,
    selectedModelId: normalizedId,
    selectedModel: getModelOption(manifest.modelOptions, normalizedId),
    selectedSummaryModelId: normalizedSummaryId,
    selectedSummaryModel: getModelOption(manifest.summaryOptions, normalizedSummaryId),
    remainingDownloadBytes,
    models,
    summaryModels
  };
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
    return publishAuthStatus({ status: 'needs-link', message: '请先输入一个有权访问的小鹅通视频链接。' });
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

async function ensureStartupLogin(sourceUrl) {
  const normalizedUrl = String(sourceUrl || settings.get('lastSourceUrl') || '').trim();
  if (!normalizedUrl) {
    return publishAuthStatus({ status: 'needs-link', message: '输入一个有权访问的视频链接以显示登录二维码。' });
  }
  settings.set({ lastSourceUrl: normalizedUrl });
  if (startupAuthOperation) return startupAuthOperation;

  startupAuthOperation = startupAuthGate.login(normalizedUrl).then((result) => {
    lastAuthVerification = { sourceUrl: normalizedUrl, checkedAt: Date.now() };
    return result;
  }).finally(() => {
    startupAuthOperation = null;
  });
  return startupAuthOperation;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 880,
    minHeight: 680,
    title: 'Xiaoe Transcriber',
    backgroundColor: '#fffdf7',
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
  mainWindow.on('closed', () => {
    startupAuthGate?.close();
    startupAuthGate = null;
    mainWindow = null;
  });

  const screenshotPath = process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH;
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      void (async () => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const initialized = await mainWindow.webContents.executeJavaScript(
            "document.body.dataset.ready === 'true'",
            true
          );
          if (initialized) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, image.toPNG());
        app.quit();
      })();
    });
  }
}

async function getAppState() {
  const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
  const system = getSystemProfile(gpu);
  const selectedModelId = await resolveSelectedModelId(system);
  const selectedSummaryModelId = await resolveSelectedSummaryModelId(system);
  const dependencies = await getDependencyState(selectedModelId, selectedSummaryModelId);
  if (dependencies.ready) {
    try {
      await createDependencyManager(selectedModelId).verifyInstalledEngines();
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
    screenshotPage: process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PAGE || '',
    settings: appSettings,
    auth: {
      ...authStatus,
      autoCheck: !process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH,
      hasSavedSource: Boolean(appSettings.lastSourceUrl)
    },
    dependencies,
    gpu,
    vcRuntime,
    system,
    history: history.list()
  };
}

function registerIpc() {
  ipcMain.handle('app:get-state', getAppState);

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
    if (dependencyOperation) throw new Error('模型正在处理，暂时不能更改目录。');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地模型安装位置',
      defaultPath: settings.get('modelDirectory'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return settings.set({ modelDirectory: result.filePaths[0] });
  });

  ipcMain.handle('settings:select-model', async (_event, modelId) => {
    if (dependencyOperation) throw new Error('模型正在处理，暂时不能切换。');
    const option = getModelOption(dependencyManifest().modelOptions, modelId);
    if (!option || option.id !== modelId) throw new Error('未知的转写模型。');
    const model = await describeModel(option);
    if (!model.ready) throw new Error('请先下载并安装这个模型。');
    settings.set({ selectedModelId: modelId });
    return getDependencyState(modelId);
  });

  ipcMain.handle('settings:select-summary-model', async (_event, modelId) => {
    if (dependencyOperation) throw new Error('模型正在处理，暂时不能切换。');
    const option = getModelOption(dependencyManifest().summaryOptions, modelId);
    if (!option || option.id !== modelId) throw new Error('未知的总结模型。');
    const model = await describeSummaryModel(option);
    if (!model.modelInstalled) throw new Error('请先下载并安装这个总结模型。');
    settings.set({ selectedSummaryModelId: modelId });
    return getDependencyState(undefined, modelId);
  });

  ipcMain.handle('dependencies:status', () => getDependencyState());
  ipcMain.handle('dependencies:install', async (_event, payload = {}) => {
    if (dependencyOperation) throw new Error('另一个模型操作正在进行。');
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const isSummary = kind === 'summary';
    const manifest = dependencyManifest();
    const requestedModelId = payload.modelId || (isSummary
      ? settings.get('selectedSummaryModelId')
      : settings.get('selectedModelId'));
    const options = isSummary ? manifest.summaryOptions : manifest.modelOptions;
    const option = options.find((model) => model.id === requestedModelId);
    if (!option) throw new Error(isSummary ? '请先选择总结模型。' : '请先选择转写模型。');
    const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
    if (!gpu.supported) throw new Error('未检测到可用的 NVIDIA 显卡或驱动，请先安装 NVIDIA 驱动。');
    if (!vcRuntime.supported) throw new Error('请先安装 Microsoft Visual C++ 2015–2022 x64 运行库。');

    let operation;
    if (isSummary) {
      const activeModelId = settings.get('selectedModelId');
      const manager = createDependencyManager(activeModelId, option.id);
      operation = manager.installAll().then(async () => {
        settings.set({ selectedSummaryModelId: option.id });
        return getDependencyState(activeModelId, option.id);
      });
    } else {
      const activeModelId = settings.get('selectedModelId');
      const activeOption = getModelOption(manifest.modelOptions, activeModelId);
      const activeModel = activeOption ? await describeModel(activeOption) : null;
      const manager = createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
      operation = manager.installAll().then(async () => {
        const selectedModelId = chooseModelAfterInstall(activeModelId, activeModel?.ready, option.id);
        settings.set({ selectedModelId });
        return getDependencyState(selectedModelId);
      });
    }
    dependencyOperation = operation;
    try {
      return await dependencyOperation;
    } finally {
      dependencyOperation = null;
    }
  });

  ipcMain.handle('dependencies:remove-model', async (_event, payload = {}) => {
    if (dependencyOperation) throw new Error('另一个模型操作正在进行。');
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const isSummary = kind === 'summary';
    const manifest = dependencyManifest();
    const options = isSummary ? manifest.summaryOptions : manifest.modelOptions;
    const option = getModelOption(options, payload.modelId);
    if (!option || option.id !== payload.modelId) throw new Error(isSummary ? '未知的总结模型。' : '未知的转写模型。');

    const activeModelId = settings.get('selectedModelId');
    if (isSummary) {
      const activeSummaryModelId = settings.get('selectedSummaryModelId');
      if (activeSummaryModelId === option.id) {
        const activeState = await getDependencyState(activeModelId, activeSummaryModelId);
        const activeComponent = activeState.components.find((item) => item.id === option.componentId);
        if (activeComponent?.ready) {
          throw new Error('当前正在使用这个总结模型。请先切换到另一个已安装的总结模型。');
        }
      }
      const manager = createDependencyManager(activeModelId, option.id);
      dependencyOperation = manager.removeModel('summary').then(() => getDependencyState());
    } else {
      const activeState = await getDependencyState(activeModelId);
      if (activeModelId === option.id && activeState.ready) {
        throw new Error('当前正在使用这个模型。请先切换到另一个已安装模型。');
      }
      const manager = createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
      dependencyOperation = manager.removeModel().then(() => getDependencyState(activeModelId));
    }
    try {
      return await dependencyOperation;
    } finally {
      dependencyOperation = null;
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

  ipcMain.handle('history:list', () => history.list());
  ipcMain.handle('history:open', async (_event, id) => {
    const entry = history.get(id);
    if (!entry) return '找不到这条历史记录。';
    return shell.openPath(entry.resultDirectory);
  });
  ipcMain.handle('shell:open-path', async (_event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string') return '无效路径';
    return shell.openPath(targetPath);
  });

  ipcMain.handle('auth:set-view-bounds', (_event, bounds) => {
    startupAuthGate.setBounds(bounds);
    return true;
  });
  ipcMain.handle('auth:startup-login', async (_event, payload = {}) => {
    try {
      return await ensureStartupLogin(payload.sourceUrl);
    } catch (error) {
      const result = publishAuthStatus({ status: 'logged-out', message: error.message });
      return { ...result, error: error.message };
    }
  });
  ipcMain.handle('auth:ensure-login', async (_event, payload = {}) => {
    try {
      return await ensureLoginForSource(payload.sourceUrl);
    } catch (error) {
      const result = publishAuthStatus({ status: 'logged-out', message: error.message });
      return { ...result, error: error.message };
    }
  });
  ipcMain.handle('auth:logout', async () => {
    startupAuthGate.close();
    await clearAuthSession();
    lastAuthVerification = null;
    publishAuthStatus({ status: 'logged-out', message: '小鹅通登录已退出。' });
    return true;
  });

  ipcMain.handle('system:install-vc-runtime', async () => installVcRuntime({
    fetchImpl: (url, options) => net.fetch(url, options),
    onProgress: (event) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('system:vc-runtime-progress', event);
    }
  }));
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
      lastSourceUrl: '',
      selectedModelId: '',
      selectedSummaryModelId: ''
    });
    history = new HistoryStore(path.join(app.getPath('userData'), 'history.json'));
    createMainWindow();
    startupAuthGate = new StartupAuthGate({ mainWindow, onStatus: publishAuthStatus });
    jobController = new JobController({
      mainWindow,
      settings,
      createDependencyManager,
      onAuthStatus: publishAuthStatus,
      onHistory: (entry) => history.add(entry)
    });
    registerIpc();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
