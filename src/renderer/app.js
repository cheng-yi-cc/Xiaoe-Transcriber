const elements = {
  loginGate: document.querySelector('#loginGate'),
  appShell: document.querySelector('#appShell'),
  particleCanvas: document.querySelector('#particleCanvas'),
  authPanel: document.querySelector('.auth-panel'),
  authChecking: document.querySelector('#authChecking'),
  authCheckingMessage: document.querySelector('#authCheckingMessage'),
  authLinkForm: document.querySelector('#authLinkForm'),
  authSourceUrl: document.querySelector('#authSourceUrl'),
  authLinkMessage: document.querySelector('#authLinkMessage'),
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
  modelPath: document.querySelector('#modelPath'),
  outputPath: document.querySelector('#outputPath'),
  chooseModelButton: document.querySelector('#chooseModelButton'),
  chooseOutputButton: document.querySelector('#chooseOutputButton'),
  prerequisitePanel: document.querySelector('#prerequisitePanel'),
  prerequisiteMessage: document.querySelector('#prerequisiteMessage'),
  runtimeButton: document.querySelector('#runtimeButton'),
  downloadSummaryLabel: document.querySelector('#downloadSummaryLabel'),
  downloadSize: document.querySelector('#downloadSize'),
  downloadSummaryDetail: document.querySelector('#downloadSummaryDetail'),
  downloadProgress: document.querySelector('#downloadProgress'),
  downloadLabel: document.querySelector('#downloadLabel'),
  downloadPercent: document.querySelector('#downloadPercent'),
  downloadBar: document.querySelector('#downloadBar'),
  downloadDetail: document.querySelector('#downloadDetail'),
  toast: document.querySelector('#toast')
};

const state = {
  app: null,
  authStatus: 'unknown',
  busy: false,
  installing: false,
  installTargetModelId: null,
  modelOperation: null,
  resultDirectory: null,
  currentPage: 'workspace'
};

const stageOrder = ['capture', 'download', 'transcribe', 'summarize'];
let toastTimer = null;

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
  elements.authLinkForm.classList.toggle('hidden', name !== 'link');
  elements.authQrState.classList.toggle('hidden', name !== 'qr');
  if (name === 'checking' && message) elements.authCheckingMessage.textContent = message;
  if (name === 'link') requestAnimationFrame(() => elements.authSourceUrl.focus());
  if (name === 'qr') requestAnimationFrame(syncAuthViewBounds);
}

function renderAuthStatus(event = {}) {
  const status = event.status || 'unknown';
  state.authStatus = status;
  if (status === 'logged-in') {
    enterApplication();
  } else if (status === 'logged-out') {
    showAuthState('qr');
  } else if (status === 'needs-link') {
    showAuthState('link');
  } else {
    showAuthState('checking', event.message || '正在确认小鹅通登录状态…');
  }
}

