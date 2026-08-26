const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell
} = require('electron');
const { captureAuthorizedReplay, clearAuthSession } = require('./services/auth-capture.cjs');
const {
  abortable,
  chooseModelAfterInstall,
  DependencyManager,
  getModelOption,
  selectManifestForModel
} = require('./services/dependency-manager.cjs');
const { HistoryStore } = require('./services/history-store.cjs');
const { SettingsStore } = require('./services/settings-store.cjs');
const { StartupAuthGate } = require('./services/startup-auth-gate.cjs');
const { getSystemProfile, probeNvidiaGpu, probeVcRuntime } = require('./services/system-probe.cjs');
const { checkForUpdate } = require('./services/update-service.cjs');
const { installVcRuntime } = require('./services/vc-runtime-installer.cjs');
const { JobController } = require('./job-controller.cjs');
const { isAllowedCourseUrl } = require('./services/url-utils.cjs');

const AUTH_PROBE_FLAG = 'verify-auth';
const authProbeIndex = process.argv.indexOf(AUTH_PROBE_FLAG);
let authProbeEnvUrls = [];
try {
  authProbeEnvUrls = JSON.parse(process.env.XIAOE_AUTH_PROBE_URLS || '[]');
} catch {}
const authProbeUrls = Array.isArray(authProbeEnvUrls) && authProbeEnvUrls.length
  ? authProbeEnvUrls
  : (authProbeIndex >= 0 ? process.argv.slice(authProbeIndex + 1) : []);
const isAuthProbe = process.env.XIAOE_AUTH_PROBE_MODE === '1' || authProbeIndex >= 0;
if (isAuthProbe) {
  const probeUserData = path.resolve(
    process.env.XIAOE_AUTH_PROBE_USER_DATA || path.join(process.cwd(), '.auth-probe-user-data')
  );
  fs.mkdirSync(probeUserData, { recursive: true });
  app.setPath('userData', probeUserData);
}

let mainWindow = null;
let settings = null;
let history = null;
let jobController = null;
let activeJobSettings = null;
let startupAuthGate = null;
let startupAuthOperation = null;
let manifestCache = null;
const activeInstalls = new Map();
const componentInstalls = new Map();
let authStatus = { status: 'unknown', message: '尚未检测小鹅通登录状态。' };
let updateStatus = null;
let updateDownload = null;

function publishUpdateStatus(status) {
  updateStatus = status;
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('update:status', updateStatus);
  return updateStatus;
}

async function runUpdateCheck({ silent = false } = {}) {
  try {
    const status = await checkForUpdate({
      currentVersion: app.getVersion(),
      fetchImpl: (url, options) => net.fetch(url, options)
    });
    return publishUpdateStatus(status);
  } catch (error) {
    if (silent) {
      console.error(`[update] 检查更新失败：${error.message}`);
      return updateStatus;
    }
    throw error;
  }
}

