const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xiaoeApp', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseOutputDirectory: () => ipcRenderer.invoke('settings:choose-output-directory'),
  chooseModelDirectory: () => ipcRenderer.invoke('settings:choose-model-directory'),
  selectModel: (modelId) => ipcRenderer.invoke('settings:select-model', modelId),
  selectSummaryModel: (modelId) => ipcRenderer.invoke('settings:select-summary-model', modelId),
  setCompletionSound: (enabled) => ipcRenderer.invoke('settings:set-completion-sound', enabled),
  installDependencies: (modelId, kind) => ipcRenderer.invoke('dependencies:install', { modelId, kind }),
  pauseDependencies: (modelId, kind) => ipcRenderer.invoke('dependencies:pause-install', { modelId, kind }),
  cancelDependencies: (modelId, kind) => ipcRenderer.invoke('dependencies:cancel-install', { modelId, kind }),
  removeModel: (modelId, kind) => ipcRenderer.invoke('dependencies:remove-model', { modelId, kind }),
  getDependencyStatus: () => ipcRenderer.invoke('dependencies:status'),
  startJob: (sourceUrl) => ipcRenderer.invoke('job:start', { sourceUrl }),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  listHistory: () => ipcRenderer.invoke('history:list'),
  openHistory: (id) => ipcRenderer.invoke('history:open', id),
  setAuthViewBounds: (bounds) => ipcRenderer.invoke('auth:set-view-bounds', bounds),
  startupLogin: () => ipcRenderer.invoke('auth:startup-login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  installVcRuntime: () => ipcRenderer.invoke('system:install-vc-runtime'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onVcRuntimeProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('system:vc-runtime-progress', listener);
    return () => ipcRenderer.removeListener('system:vc-runtime-progress', listener);
  },
  onJobProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
  onDependencyProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('dependencies:progress', listener);
    return () => ipcRenderer.removeListener('dependencies:progress', listener);
  },
  onAuthStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('auth:status', listener);
    return () => ipcRenderer.removeListener('auth:status', listener);
  }
});