async function startStartupLogin(sourceUrl) {
  showAuthState('checking', '正在打开小鹅通页面并确认登录状态…');
  const result = await window.xiaoeApp.startupLogin(sourceUrl || undefined);
  if (result.error) {
    showAuthState('link');
    elements.authLinkMessage.textContent = result.error;
    elements.authLinkMessage.classList.add('error');
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
  const lastSourceUrl = state.app?.settings?.lastSourceUrl || '';
  elements.authSourceUrl.value = lastSourceUrl;
  if (lastSourceUrl) void startStartupLogin(lastSourceUrl);
  else showAuthState('link');
}

function modelById(modelId) {
  return state.app?.dependencies?.models?.find((model) => model.id === modelId) || null;
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

function renderModels() {
  const { dependencies, gpu, system } = state.app;
  const selectedId = dependencies.selectedModelId;
  for (const row of elements.modelRows) {
    const model = modelById(row.dataset.model);
    const input = row.querySelector('input');
    const status = row.querySelector('[data-model-status]');
    const primaryButton = row.querySelector('[data-model-primary]');
    const removeButton = row.querySelector('[data-model-remove]');
    const selected = model?.id === selectedId && model?.ready;
    const recommended = model?.id === system.recommendedModelId;
    const incompatible = gpu.supported && gpu.memoryMb < (model?.minimumVramMb || 0);
    const operationTarget = state.installing && state.installTargetModelId === model?.id;
    input.checked = selected;
    input.disabled = !model?.ready || state.installing || state.busy;
    row.classList.toggle('selected', selected);
    row.classList.toggle('incompatible', incompatible);
    const labels = [];
    if (selected) labels.push('使用中');
    else if (model?.modelInstalled) labels.push('已安装');
    if (recommended) labels.push('推荐');
    if (incompatible) labels.push('显存不足');
    status.textContent = labels.join(' · ') || model?.suitability || '';

    if (operationTarget) {
      primaryButton.textContent = state.modelOperation === 'remove' ? '删除中' : '下载中';
    } else if (selected) {
      primaryButton.textContent = '使用中';
    } else if (model?.ready) {
      primaryButton.textContent = '使用';
    } else if (model?.modelInstalled) {
      primaryButton.textContent = '完成安装';
    } else {
      primaryButton.textContent = '下载';
    }
    primaryButton.disabled = selected || state.installing || state.busy || !gpu.supported || !state.app.vcRuntime.supported;
    removeButton.classList.toggle('hidden', !model?.modelInstalled || selected);
    removeButton.disabled = state.installing || state.busy;
  }
}

function renderDownloadState() {
  const { dependencies } = state.app;
  const installedCount = dependencies.models.filter((model) => model.modelInstalled).length;
  const selected = modelById(dependencies.selectedModelId);
  if (state.installing) {
    const target = modelById(state.installTargetModelId);
    elements.downloadSummaryLabel.textContent = state.modelOperation === 'remove' ? '正在删除' : '正在下载';
    elements.downloadSize.textContent = target?.label || '模型处理中';
    elements.downloadSummaryDetail.textContent = state.modelOperation === 'remove'
      ? '只删除这个转写模型，共用引擎与其他模型会保留。'
      : '下载完成后会校验 SHA-256，并运行本地引擎自检。';
  } else {
    elements.downloadSummaryLabel.textContent = '本地模型';
    elements.downloadSize.textContent = `${installedCount} / ${dependencies.models.length} 已安装`;
    elements.downloadSummaryDetail.textContent = dependencies.ready
      ? `当前使用 ${selected?.label || '本地模型'}；共用引擎与总结模型继续复用。`
      : '下载一个模型后即可开始转写；共用引擎与总结模型只下载一次。';
  }
  elements.startButton.disabled = state.busy || !dependencies.ready;
  elements.taskNote.textContent = dependencies.ready
    ? `${dependencies.selectedModel?.label || '本地模型'} 已就绪 · 处理时保持静音`
    : '尚未安装所选模型 · 请前往设置下载';
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
  if (!elements.authSourceUrl.value && appState.settings.lastSourceUrl) elements.authSourceUrl.value = appState.settings.lastSourceUrl;
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
  elements.chooseModelButton.disabled = busy || state.installing;
  elements.chooseOutputButton.disabled = busy || state.installing;
  for (const button of elements.navButtons) button.disabled = busy;
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

async function installDependencies(modelId) {
  const model = modelById(modelId);
  state.installing = true;
  state.installTargetModelId = modelId;
  state.modelOperation = 'download';
  elements.downloadProgress.classList.remove('hidden');
  elements.downloadLabel.textContent = '准备下载';
  elements.downloadPercent.textContent = '0%';
  elements.downloadBar.style.width = '0%';
  elements.chooseModelButton.disabled = true;
  elements.chooseOutputButton.disabled = true;
  renderModels();
  renderDownloadState();
  try {
    const dependencies = await window.xiaoeApp.installDependencies(modelId);
    state.app.dependencies = dependencies;
    state.app.settings.selectedModelId = dependencies.selectedModelId;
    elements.downloadLabel.textContent = '模型与引擎已就绪';
    elements.downloadPercent.textContent = '100%';
    elements.downloadBar.style.width = '100%';
    elements.downloadDetail.textContent = '完整性检查与本地引擎自检均已通过。';
    showToast(`${model?.label || '模型'} 安装完成`);
  } catch (error) {
    elements.downloadDetail.textContent = error.message || String(error);
    showToast('模型安装未完成');
  } finally {
    state.installing = false;
    state.installTargetModelId = null;
    state.modelOperation = null;
    elements.chooseModelButton.disabled = false;
    elements.chooseOutputButton.disabled = false;
    renderModels();
    renderDownloadState();
  }
}

async function removeModel(modelId) {
  const model = modelById(modelId);
  if (!model?.modelInstalled) return;
  const confirmed = window.confirm(
    `删除 ${model.label}？\n\n将释放约 ${formatBytes(model.downloadBytes)}，共用引擎和其他模型会保留。`
  );
  if (!confirmed) return;

  state.installing = true;
  state.installTargetModelId = modelId;
  state.modelOperation = 'remove';
  elements.downloadProgress.classList.add('hidden');
  elements.chooseModelButton.disabled = true;
  elements.chooseOutputButton.disabled = true;
  renderModels();
  renderDownloadState();
  try {
    const dependencies = await window.xiaoeApp.removeModel(modelId);
    state.app.dependencies = dependencies;
    showToast(`${model.label} 已删除`);
  } catch (error) {
    showToast(error.message || String(error));
  } finally {
    state.installing = false;
    state.installTargetModelId = null;
    state.modelOperation = null;
    elements.chooseModelButton.disabled = false;
    elements.chooseOutputButton.disabled = false;
    renderModels();
    renderDownloadState();
  }
}

function handleDependencyProgress(event) {
  const percent = event.totalBytes
    ? Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100))
    : 0;
  elements.downloadProgress.classList.remove('hidden');
  elements.downloadPercent.textContent = `${percent}%`;
  elements.downloadBar.style.width = `${percent}%`;
  if (event.phase === 'skip') elements.downloadLabel.textContent = `已存在：${event.component.label}`;
  else if (event.phase === 'extract') elements.downloadLabel.textContent = `正在解压：${event.component.label}`;
  else if (event.component) elements.downloadLabel.textContent = `正在下载：${event.component.label}`;
  elements.downloadDetail.textContent = `${formatBytes(event.completedBytes)} / ${formatBytes(event.totalBytes)}`;
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
      showAuthState('link');
      document.body.dataset.ready = 'true';
    } else {
      enterApplication(appState.screenshotPage || 'workspace');
    }
  } else if (appState.settings.lastSourceUrl) {
    await startStartupLogin(appState.settings.lastSourceUrl);
  } else {
    showAuthState('link');
  }
}