async function downloadAndInstallUpdate() {
  if (updateDownload) throw new Error('安装包正在下载中。');
  if (!updateStatus?.available || !updateStatus.asset?.downloadUrl) {
    throw new Error('当前没有可用的新版本。');
  }
  if (activeJobSettings) throw new Error('转写任务进行中，任务完成后再更新。');

  const asset = updateStatus.asset;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '发现新版本',
    message: `发现新版本 ${updateStatus.latestVersion}（当前 ${app.getVersion()}）`,
    detail: `将下载 ${asset.name}（约 ${(asset.size / 1024 / 1024).toFixed(1)} MB），完成后自动运行安装程序并退出应用。`,
    buttons: ['下载并安装', '暂不更新'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return false;

  const controller = new AbortController();
  const record = { controller };
  updateDownload = record;

  let lastSentAt = 0;
  const sendProgress = (event) => {
    if (event.phase === 'downloading' && Date.now() - lastSentAt < 120) return;
    lastSentAt = Date.now();
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('update:progress', event);
  };

  try {
    const response = await net.fetch(asset.downloadUrl, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`安装包下载失败（HTTP ${response.status}）。`);
    const totalBytes = Number(response.headers.get('content-length')) || asset.size;
    const targetPath = path.join(app.getPath('temp'), 'Xiaoe Transcriber Update', asset.name);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    sendProgress({ phase: 'downloading', receivedBytes: 0, totalBytes });

    const destination = fs.createWriteStream(targetPath);
    let receivedBytes = 0;
    for await (const chunk of Readable.fromWeb(response.body)) {
      receivedBytes += chunk.length;
      await new Promise((resolve, reject) => {
        destination.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
      sendProgress({ phase: 'downloading', receivedBytes, totalBytes });
    }
    await new Promise((resolve, reject) => destination.end((error) => (error ? reject(error) : resolve())));
    if (receivedBytes !== asset.size) throw new Error(`安装包不完整（${receivedBytes}/${asset.size} 字节），请重试。`);
    sendProgress({ phase: 'downloaded', receivedBytes, totalBytes });

    if (process.platform !== 'win32') throw new Error('自动更新目前只支持 Windows。');
    const child = spawn(targetPath, [], { detached: true, stdio: 'ignore' }).on('error', (error) => {
      console.error(`[update] 启动安装程序失败：${error.message}`);
    });
    child.unref();
    setTimeout(() => app.quit(), 800);
    return true;
  } catch (error) {
    if (error?.name !== 'AbortError') sendProgress({ phase: 'error', message: error.message || String(error) });
    throw error;
  } finally {
    updateDownload = null;
  }
}

function defaultModelDirectory() {
  if (process.platform === 'win32' && fs.existsSync('D:\\')) {
    return 'D:\\Xiaoe-Transcriber\\Models';
  }
  return path.join(app.getPath('localAppData'), 'Xiaoe Transcriber', 'Models');
}

async function runAuthProbe() {
  if (!authProbeUrls.length || authProbeUrls.some((url) => !isAllowedCourseUrl(url))) {
    throw new Error('用法：npm run verify:auth -- <小鹅通课程链接> [更多课程链接]');
  }
  const parent = new BrowserWindow({
    width: 900,
    height: 640,
    show: true,
    title: '小鹅通跨店铺登录验证',
    backgroundColor: '#fffdf7',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const abortController = new AbortController();
  try {
    for (let index = 0; index < authProbeUrls.length; index += 1) {
      const onStatus = ({ message }) => {
        if (message) console.log(`[账号授权 ${index + 1}/${authProbeUrls.length}] ${message}`);
      };
      await captureAuthorizedReplay({
        parent,
        sourceUrl: authProbeUrls[index],
        signal: abortController.signal,
        onStatus
      });
      console.log(`[账号授权 ${index + 1}/${authProbeUrls.length}] 验证成功（已检测到回放流）`);
    }
  } finally {
    abortController.abort();
    if (!parent.isDestroyed()) parent.close();
  }
}

function dependencyManifest() {
  if (!manifestCache) {
    const manifestPath = path.join(app.getAppPath(), 'assets', 'dependencies.json');
    manifestCache = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return manifestCache;
}

function createDependencyManager(
  modelId = settings.get('selectedModelId'),
  summaryModelId = settings.get('selectedSummaryModelId'),
  modelDirectory = settings.get('modelDirectory')
) {
  const manifest = selectManifestForModel(dependencyManifest(), modelId, summaryModelId);
  return new DependencyManager({
    rootDirectory: modelDirectory,
    manifest,
    fetchImpl: (url, options) => net.fetch(url, options)
  });
}

function componentDownloadBytes(component) {
  return component.downloads.reduce((sum, download) => sum + download.size, 0);
}

function installComponentShared(manager, component, { signal, onEvent, participantKey }) {
  let entry = componentInstalls.get(component.id);
  if (!entry) {
    const controller = new AbortController();
    const listeners = new Set();
    const participants = new Set();
    const promise = manager.installComponent(component, {
      signal: controller.signal,
      onEvent: (event) => {
        for (const listener of listeners) listener(event);
      }
    });
    promise.catch(() => {});
    const tracked = promise.finally(() => componentInstalls.delete(component.id));
    entry = { promise: tracked, controller, listeners, participants };
    componentInstalls.set(component.id, entry);
  }
  entry.listeners.add(onEvent);
  entry.participants.add(participantKey);
  return abortable(entry.promise, signal).finally(() => {
    entry.listeners.delete(onEvent);
    entry.participants.delete(participantKey);
    if (!entry.participants.size && componentInstalls.get(component.id) === entry) {
      entry.controller.abort();
    }
  });
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

async function ensureStartupLogin() {
  if (startupAuthOperation) return startupAuthOperation;

  startupAuthOperation = startupAuthGate.login().finally(() => {
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
    if (activeInstalls.size) throw new Error('有模型正在下载，暂时不能更改目录。');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择本地模型安装位置',
      defaultPath: settings.get('modelDirectory'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return settings.set({ modelDirectory: result.filePaths[0] });
  });

  ipcMain.handle('settings:select-model', async (_event, modelId) => {
    const option = getModelOption(dependencyManifest().modelOptions, modelId);
    if (!option || option.id !== modelId) throw new Error('未知的转写模型。');
    const model = await describeModel(option);
    if (!model.ready) throw new Error('请先下载并安装这个模型。');
    settings.set({ selectedModelId: modelId });
    return getDependencyState(modelId);
  });

  ipcMain.handle('settings:select-summary-model', async (_event, modelId) => {
    const option = getModelOption(dependencyManifest().summaryOptions, modelId);
    if (!option || option.id !== modelId) throw new Error('未知的总结模型。');
    const model = await describeSummaryModel(option);
    if (!model.modelInstalled) throw new Error('请先下载并安装这个总结模型。');
    settings.set({ selectedSummaryModelId: modelId });
    return getDependencyState(undefined, modelId);
  });

  ipcMain.handle('settings:set-completion-sound', (_event, enabled) => {
    return settings.set({ completionSoundEnabled: Boolean(enabled) });
  });

  ipcMain.handle('dependencies:status', () => getDependencyState());
  ipcMain.handle('dependencies:install', async (_event, payload = {}) => {
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const isSummary = kind === 'summary';
    const manifest = dependencyManifest();
    const requestedModelId = payload.modelId || (isSummary
      ? settings.get('selectedSummaryModelId')
      : settings.get('selectedModelId'));
    const options = isSummary ? manifest.summaryOptions : manifest.modelOptions;
    const option = options.find((model) => model.id === requestedModelId);
    if (!option) throw new Error(isSummary ? '请先选择总结模型。' : '请先选择转写模型。');
    const installKey = `${kind}:${option.id}`;
    if (activeInstalls.has(installKey)) throw new Error('这个模型已经在下载中。');

    const record = { controller: new AbortController(), intent: null };
    let totalBytes = 0;
    let completedBytes = 0;
    let manager = null;
    let pendingComponents = [];

    let lastSentAt = 0;
    let lastPhase = '';
    const send = (event) => {
      if (event.phase === lastPhase && event.phase === 'download' && Date.now() - lastSentAt < 120) return;
      lastPhase = event.phase;
      lastSentAt = Date.now();
      if (!mainWindow?.isDestroyed()) {
        mainWindow.webContents.send('dependencies:progress', { kind, modelId: option.id, ...event });
      }
    };

    const operation = (async () => {
      const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
      if (!gpu.supported) throw new Error('未检测到可用的 NVIDIA 显卡或驱动，请先安装 NVIDIA 驱动。');
      if (!vcRuntime.supported) throw new Error('请先安装 Microsoft Visual C++ 2015–2022 x64 运行库。');

      manager = isSummary
        ? createDependencyManager(settings.get('selectedModelId'), option.id)
        : createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
      const status = await manager.getStatus();
      pendingComponents = manager.manifest.components.filter(
        (component) => !status.components.find((item) => item.id === component.id)?.ready
      );
      totalBytes = pendingComponents.reduce((sum, component) => sum + componentDownloadBytes(component), 0);
      send({ phase: 'prepare', label: option.label, completedBytes: 0, totalBytes });
      for (const component of pendingComponents) {
        const componentBytes = componentDownloadBytes(component);
        const freshStatus = await manager.getStatus();
        if (freshStatus.components.find((item) => item.id === component.id)?.ready) {
          completedBytes += componentBytes;
          send({ phase: 'skip', componentLabel: component.label, completedBytes, totalBytes });
          continue;
        }
        send({ phase: 'download', componentLabel: component.label, completedBytes, totalBytes });
        await installComponentShared(manager, component, {
          signal: record.controller.signal,
          participantKey: installKey,
          onEvent: (event) => {
            send({
              phase: event.phase,
              componentLabel: component.label,
              fileName: event.fileName,
              completedBytes: completedBytes + event.componentBytes,
              totalBytes
            });
          }
        });
        completedBytes += componentBytes;
      }
      send({ phase: 'verifying', completedBytes: totalBytes, totalBytes });
      await manager.verifyInstalledEngines(record.controller.signal);
      if (isSummary) {
        const activeSummaryModelId = settings.get('selectedSummaryModelId');
        const activeSummaryOption = getModelOption(manifest.summaryOptions, activeSummaryModelId);
        const activeSummaryModel = activeSummaryOption ? await describeSummaryModel(activeSummaryOption) : null;
        settings.set({
          selectedSummaryModelId: chooseModelAfterInstall(activeSummaryModelId, activeSummaryModel?.modelInstalled, option.id)
        });
      } else {
        const activeModelId = settings.get('selectedModelId');
        const activeOption = getModelOption(manifest.modelOptions, activeModelId);
        const activeModel = activeOption ? await describeModel(activeOption) : null;
        settings.set({
          selectedModelId: chooseModelAfterInstall(activeModelId, activeModel?.ready, option.id)
        });
      }
      send({ phase: 'complete', completedBytes: totalBytes, totalBytes });
      return getDependencyState();
    })();

    activeInstalls.set(installKey, record);
    try {
      return await operation;
    } catch (error) {
      if (error?.name === 'AbortError' && record.intent) {
        if (record.intent === 'cancel' && manager) {
          for (const component of pendingComponents) {
            const entry = componentInstalls.get(component.id);
            if (entry && entry.participants.size > 0) continue;
            if (entry) await entry.promise.catch(() => {});
            await manager.discardStagedComponent(component.id).catch(() => {});
          }
        }
        send({
          phase: record.intent === 'pause' ? 'paused' : 'cancelled',
          componentLabel: option.label,
          completedBytes,
          totalBytes
        });
        return getDependencyState();
      }
      send({ phase: 'error', message: error.message || String(error), completedBytes: 0, totalBytes: 0 });
      throw error;
    } finally {
      activeInstalls.delete(installKey);
    }
  });

  ipcMain.handle('dependencies:pause-install', (_event, payload = {}) => {
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const record = activeInstalls.get(`${kind}:${payload.modelId}`);
    if (!record) throw new Error('这个模型当前没有在下载。');
    record.intent = 'pause';
    record.controller.abort();
    return true;
  });

  ipcMain.handle('dependencies:cancel-install', async (_event, payload = {}) => {
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const isSummary = kind === 'summary';
    const manifest = dependencyManifest();
    const options = isSummary ? manifest.summaryOptions : manifest.modelOptions;
    const option = getModelOption(options, payload.modelId);
    if (!option || option.id !== payload.modelId) throw new Error(isSummary ? '未知的总结模型。' : '未知的转写模型。');

    const record = activeInstalls.get(`${kind}:${option.id}`);
    if (record) {
      record.intent = 'cancel';
      record.controller.abort();
      return true;
    }

    const manager = isSummary
      ? createDependencyManager(settings.get('selectedModelId'), option.id)
      : createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
    for (const component of manager.manifest.components) {
      if (component.modelOptionId && component.modelOptionId !== option.id) continue;
      if (component.summaryOptionId && component.summaryOptionId !== option.id) continue;
      const entry = componentInstalls.get(component.id);
      if (entry && entry.participants.size > 0) continue;
      if (entry) await entry.promise.catch(() => {});
      await manager.discardStagedComponent(component.id).catch(() => {});
    }
    return getDependencyState();
  });

  ipcMain.handle('dependencies:remove-model', async (_event, payload = {}) => {
    if (activeInstalls.size) throw new Error('有模型正在下载，暂时不能删除。');
    const kind = payload.kind === 'summary' ? 'summary' : 'transcribe';
    const isSummary = kind === 'summary';
    const manifest = dependencyManifest();
    const options = isSummary ? manifest.summaryOptions : manifest.modelOptions;
    const option = getModelOption(options, payload.modelId);
    if (!option || option.id !== payload.modelId) throw new Error(isSummary ? '未知的总结模型。' : '未知的转写模型。');

    const activeTaskModelId = isSummary
      ? activeJobSettings?.selectedSummaryModelId
      : activeJobSettings?.selectedModelId;
    if (activeTaskModelId === option.id) {
      throw new Error('本次任务正在使用这个模型。任务完成后再删除。');
    }

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
      return manager.removeModel('summary').then(() => getDependencyState());
    } else {
      const activeState = await getDependencyState(activeModelId);
      if (activeModelId === option.id && activeState.ready) {
        throw new Error('当前正在使用这个模型。请先切换到另一个已安装模型。');
      }
      const manager = createDependencyManager(option.id, settings.get('selectedSummaryModelId'));
      return manager.removeModel().then(() => getDependencyState(activeModelId));
    }
  });

  ipcMain.handle('job:start', async (_event, payload) => {
    if (activeJobSettings) throw new Error('已有任务正在运行。');
    const sourceUrl = String(payload?.sourceUrl || '').trim();
    if (!isAllowedCourseUrl(sourceUrl)) throw new Error('请输入有效的小鹅通 HTTPS 视频播放页链接。');
    settings.set({ lastSourceUrl: sourceUrl });
    const jobSettings = settings.getAll();
    activeJobSettings = jobSettings;
    try {
      const [gpu, vcRuntime] = await Promise.all([probeNvidiaGpu(), probeVcRuntime()]);
      if (!gpu.supported) throw new Error('未检测到可用的 NVIDIA 显卡或驱动。');
      if (!vcRuntime.supported) throw new Error('请先安装最新 Microsoft Visual C++ 2015–2022 x64 运行库。');
      return await jobController.start({ ...payload, sourceUrl, jobSettings });
    } finally {
      activeJobSettings = null;
    }
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
  ipcMain.handle('auth:startup-login', async () => {
    try {
      return await ensureStartupLogin();
    } catch (error) {
      const result = publishAuthStatus({ status: 'logged-out', message: error.message });
      return { ...result, error: error.message };
    }
  });
  ipcMain.handle('auth:logout', async () => {
    startupAuthGate.close();
    await clearAuthSession();
    publishAuthStatus({ status: 'logged-out', message: '小鹅通登录已退出。' });
    return true;
  });

  ipcMain.handle('system:install-vc-runtime', async () => installVcRuntime({
    fetchImpl: (url, options) => net.fetch(url, options),
    onProgress: (event) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('system:vc-runtime-progress', event);
    }
  }));

  ipcMain.handle('update:get-status', () => updateStatus);
  ipcMain.handle('update:check', () => runUpdateCheck());
  ipcMain.handle('update:install', () => downloadAndInstallUpdate());
}

const singleInstanceLock = isAuthProbe || app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (isAuthProbe) {
      await runAuthProbe();
      app.quit();
      return;
    }
    settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'), {
      outputDirectory: path.join(app.getPath('documents'), 'Xiaoe Transcriber'),
      modelDirectory: defaultModelDirectory(),
      lastSourceUrl: '',
      selectedModelId: '',
      selectedSummaryModelId: '',
      completionSoundEnabled: true
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

    if (!process.env.XIAOE_TRANSCRIBER_SCREENSHOT_PATH) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(() => void runUpdateCheck({ silent: true }), 3000);
      });
    }
  }).catch((error) => {
    console.error(String(error?.message || error));
    if (isAuthProbe) app.exit(1);
    else {
      process.exitCode = 1;
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
