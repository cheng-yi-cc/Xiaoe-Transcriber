const elements = {
  loginGate: document.querySelector('#loginGate'),
  appShell: document.querySelector('#appShell'),
  particleCanvas: document.querySelector('#particleCanvas'),
  authPanel: document.querySelector('.auth-panel'),
  authChecking: document.querySelector('#authChecking'),
  authCheckingMessage: document.querySelector('#authCheckingMessage'),
  authErrorState: document.querySelector('#authErrorState'),
  authErrorMessage: document.querySelector('#authErrorMessage'),
  authRetryButton: document.querySelector('#authRetryButton'),
  authQrState: document.querySelector('#authQrState'),
  authViewSlot: document.querySelector('#authViewSlot'),
  pageLabel: document.querySelector('#pageLabel'),
  workspacePage: document.querySelector('#workspacePage'),
  settingsPage: document.querySelector('#settingsPage'),
  navButtons: [...document.querySelectorAll('[data-page-target]')],
  logoutButton: document.querySelector('#logoutButton'),
  sourceUrl: document.querySelector('#sourceUrl'),
  clearUrlButton: document.querySelector('#clearUrlButton'),
  urlHint: document.querySelector('#urlHint'),
  startButton: document.querySelector('#startButton'),
  cancelButton: document.querySelector('#cancelButton'),
  taskNote: document.querySelector('#taskNote'),
  taskModelStrip: document.querySelector('#taskModelStrip'),
  taskModelContext: document.querySelector('#taskModelContext'),
  taskTranscribeModel: document.querySelector('#taskTranscribeModel'),
  taskSummaryModel: document.querySelector('#taskSummaryModel'),
  jobPanel: document.querySelector('#jobPanel'),
  progressNumber: document.querySelector('#progressNumber'),
  progressBar: document.querySelector('#progressBar'),
  progressMessage: document.querySelector('#progressMessage'),
  stageList: document.querySelector('#stageList'),
  jobResult: document.querySelector('#jobResult'),
  resultTitle: document.querySelector('#resultTitle'),
  resultPath: document.querySelector('#resultPath'),
  openResultButton: document.querySelector('#openResultButton'),
  historyList: document.querySelector('#historyList'),
  gpuName: document.querySelector('#gpuName'),
  gpuMemory: document.querySelector('#gpuMemory'),
  systemName: document.querySelector('#systemName'),
  hardwareState: document.querySelector('#hardwareState'),
  modelRows: [...document.querySelectorAll('[data-model]')],
  summaryRows: [...document.querySelectorAll('[data-summary-model]')],
  modelPath: document.querySelector('#modelPath'),
  outputPath: document.querySelector('#outputPath'),
  chooseModelButton: document.querySelector('#chooseModelButton'),
  chooseOutputButton: document.querySelector('#chooseOutputButton'),
  settingsJobNotice: document.querySelector('#settingsJobNotice'),
  prerequisitePanel: document.querySelector('#prerequisitePanel'),
  prerequisiteMessage: document.querySelector('#prerequisiteMessage'),
  runtimeButton: document.querySelector('#runtimeButton'),
  toast: document.querySelector('#toast')
};

const state = {
  app: null,
  authStatus: 'unknown',
  busy: false,
  installs: new Map(),
  resultDirectory: null,
  activeJobModels: null,
  currentPage: 'workspace'
};

