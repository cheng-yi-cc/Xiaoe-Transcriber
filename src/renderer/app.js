const elements = {
  sourceUrl: document.querySelector('#sourceUrl'),
  urlHint: document.querySelector('#urlHint'),
  outputPath: document.querySelector('#outputPath'),
  chooseOutputButton: document.querySelector('#chooseOutputButton'),
  startButton: document.querySelector('#startButton'),
  cancelButton: document.querySelector('#cancelButton'),
  settingsButton: document.querySelector('#settingsButton'),
  authChip: document.querySelector('#authChip'),
  progressNumber: document.querySelector('#progressNumber'),
  progressBar: document.querySelector('#progressBar'),
  signalMessage: document.querySelector('#signalMessage'),
  waveform: document.querySelector('#waveform'),
  stageList: document.querySelector('#stageList'),
  gpuState: document.querySelector('#gpuState'),
  gpuName: document.querySelector('#gpuName'),
  gpuDetail: document.querySelector('#gpuDetail'),
  versionText: document.querySelector('#versionText'),
  resultCard: document.querySelector('#resultCard'),
  resultTitle: document.querySelector('#resultTitle'),
  resultPath: document.querySelector('#resultPath'),
  openResultButton: document.querySelector('#openResultButton'),
  setupModal: document.querySelector('#setupModal'),
  closeSetupButton: document.querySelector('#closeSetupButton'),
  setupTitle: document.querySelector('#setupTitle'),
  setupError: document.querySelector('#setupError'),
  runtimeButton: document.querySelector('#runtimeButton'),
  modelPath: document.querySelector('#modelPath'),
  chooseModelButton: document.querySelector('#chooseModelButton'),
  installButton: document.querySelector('#installButton'),
  downloadMeter: document.querySelector('#downloadMeter'),
  downloadLabel: document.querySelector('#downloadLabel'),
  downloadPercent: document.querySelector('#downloadPercent'),
  downloadBar: document.querySelector('#downloadBar'),
  downloadDetail: document.querySelector('#downloadDetail'),
  readyActions: document.querySelector('#readyActions'),
  logoutButton: document.querySelector('#logoutButton'),
  doneSetupButton: document.querySelector('#doneSetupButton')
};

const state = {
  app: null,
  busy: false,
  dependenciesReady: false,
  resultDirectory: null,
  authStatus: 'unknown'
};

const stageOrder = ['capture', 'download', 'transcribe', 'summarize'];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function setProgress(percent, message, stage) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.progressNumber.textContent = `${String(Math.round(normalized)).padStart(2, '0')}%`;
  elements.progressBar.style.width = `${normalized}%`;
  elements.signalMessage.textContent = message || '处理中…';
  elements.waveform.classList.toggle('running', state.busy);
  const bars = [...elements.waveform.children];
  bars.forEach((bar, index) => bar.classList.toggle('active', index / bars.length < normalized / 100));

  const normalizedStage = stage === 'audio' ? 'download' : stage;
  const activeIndex = stageOrder.indexOf(normalizedStage);
  for (const item of elements.stageList.querySelectorAll('li')) {
    const index = stageOrder.indexOf(item.dataset.stage);
    item.classList.toggle('active', index === activeIndex && state.busy);
    item.classList.toggle('done', normalized >= 100 || (activeIndex >= 0 && index < activeIndex));
  }
}

function setBusy(busy) {
  state.busy = busy;
  elements.startButton.disabled = busy || !state.dependenciesReady;
  elements.chooseOutputButton.disabled = busy;
  elements.settingsButton.disabled = busy;
  elements.authChip.disabled = busy;
  elements.cancelButton.classList.toggle('hidden', !busy);
  elements.waveform.classList.toggle('running', busy);
}

function renderAuthStatus(event = {}) {
  const status = event.status || 'unknown';
  const labels = {
    checking: '小鹅通：检测中',
    'logged-in': '小鹅通：已登录',
    'logged-out': '小鹅通：待扫码',
    'needs-link': '小鹅通：待链接',
    unknown: '小鹅通：未检测'
  };
  state.authStatus = status;
  elements.authChip.className = `auth-chip ${status}`;
  elements.authChip.querySelector('span').textContent = labels[status] || labels.unknown;
  elements.authChip.title = event.message || labels[status] || labels.unknown;
}

async function ensureLogin(sourceUrl = '') {
  renderAuthStatus({ status: 'checking', message: '正在检测小鹅通登录状态…' });
  const result = await window.xiaoeApp.ensureLogin(sourceUrl || undefined);
  renderAuthStatus(result);
  return result;
}

