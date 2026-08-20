const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xiaoeApp', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  chooseOutputDirectory: () => ipcRenderer.invoke('settings:choose-output-directory'),
  chooseModelDirectory: () => ipcRenderer.invoke('settings:choose-model-directory'),
  selectModel: (modelId) => ipcRenderer.invoke('settings:select-model', modelId),
  installDependencies: (modelId) => ipcRenderer.invoke('dependencies:install', { modelId }),
  removeModel: (modelId) => ipcRenderer.invoke('dependencies:remove-model', { modelId }),
  getDependencyStatus: () => ipcRenderer.invoke('dependencies:status'),
  startJob: (sourceUrl) => ipcRenderer.invoke('job:start', { sourceUrl }),
  cancelJob: () => ipcRenderer.invoke('job:cancel'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  listHistory: () => ipcRenderer.invoke('history:list'),
  openHistory: (id) => ipcRenderer.invoke('history:open', id),
  setAuthViewBounds: (bounds) => ipcRenderer.invoke('auth:set-view-bounds', bounds),
  startupLogin: (sourceUrl) => ipcRenderer.invoke('auth:startup-login', { sourceUrl }),
  ensureLogin: (sourceUrl) => ipcRenderer.invoke('auth:ensure-login', { sourceUrl }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  installVcRuntime: () => ipcRenderer.invoke('system:install-vc-runtime'),
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