const stageOrder = ['capture', 'download', 'transcribe', 'summarize'];
const settledInstallPhases = ['error', 'paused', 'cancelled'];
let toastTimer = null;
let lastModelAction = { key: '', at: 0 };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const digits = index >= 3 ? 1 : 0;
  return `${(bytes / (1024 ** index)).toFixed(digits)} ${units[index]}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 2600);
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

function syncAuthViewBounds() {
  if (elements.authQrState.classList.contains('hidden') || elements.loginGate.classList.contains('hidden')) return;
  const rect = elements.authViewSlot.getBoundingClientRect();
  void window.xiaoeApp.setAuthViewBounds({
    x: rect.x + 1,
    y: rect.y + 1,
    width: Math.max(1, rect.width - 2),
    height: Math.max(1, rect.height - 2)
  });
}

function showAuthState(name, message = '') {
  elements.authChecking.classList.toggle('hidden', name !== 'checking');
  elements.authErrorState.classList.toggle('hidden', name !== 'error');
  elements.authQrState.classList.toggle('hidden', name !== 'qr');
  if (name === 'checking' && message) elements.authCheckingMessage.textContent = message;
  if (name === 'error' && message) elements.authErrorMessage.textContent = message;
  if (name === 'qr') requestAnimationFrame(syncAuthViewBounds);
}

function renderAuthStatus(event = {}) {
  const status = event.status || 'unknown';
  state.authStatus = status;
  if (status === 'logged-in') {
    enterApplication();
  } else if (status === 'logged-out') {
    showAuthState('qr');
  } else {
    showAuthState('checking', event.message || '正在确认小鹅通登录状态…');
  }
}

async function startStartupLogin() {
  showAuthState('checking', '正在打开账号学习中心并确认登录状态…');
  const result = await window.xiaoeApp.startupLogin();
  if (result.error) {
    showAuthState('error', result.error);
    return;
  }
  renderAuthStatus(result);
}

function showPage(name) {
  state.currentPage = name;
  elements.workspacePage.classList.toggle('hidden', name !== 'workspace');
  elements.settingsPage.classList.toggle('hidden', name !== 'settings');
  elements.pageLabel.textContent = name === 'settings' ? '设置 / 本地模型' : '工作台 / 新任务';
  for (const button of elements.navButtons) {
    if (button.dataset.pageTarget === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function enterApplication(preferredPage) {
  if (!state.app || !elements.appShell.classList.contains('hidden')) return;
  particleScene.mode = 'scatter';
  const page = preferredPage || (state.app.dependencies.ready ? 'workspace' : 'settings');
  setTimeout(() => {
    elements.loginGate.classList.add('hidden');
    elements.appShell.classList.remove('hidden');
    showPage(page);
    document.body.dataset.ready = 'true';
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360);
}

function showLoginGate() {
  elements.appShell.classList.add('hidden');
  elements.loginGate.classList.remove('hidden');
  particleScene.mode = 'assemble';
  particleScene.resize();
  void startStartupLogin();
}

function modelById(modelId) {
  return state.app?.dependencies?.models?.find((model) => model.id === modelId) || null;
}

function summaryModelById(modelId) {
  return state.app?.dependencies?.summaryModels?.find((model) => model.id === modelId) || null;
}

function modelOfKind(kind, modelId) {
  return kind === 'summary' ? summaryModelById(modelId) : modelById(modelId);
}

function selectedIdForKind(kind) {
  return kind === 'summary'
    ? state.app?.dependencies?.selectedSummaryModelId
    : state.app?.dependencies?.selectedModelId;
}

function installKeyOf(kind, modelId) {
  return `${kind}:${modelId}`;
}

function activeInstall(kind, modelId) {
  const install = state.installs.get(installKeyOf(kind, modelId));
  return install && !settledInstallPhases.includes(install.phase) ? install : null;
}

function isInstallingAny() {
  for (const install of state.installs.values()) {
    if (!settledInstallPhases.includes(install.phase)) return true;
  }
  return false;
}

function modelUsedByActiveJob(kind, modelId) {
  if (!state.busy || !state.activeJobModels) return false;
  const activeModel = kind === 'summary'
    ? state.activeJobModels.summary
    : state.activeJobModels.transcribe;
  return activeModel?.id === modelId;
}

function renderTaskModels() {
  const dependencies = state.app?.dependencies;
  if (!dependencies) return;
  const configured = {
    transcribe: modelById(dependencies.selectedModelId),
    summary: summaryModelById(dependencies.selectedSummaryModelId)
  };
  const displayed = state.busy && state.activeJobModels ? state.activeJobModels : configured;
  elements.taskModelContext.textContent = state.busy ? '本次任务' : '当前设置';
  elements.taskTranscribeModel.textContent = displayed.transcribe?.label || '尚未选择';
  elements.taskSummaryModel.textContent = displayed.summary?.label || '尚未选择';
  elements.taskModelStrip.classList.toggle('active-task', state.busy);
}

function renderPrerequisites() {
  const { gpu, vcRuntime, dependencies } = state.app;
  let message = '';
  let showRuntime = false;
  if (!gpu.supported) message = gpu.detail || '未检测到可用的 NVIDIA 显卡或驱动。';
  else if (!vcRuntime.supported) {
    message = vcRuntime.detail || '需要 Microsoft Visual C++ 2015–2022 x64 运行库。';
    showRuntime = true;
  } else if (dependencies.runtimeError) message = dependencies.runtimeError;
  elements.prerequisitePanel.classList.toggle('hidden', !message);
  elements.prerequisiteMessage.textContent = message;
  elements.runtimeButton.classList.toggle('hidden', !showRuntime);
}

function renderModelRow(row, kind) {
  const modelId = kind === 'summary' ? row.dataset.summaryModel : row.dataset.model;
  const model = modelOfKind(kind, modelId);
  const { gpu, system } = state.app;
  const input = row.querySelector('input');
  const status = row.querySelector('[data-model-status]');
  const removeButton = row.querySelector('[data-model-remove]');
  const pauseButton = row.querySelector('[data-model-pause]');
  const resumeButton = row.querySelector('[data-model-resume]');
  const cancelButton = row.querySelector('[data-model-cancel]');
  const install = state.installs.get(installKeyOf(kind, modelId)) || null;
  const working = Boolean(install) && !settledInstallPhases.includes(install.phase);
  const paused = install?.phase === 'paused';
  const failed = Boolean(install) && install.phase === 'error';
  const selected = model?.id === selectedIdForKind(kind) && model?.ready;
  const usedByActiveJob = modelUsedByActiveJob(kind, modelId);
  const recommended = model?.id === (kind === 'summary' ? system.recommendedSummaryModelId : system.recommendedModelId);
  const incompatible = gpu.supported && gpu.memoryMb < (model?.minimumVramMb || 0);
  input.checked = selected;
  input.disabled = working;
  row.classList.toggle('selected', selected);
  row.classList.toggle('incompatible', incompatible);
  row.classList.toggle('installing', working);
  row.classList.toggle('has-error', failed);

  if (working) {
    status.textContent = install.status || '下载中…';
  } else if (failed) {
    status.textContent = '下载失败';
  } else if (paused) {
    status.textContent = install.status || '已暂停';
  } else {
    const labels = [];
    if (selected) labels.push('使用中');
    else if (model?.modelInstalled) labels.push('已安装');
    if (usedByActiveJob && !selected) labels.push('本次任务正在使用');
    if (recommended && !selected) labels.push('推荐');
    if (incompatible) labels.push('显存不足');
    status.textContent = labels.join(' · ') || model?.suitability || '';
  }

  const progressBox = row.querySelector('[data-model-progress]');
  progressBox.classList.toggle('hidden', !install);
  if (install) {
    row.querySelector('[data-model-progress-bar]').style.width = `${install.percent || 0}%`;
    row.querySelector('[data-model-progress-detail]').textContent = install.detail || '';
  }

  pauseButton.classList.toggle('hidden', !working);
  resumeButton.classList.toggle('hidden', !paused);
  cancelButton.classList.toggle('hidden', !working && !paused);
  removeButton.classList.toggle('hidden', !model?.modelInstalled || selected);
  removeButton.disabled = usedByActiveJob || isInstallingAny();
  removeButton.title = usedByActiveJob ? '本次任务完成后可删除' : '';
}

function renderModels() {
  for (const row of elements.modelRows) renderModelRow(row, 'transcribe');
  for (const row of elements.summaryRows) renderModelRow(row, 'summary');
}

function renderDownloadState() {
  const { dependencies } = state.app;
  elements.startButton.disabled = state.busy || !dependencies.ready;
  elements.chooseModelButton.disabled = isInstallingAny();
  elements.chooseOutputButton.disabled = false;
  elements.taskNote.textContent = dependencies.ready
    ? '模型已就绪 · 处理时保持静音'
    : '尚未安装所选模型 · 请前往设置下载';
  renderTaskModels();
}

function renderHardware() {
  const { gpu, system } = state.app;
  elements.gpuName.textContent = gpu.supported ? gpu.name : '未检测到 NVIDIA GPU';
  elements.gpuMemory.textContent = gpu.supported ? gpu.memory : '—';
  elements.systemName.textContent = `${system.totalMemoryGb} GB · ${system.platform}`;
  elements.hardwareState.textContent = gpu.supported ? '已完成检测' : '需要 NVIDIA GPU';
}

function renderHistory(entries = []) {
  elements.historyList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '完成第一个转写任务后，记录会显示在这里。';
    elements.historyList.appendChild(empty);
    return;
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    const copy = document.createElement('span');
    const title = document.createElement('b');
    title.textContent = entry.title;
    const url = document.createElement('small');
    url.textContent = entry.sourceUrl;
    copy.append(title, url);
    const time = document.createElement('time');
    time.dateTime = entry.completedAt;
    time.textContent = formatter.format(new Date(entry.completedAt));
    const action = document.createElement('i');
    action.textContent = '打开文件夹';
    button.append(copy, time, action);
    button.addEventListener('click', async () => {
      const error = await window.xiaoeApp.openHistory(entry.id);
      if (error) showToast(error);
    });
    elements.historyList.appendChild(button);
  }
}

function renderAppState(appState) {
  state.app = appState;
  elements.modelPath.textContent = appState.settings.modelDirectory;
  elements.modelPath.title = appState.settings.modelDirectory;
  elements.outputPath.textContent = appState.settings.outputDirectory;
  elements.outputPath.title = appState.settings.outputDirectory;
  if (!elements.sourceUrl.value && appState.settings.lastSourceUrl) elements.sourceUrl.value = appState.settings.lastSourceUrl;
  renderHardware();
  renderPrerequisites();
  renderModels();
  renderDownloadState();
  renderHistory(appState.history);
}

function setProgress(percent, message, stage) {
  const normalized = Math.max(0, Math.min(100, Number(percent) || 0));
  elements.progressNumber.textContent = `${String(Math.round(normalized)).padStart(2, '0')}%`;
  elements.progressBar.style.width = `${normalized}%`;
  elements.progressMessage.textContent = message || '处理中…';
  const normalizedStage = stage === 'audio' ? 'download' : stage;
  const activeIndex = stageOrder.indexOf(normalizedStage);
  for (const item of elements.stageList.querySelectorAll('li')) {
    const index = stageOrder.indexOf(item.dataset.stage);
    item.classList.toggle('active', state.busy && index === activeIndex);
    item.classList.toggle('done', normalized >= 100 || (activeIndex >= 0 && index < activeIndex));
  }
}

function setBusy(busy) {
  state.busy = busy;
  elements.jobPanel.classList.toggle('running', busy);
  elements.cancelButton.classList.toggle('hidden', !busy);
  elements.clearUrlButton.disabled = busy;
  elements.sourceUrl.disabled = busy;
  elements.settingsJobNotice.classList.toggle('hidden', !busy);
  renderModels();
  renderDownloadState();
}

async function refreshHistory() {
  const entries = await window.xiaoeApp.listHistory();
  state.app.history = entries;
  renderHistory(entries);
}

async function startJob() {
  const sourceUrl = elements.sourceUrl.value.trim();
  if (!isLikelyXiaoeUrl(sourceUrl)) {
    elements.sourceUrl.classList.add('invalid');
    elements.urlHint.textContent = '请输入有效的小鹅通 HTTPS 单视频播放页链接。';
    elements.urlHint.classList.add('error');
    return;
  }
  if (!state.app.dependencies.ready) {
    showPage('settings');
    showToast('请先下载并安装所选模型');
    return;
  }
  elements.sourceUrl.classList.remove('invalid');
  elements.urlHint.classList.remove('error');
  elements.urlHint.textContent = '只处理能够正常回放的内容；检测到 DRM 或加密 HLS 时会停止。';
  elements.jobResult.classList.add('hidden');
  state.resultDirectory = null;
  state.activeJobModels = {
    transcribe: modelById(state.app.dependencies.selectedModelId),
    summary: summaryModelById(state.app.dependencies.selectedSummaryModelId)
  };
  setBusy(true);
  setProgress(1, '正在创建任务…', 'capture');
  try {
    const result = await window.xiaoeApp.startJob(sourceUrl);
    state.resultDirectory = result.resultDirectory;
    elements.resultTitle.textContent = '两份文档已生成';
    elements.resultPath.textContent = result.resultDirectory;
    elements.jobResult.classList.remove('hidden');
    setProgress(100, '总结和完整文字稿已生成。', 'complete');
    await refreshHistory();
  } catch (error) {
    setProgress(0, error.message || String(error), 'error');
  } finally {
    setBusy(false);
    state.activeJobModels = null;
    renderTaskModels();
  }
}

function handleJobProgress(event) {
  if (event.resultDirectory) state.resultDirectory = event.resultDirectory;
  setProgress(event.percent, event.message, event.stage);
  if (event.stage === 'complete') {
    elements.resultTitle.textContent = '两份文档已生成';
    elements.resultPath.textContent = event.resultDirectory;
    elements.jobResult.classList.remove('hidden');
  } else if (event.stage === 'error' && event.transcriptPath && event.resultDirectory) {
    elements.resultTitle.textContent = '总结失败，完整文字稿已保留';
    elements.resultPath.textContent = event.resultDirectory;
    elements.jobResult.classList.remove('hidden');
    void refreshHistory();
  }
}

async function selectModel(modelId) {
  try {
    const dependencies = await window.xiaoeApp.selectModel(modelId);
    state.app.dependencies = dependencies;
    state.app.settings.selectedModelId = dependencies.selectedModelId;
    renderModels();
    renderDownloadState();
  } catch (error) {
    showToast(error.message || String(error));
    renderModels();
  }
}

async function selectSummaryModel(modelId) {
  try {
    const dependencies = await window.xiaoeApp.selectSummaryModel(modelId);
    state.app.dependencies = dependencies;
    state.app.settings.selectedSummaryModelId = dependencies.selectedSummaryModelId;
    renderModels();
    renderDownloadState();
  } catch (error) {
    showToast(error.message || String(error));
    renderModels();
  }
}

async function chooseDirectory(type) {
  try {
    const result = type === 'model'
      ? await window.xiaoeApp.chooseModelDirectory()
      : await window.xiaoeApp.chooseOutputDirectory();
    if (!result) return;
    const appState = await window.xiaoeApp.getState();
    renderAppState(appState);
  } catch (error) {
    showToast(error.message || String(error));
  }
}

async function installDependencies(modelId, kind = 'transcribe', { resume = false } = {}) {
  const key = installKeyOf(kind, modelId);
  if (activeInstall(kind, modelId)) return;
  const model = modelOfKind(kind, modelId);
  state.installs.set(key, resume
    ? { phase: 'prepare', percent: 0, status: '继续下载…', detail: '正在连接官方源，从已下载进度继续…' }
    : { phase: 'prepare', percent: 0, status: '准备下载…', detail: '正在连接官方源…' });
  renderModels();
  renderDownloadState();
  try {
    const dependencies = await window.xiaoeApp.installDependencies(modelId, kind);
    state.app.dependencies = dependencies;
    state.app.settings.selectedModelId = dependencies.selectedModelId;
    state.app.settings.selectedSummaryModelId = dependencies.selectedSummaryModelId;
    const endPhase = state.installs.get(key)?.phase;
    if (endPhase === 'complete') showToast(`${model?.label || '模型'} 安装完成`);
    else if (endPhase === 'cancelled') showToast('已取消下载，临时文件已清理');
  } catch (error) {
    showToast(error.message || String(error));
    try {
      state.app.dependencies = await window.xiaoeApp.getDependencyStatus();
    } catch {
      return;
    }
  } finally {
    const install = state.installs.get(key);
    if (!install || (install.phase !== 'error' && install.phase !== 'paused')) state.installs.delete(key);
    renderModels();
    renderDownloadState();
  }
}

async function pauseInstall(modelId, kind = 'transcribe') {
  try {
    await window.xiaoeApp.pauseDependencies(modelId, kind);
  } catch (error) {
    showToast(error.message || String(error));
  }
}

function resumeInstall(modelId, kind = 'transcribe') {
  return installDependencies(modelId, kind, { resume: true });
}

async function cancelInstall(modelId, kind = 'transcribe') {
  const model = modelOfKind(kind, modelId);
  const confirmed = window.confirm(`取消下载 ${model?.label || ''}？\n\n已下载的临时文件会被删除，之后需要重新下载。`);
  if (!confirmed) return;
  try {
    const result = await window.xiaoeApp.cancelDependencies(modelId, kind);
    if (result?.models) {
      state.app.dependencies = result;
      state.installs.delete(installKeyOf(kind, modelId));
      renderModels();
      renderDownloadState();
    }
  } catch (error) {
    showToast(error.message || String(error));
  }
}

async function removeModel(modelId, kind = 'transcribe') {
  const model = modelOfKind(kind, modelId);
  if (!model?.modelInstalled) return;
  if (activeInstall(kind, modelId)) {
    showToast('这个模型正在下载，暂时不能删除。');
    return;
  }
  if (isInstallingAny()) {
    showToast('有模型正在下载，暂时不能删除。');
    return;
  }
  const confirmed = window.confirm(
    `删除 ${model.label}？\n\n将释放约 ${formatBytes(model.downloadBytes)}，共用引擎和其他模型会保留。`
  );
  if (!confirmed) return;

  const key = installKeyOf(kind, modelId);
  state.installs.set(key, { phase: 'remove', percent: 0, status: '删除中…', detail: '只删除这个模型，共用引擎会保留。' });
  renderModels();
  renderDownloadState();
  try {
    const dependencies = await window.xiaoeApp.removeModel(modelId, kind);
    state.app.dependencies = dependencies;
    showToast(`${model.label} 已删除`);
  } catch (error) {
    showToast(error.message || String(error));
  } finally {
    state.installs.delete(key);
    renderModels();
    renderDownloadState();
  }
}

function installStatusText(phase, percent) {
  if (phase === 'prepare') return '准备下载…';
  if (phase === 'extract') return '正在解压…';
  if (phase === 'skip') return '跳过已就绪组件';
  if (phase === 'verifying') return '正在自检引擎…';
  if (phase === 'complete') return '即将完成…';
  if (phase === 'paused') return `已暂停 ${percent}%`;
  return `下载中 ${percent}%`;
}

function installDetailText(event) {
  if (event.phase === 'error') return event.message || '下载失败';
  if (event.phase === 'verifying') return '校验文件完整性并运行引擎自检';
  if (event.phase === 'skip') return `${event.componentLabel || ''} 已就绪`;
  if (event.phase === 'extract') return `正在解压：${event.componentLabel || ''}`;
  if (event.phase === 'download') {
    return `${event.componentLabel || ''} · ${formatBytes(event.completedBytes)} / ${formatBytes(event.totalBytes)}`;
  }
  return '';
}

function handleDependencyProgress(event) {
  const key = installKeyOf(event.kind, event.modelId);
  const install = state.installs.get(key);
  if (!install) return;
  if (event.phase === 'error') {
    install.phase = 'error';
    install.detail = installDetailText(event);
  } else if (event.phase === 'paused') {
    install.phase = 'paused';
    install.status = installStatusText('paused', install.percent || 0);
  } else if (event.phase === 'cancelled') {
    state.installs.delete(key);
  } else {
    install.phase = event.phase;
    if (event.totalBytes) {
      install.percent = Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100));
    }
    if (event.phase === 'complete') install.percent = 100;
    install.status = installStatusText(event.phase, install.percent || 0);
    install.detail = installDetailText(event);
  }
  renderModels();
  renderDownloadState();
}

async function installVcRuntime() {
  elements.runtimeButton.disabled = true;
  elements.runtimeButton.textContent = '正在下载安装…';
  try {
    await window.xiaoeApp.installVcRuntime();
    renderAppState(await window.xiaoeApp.getState());
    showToast('VC++ 运行库安装完成');
  } catch (error) {
    showToast(error.message || String(error));
  } finally {
    elements.runtimeButton.disabled = false;
    elements.runtimeButton.textContent = '安装 VC++ 运行库';
  }
}

const particleScene = (() => {
  const canvas = elements.particleCanvas;
  const context = canvas.getContext('2d');
  const particles = [];
  const image = new Image();
  const scene = {
    mode: 'assemble',
    mouse: { x: -1000, y: -1000 },
    resize() {
      const rect = elements.loginGate.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  };

  function geometry() {
    const loginRect = elements.loginGate.getBoundingClientRect();
    const panelRect = elements.authPanel.getBoundingClientRect();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const availableWidth = Math.max(320, panelRect.left - loginRect.left);
    const scale = Math.min(availableWidth * .78 / 360, height * .72 / 360);
    return {
      width,
      height,
      scale,
      baseX: Math.max(20, (availableWidth - 360 * scale) / 2),
      baseY: Math.max(82, (height - 360 * scale) / 2 + 16)
    };
  }

  function draw() {
    requestAnimationFrame(draw);
    if (elements.loginGate.classList.contains('hidden') || !particles.length) return;
    const { width, height, scale, baseX, baseY } = geometry();
    context.clearRect(0, 0, width, height);
    context.save();
    context.globalAlpha = .045;
    context.drawImage(image, baseX, baseY, 360 * scale, 360 * scale);
    context.restore();
    context.fillStyle = 'rgba(11,12,12,.76)';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const particle of particles) {
      const targetX = baseX + particle.ox * scale;
      const targetY = baseY + particle.oy * scale;
      if (reducedMotion) {
        particle.x = targetX;
        particle.y = targetY;
      } else if (scene.mode === 'scatter') {
        particle.vx += (Math.random() - .5) * .55;
        particle.vy += (Math.random() - .5) * .55;
      } else {
        particle.vx += (targetX - particle.x) * .055;
        particle.vy += (targetY - particle.y) * .055;
      }
      const dx = particle.x - scene.mouse.x;
      const dy = particle.y - scene.mouse.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (!reducedMotion && distance < 70) {
        const force = (70 - distance) / 70;
        particle.vx += (dx / Math.max(distance, 1)) * force * 1.6;
        particle.vy += (dy / Math.max(distance, 1)) * force * 1.6;
      }
      particle.vx *= .82;
      particle.vy *= .82;
      particle.x += particle.vx;
      particle.y += particle.vy;
      context.beginPath();
      context.arc(particle.x, particle.y, scale > 1 ? 1.15 : .85, 0, Math.PI * 2);
      context.fill();
    }
  }

  image.onload = () => {
    const offscreen = document.createElement('canvas');
    offscreen.width = 360;
    offscreen.height = 360;
    const offContext = offscreen.getContext('2d');
    offContext.drawImage(image, 0, 0, 360, 360);
    const pixels = offContext.getImageData(0, 0, 360, 360).data;
    for (let y = 0; y < 360; y += 2) {
      for (let x = 0; x < 360; x += 2) {
        if (pixels[(y * 360 + x) * 4 + 3] <= 80) continue;
        particles.push({ ox: x, oy: y, x: x + Math.random() * 80, y: y + Math.random() * 80, vx: 0, vy: 0 });
      }
    }
    scene.resize();
    requestAnimationFrame(draw);
  };
  image.src = '../../assets/avatar-particle.webp';
  elements.loginGate.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    scene.mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  });
  elements.loginGate.addEventListener('pointerleave', () => { scene.mouse = { x: -1000, y: -1000 }; });
  new ResizeObserver(() => scene.resize()).observe(elements.loginGate);
  return scene;
})();

async function initialize() {
  window.xiaoeApp.onAuthStatus(renderAuthStatus);
  window.xiaoeApp.onDependencyProgress(handleDependencyProgress);
  window.xiaoeApp.onJobProgress(handleJobProgress);
  window.xiaoeApp.onVcRuntimeProgress((event) => {
    if (event.phase === 'download') elements.runtimeButton.textContent = '正在下载运行库…';
    if (event.phase === 'elevate') elements.runtimeButton.textContent = '等待 UAC 授权…';
  });

  const appState = await window.xiaoeApp.getState();
  renderAppState(appState);
  if (!appState.auth.autoCheck) {
    if (appState.screenshotPage === 'login') {
      showAuthState('qr');
      document.body.dataset.ready = 'true';
    } else {
      enterApplication(appState.screenshotPage || 'workspace');
    }
  } else {
    await startStartupLogin();
  }
}

elements.authRetryButton.addEventListener('click', () => void startStartupLogin());
for (const button of elements.navButtons) button.addEventListener('click', () => showPage(button.dataset.pageTarget));

async function handleModelAction(kind, modelId) {
  if (activeInstall(kind, modelId)) return;
  const model = modelOfKind(kind, modelId);
  if (!model) return;
  if (state.installs.get(installKeyOf(kind, modelId))?.phase === 'paused') {
    await installDependencies(modelId, kind, { resume: true });
    return;
  }
  if (model.ready) {
    if (selectedIdForKind(kind) === modelId) return;
    if (kind === 'summary') await selectSummaryModel(modelId);
    else await selectModel(modelId);
    return;
  }
  if (model.modelInstalled) {
    await installDependencies(modelId, kind);
    return;
  }
  const confirmed = window.confirm(
    `下载 ${model.label}？\n\n需要下载约 ${formatBytes(model.downloadBytes)}，完成后会自动启用。`
  );
  if (!confirmed) {
    renderModels();
    return;
  }
  await installDependencies(modelId, kind);
}

function requestModelAction(kind, modelId) {
  const key = `${kind}:${modelId}`;
  const now = Date.now();
  if (lastModelAction.key === key && now - lastModelAction.at < 400) return;
  lastModelAction = { key, at: now };
  void handleModelAction(kind, modelId);
}

for (const row of [...elements.modelRows, ...elements.summaryRows]) {
  const kind = row.dataset.summaryModel ? 'summary' : 'transcribe';
  const modelId = row.dataset.summaryModel || row.dataset.model;
  row.addEventListener('click', (event) => {
    if (event.target.closest('[data-model-remove]')) return;
    if (event.target.closest('[data-model-action]')) return;
    requestModelAction(kind, modelId);
  });
  row.querySelector('input').addEventListener('change', () => requestModelAction(kind, modelId));
  row.querySelector('[data-model-remove]').addEventListener('click', () => void removeModel(modelId, kind));
  row.querySelector('[data-model-pause]').addEventListener('click', () => void pauseInstall(modelId, kind));
  row.querySelector('[data-model-resume]').addEventListener('click', () => void resumeInstall(modelId, kind));
  row.querySelector('[data-model-cancel]').addEventListener('click', () => void cancelInstall(modelId, kind));
}
elements.logoutButton.addEventListener('click', async () => {
  if (!window.confirm('退出后需要重新微信扫码才能进入应用。确定退出吗？')) return;
  await window.xiaoeApp.logout();
  showLoginGate();
});
elements.clearUrlButton.addEventListener('click', () => {
  elements.sourceUrl.value = '';
  elements.sourceUrl.focus();
});
elements.sourceUrl.addEventListener('input', () => {
  elements.sourceUrl.classList.remove('invalid');
  elements.urlHint.classList.remove('error');
  elements.urlHint.textContent = '只处理能够正常回放的内容；检测到 DRM 或加密 HLS 时会停止。';
});
elements.startButton.addEventListener('click', () => void startJob());
elements.cancelButton.addEventListener('click', () => void window.xiaoeApp.cancelJob());
elements.openResultButton.addEventListener('click', () => {
  if (state.resultDirectory) void window.xiaoeApp.openPath(state.resultDirectory);
});
elements.chooseModelButton.addEventListener('click', () => void chooseDirectory('model'));
elements.chooseOutputButton.addEventListener('click', () => void chooseDirectory('output'));
elements.runtimeButton.addEventListener('click', () => void installVcRuntime());
window.addEventListener('resize', () => requestAnimationFrame(syncAuthViewBounds));
new ResizeObserver(syncAuthViewBounds).observe(elements.authViewSlot);

initialize().catch((error) => {
  showAuthState('error', `应用初始化失败：${error.message}`);
  document.body.dataset.ready = 'true';
});