function renderAppState(appState) {
  state.app = appState;
  state.dependenciesReady = appState.dependencies.ready;
  renderAuthStatus(appState.auth);
  elements.outputPath.textContent = appState.settings.outputDirectory;
  elements.outputPath.title = appState.settings.outputDirectory;
  elements.modelPath.textContent = appState.settings.modelDirectory;
  elements.modelPath.title = appState.settings.modelDirectory;
  if (!elements.sourceUrl.value && appState.settings.lastSourceUrl) {
    elements.sourceUrl.value = appState.settings.lastSourceUrl;
  }
  elements.versionText.textContent = `v${appState.version}`;
  if (appState.gpu.supported) {
    elements.gpuState.textContent = '可用';
    elements.gpuState.className = 'status-pill ready';
    elements.gpuName.textContent = appState.gpu.name;
    elements.gpuDetail.textContent = `${appState.gpu.memory} 显存 · 驱动 ${appState.gpu.driver} · VC++ ${appState.vcRuntime.version || '未知'}`;
  } else {
    elements.gpuState.textContent = '不可用';
    elements.gpuState.className = 'status-pill error';
    elements.gpuName.textContent = '未检测到 NVIDIA GPU';
    elements.gpuDetail.textContent = appState.gpu.detail;
  }
  setBusy(false);
  if (!appState.vcRuntime.supported) {
    elements.setupError.textContent = appState.vcRuntime.detail;
    elements.setupError.classList.remove('hidden');
    elements.runtimeButton.classList.remove('hidden');
  } else if (appState.dependencies.runtimeError) {
    elements.setupError.textContent = appState.dependencies.runtimeError;
    elements.setupError.classList.remove('hidden');
  }
  if (!state.dependenciesReady) openSetup(false);
}

function openSetup(canClose = state.dependenciesReady) {
  elements.setupModal.classList.remove('hidden');
  elements.closeSetupButton.classList.toggle('hidden', !canClose);
  elements.readyActions.classList.toggle('hidden', !state.dependenciesReady);
  elements.installButton.classList.toggle('hidden', state.dependenciesReady);
  elements.chooseModelButton.disabled = state.dependenciesReady;
  elements.setupTitle.textContent = state.dependenciesReady ? '本地模型已就绪' : '准备本地模型';
}

function closeSetup() {
  if (state.dependenciesReady) elements.setupModal.classList.add('hidden');
}

async function chooseOutputDirectory() {
  const settings = await window.xiaoeApp.chooseOutputDirectory();
  if (settings) {
    state.app.settings = settings;
    elements.outputPath.textContent = settings.outputDirectory;
    elements.outputPath.title = settings.outputDirectory;
  }
}

async function chooseModelDirectory() {
  const settings = await window.xiaoeApp.chooseModelDirectory();
  if (settings) {
    state.app.settings = settings;
    elements.modelPath.textContent = settings.modelDirectory;
    elements.modelPath.title = settings.modelDirectory;
  }
}

async function installDependencies() {
  elements.installButton.disabled = true;
  elements.chooseModelButton.disabled = true;
  elements.setupError.classList.add('hidden');
  elements.downloadMeter.classList.remove('hidden');
  try {
    const result = await window.xiaoeApp.installDependencies();
    state.dependenciesReady = result.ready;
    elements.downloadLabel.textContent = '本地模型安装完成';
    elements.downloadPercent.textContent = '100%';
    elements.downloadBar.style.width = '100%';
    elements.downloadDetail.textContent = '已通过完整性检查，可以开始转写。';
    elements.installButton.classList.add('hidden');
    elements.readyActions.classList.remove('hidden');
    elements.closeSetupButton.classList.remove('hidden');
    elements.setupTitle.textContent = '本地模型已就绪';
    elements.chooseModelButton.disabled = true;
    setBusy(false);
  } catch (error) {
    elements.setupError.textContent = error.message || String(error);
    elements.setupError.classList.remove('hidden');
    elements.installButton.disabled = false;
    elements.chooseModelButton.disabled = false;
  }
}

function handleDependencyProgress(event) {
  const percent = event.totalBytes ? Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100)) : 0;
  elements.downloadPercent.textContent = `${percent}%`;
  elements.downloadBar.style.width = `${percent}%`;
  if (event.component) elements.downloadLabel.textContent = event.phase === 'extract' ? `正在解压：${event.component.label}` : `正在下载：${event.component.label}`;
  elements.downloadDetail.textContent = `${formatBytes(event.completedBytes)} / ${formatBytes(event.totalBytes)}`;
}

function isLikelyXiaoeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['xetslk.com', 'xet.tech', 'xiaoeknow.com', 'pomoho.com']
      .some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