elements.authLinkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const sourceUrl = elements.authSourceUrl.value.trim();
  if (!isLikelyXiaoeUrl(sourceUrl)) {
    elements.authSourceUrl.classList.add('invalid');
    elements.authLinkMessage.textContent = '请输入有效的小鹅通 HTTPS 视频播放页链接。';
    elements.authLinkMessage.classList.add('error');
    return;
  }
  elements.authSourceUrl.classList.remove('invalid');
  elements.authLinkMessage.classList.remove('error');
  state.app.settings.lastSourceUrl = sourceUrl;
  elements.sourceUrl.value = sourceUrl;
  void startStartupLogin(sourceUrl);
});
elements.authSourceUrl.addEventListener('input', () => {
  elements.authSourceUrl.classList.remove('invalid');
  elements.authLinkMessage.textContent = '链接只保存在这台电脑上。';
  elements.authLinkMessage.classList.remove('error');
});
for (const button of elements.navButtons) button.addEventListener('click', () => showPage(button.dataset.pageTarget));
for (const row of elements.modelRows) {
  const modelId = row.dataset.model;
  row.querySelector('input').addEventListener('change', (event) => void selectModel(event.target.value));
  row.querySelector('[data-model-primary]').addEventListener('click', () => {
    if (modelById(modelId)?.ready) void selectModel(modelId);
    else void installDependencies(modelId);
  });
  row.querySelector('[data-model-remove]').addEventListener('click', () => void removeModel(modelId));
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
  showAuthState('link');
  elements.authLinkMessage.textContent = `应用初始化失败：${error.message}`;
  elements.authLinkMessage.classList.add('error');
  document.body.dataset.ready = 'true';
});