async function startJob() {
  const sourceUrl = elements.sourceUrl.value.trim();
  if (!isLikelyXiaoeUrl(sourceUrl)) {
    elements.sourceUrl.classList.add('invalid');
    elements.urlHint.textContent = '请输入有效的小鹅通 HTTPS 单视频播放页链接。';
    return;
  }
  elements.sourceUrl.classList.remove('invalid');
  elements.urlHint.textContent = '登录窗口会自动静音；获取授权回放流后会自行关闭。';
  elements.resultCard.classList.add('hidden');
  state.resultDirectory = null;
  setBusy(true);
  setProgress(1, '正在创建任务…', 'capture');
  try {
    const login = await ensureLogin(sourceUrl);
    if (login.status !== 'logged-in') throw new Error(login.error || '请先完成微信扫码登录。');
    const result = await window.xiaoeApp.startJob(sourceUrl);
    state.resultDirectory = result.resultDirectory;
    elements.resultTitle.textContent = `${result.title} 已处理完成`;
    elements.resultPath.textContent = result.resultDirectory;
    elements.resultPath.title = result.resultDirectory;
    elements.resultCard.classList.remove('hidden');
    setProgress(100, '总结和完整文字稿已生成。', 'complete');
  } catch (error) {
    setProgress(0, error.message || String(error), 'error');
  } finally {
    setBusy(false);
  }
}

function handleJobProgress(event) {
  if (event.resultDirectory) state.resultDirectory = event.resultDirectory;
  setProgress(event.percent, event.message, event.stage);
  if (event.stage === 'complete') {
    elements.resultTitle.textContent = `${event.title} 已处理完成`;
    elements.resultPath.textContent = event.resultDirectory;
    elements.resultPath.title = event.resultDirectory;
    elements.resultCard.classList.remove('hidden');
  } else if (event.stage === 'error' && event.transcriptPath && event.resultDirectory) {
    elements.resultTitle.textContent = '总结失败，完整文字稿已保留';
    elements.resultPath.textContent = event.resultDirectory;
    elements.resultPath.title = event.resultDirectory;
    elements.resultCard.classList.remove('hidden');
  }
}

async function initialize() {
  window.xiaoeApp.onDependencyProgress(handleDependencyProgress);
  window.xiaoeApp.onJobProgress(handleJobProgress);
  window.xiaoeApp.onAuthStatus(renderAuthStatus);
  const appState = await window.xiaoeApp.getState();
  renderAppState(appState);
  if (appState.auth.autoCheck) void ensureLogin().catch((error) => {
    renderAuthStatus({ status: 'logged-out', message: error.message });
  });
}

elements.chooseOutputButton.addEventListener('click', chooseOutputDirectory);
elements.chooseModelButton.addEventListener('click', chooseModelDirectory);
elements.installButton.addEventListener('click', installDependencies);
elements.startButton.addEventListener('click', startJob);
elements.cancelButton.addEventListener('click', () => window.xiaoeApp.cancelJob());
elements.settingsButton.addEventListener('click', () => openSetup(true));
elements.authChip.addEventListener('click', () => {
  const sourceUrl = elements.sourceUrl.value.trim();
  void ensureLogin(isLikelyXiaoeUrl(sourceUrl) ? sourceUrl : '').catch((error) => {
    renderAuthStatus({ status: 'logged-out', message: error.message });
  });
});
elements.closeSetupButton.addEventListener('click', closeSetup);
elements.doneSetupButton.addEventListener('click', closeSetup);
elements.logoutButton.addEventListener('click', async () => {
  if (window.confirm('退出后，下次处理视频需要重新微信扫码。确定退出吗？')) {
    await window.xiaoeApp.logout();
    elements.downloadDetail.textContent = '小鹅通登录状态已清除。';
    renderAuthStatus({ status: 'logged-out', message: '小鹅通登录已退出。' });
  }
});
elements.runtimeButton.addEventListener('click', () => window.xiaoeApp.openVcRuntimeDownload());
elements.openResultButton.addEventListener('click', () => {
  if (state.resultDirectory) window.xiaoeApp.openPath(state.resultDirectory);
});
let loginCheckTimer = null;
elements.sourceUrl.addEventListener('input', () => {
  elements.sourceUrl.classList.remove('invalid');
  if (loginCheckTimer) clearTimeout(loginCheckTimer);
  const sourceUrl = elements.sourceUrl.value.trim();
  if (!isLikelyXiaoeUrl(sourceUrl) || state.busy) return;
  loginCheckTimer = setTimeout(() => {
    void ensureLogin(sourceUrl).catch((error) => {
      renderAuthStatus({ status: 'logged-out', message: error.message });
    });
  }, 700);
});

initialize().catch((error) => setProgress(0, `应用初始化失败：${error.message}`, 'error'));
