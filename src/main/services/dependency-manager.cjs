const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { runProcess } = require('./process-runner.cjs');

function getModelOption(options, modelId) {
  const list = Array.isArray(options) ? options : [];
  return list.find((option) => option.id === modelId) || null;
}

function selectManifestForModel(manifest, modelId, summaryModelId) {
  const modelOption = getModelOption(manifest.modelOptions, modelId);
  const summaryOption = getModelOption(manifest.summaryOptions, summaryModelId);
  const components = manifest.components.filter((component) => (
    (!component.modelOptionId || component.modelOptionId === modelOption?.id)
    && (!component.summaryOptionId || component.summaryOptionId === summaryOption?.id)
  ));
  return {
    ...manifest,
    modelOption,
    summaryOption,
    estimatedInstalledBytes: modelOption?.estimatedInstalledBytes || manifest.estimatedInstalledBytes,
    components
  };
}

function chooseModelAfterInstall(activeModelId, activeModelReady, installedModelId) {
  return activeModelReady ? activeModelId : installedModelId;
}

function ensureWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('依赖文件路径超出了模型目录。');
  }
  return resolvedCandidate;
}

async function findFileRecursive(root, fileName) {
  if (!fs.existsSync(root)) return null;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileRecursive(path.join(root, entry.name), fileName);
    if (found) return found;
  }
  return null;
}

async function extractArchive(archivePath, destination, signal) {
  const script = path.join(__dirname, '..', 'scripts', 'extract-archive.ps1');
  await runProcess('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-ArchivePath', archivePath,
    '-Destination', destination
  ], { signal });
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function reusableByteCount(filePath, expectedSize) {
  try {
    const stats = await fsp.stat(filePath);
    if (stats.size <= expectedSize) return stats.size;
    await fsp.rm(filePath, { force: true });
  } catch {
    return 0;
  }
  return 0;
}

async function absorbFileBytes(filePath, byteCount, hash) {
  if (byteCount <= 0) return;
  const stream = fs.createReadStream(filePath, { start: 0, end: byteCount - 1 });
  for await (const chunk of stream) hash.update(chunk);
}

class DependencyManager {
  constructor({ rootDirectory, manifest, fetchImpl = globalThis.fetch }) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.manifest = manifest;
    this.fetchImpl = fetchImpl;
    this.totalDownloadBytes = manifest.components
      .flatMap((component) => component.downloads)
      .reduce((sum, download) => sum + download.size, 0);
  }

  componentDirectory(componentId) {
    return ensureWithin(this.rootDirectory, path.join(this.rootDirectory, 'components', componentId));
  }

  stagingDirectory(componentId) {
    return ensureWithin(this.rootDirectory, path.join(this.rootDirectory, 'components', `${componentId}.staging`));
  }

  async discardStagedComponent(componentId) {
    await fsp.rm(this.stagingDirectory(componentId), { recursive: true, force: true });
  }

  markerPath(componentId) {
    return path.join(this.componentDirectory(componentId), '.installed.json');
  }

  async getStatus() {
    const components = [];
    for (const component of this.manifest.components) {
      const directory = this.componentDirectory(component.id);
      let marker = null;
      try {
        marker = JSON.parse(await fsp.readFile(this.markerPath(component.id), 'utf8'));
      } catch {
        marker = null;
      }
      let ready = marker?.version === component.version;
      const files = {};
      if (ready) {
        for (const fileName of component.requiredFiles) {
          files[fileName] = await findFileRecursive(directory, fileName);
          if (!files[fileName]) ready = false;
        }
      }
      components.push({ id: component.id, label: component.label, version: component.version, ready, files });
    }
    return {
      ready: components.every((component) => component.ready),
      modelId: this.manifest.modelOption?.id || null,
      summaryModelId: this.manifest.summaryOption?.id || null,
      rootDirectory: this.rootDirectory,
      estimatedInstalledBytes: this.manifest.estimatedInstalledBytes,
      totalDownloadBytes: this.totalDownloadBytes,
      components
    };
  }

  async resolveRequiredFile(componentId, fileName) {
    const status = await this.getStatus();
    const component = status.components.find((item) => item.id === componentId);
    if (!component?.ready || !component.files[fileName]) {
      throw new Error(`缺少运行依赖：${fileName}`);
    }
    return component.files[fileName];
  }

  async installComponent(component, { signal, onEvent = () => {} } = {}) {
    const finalDirectory = this.componentDirectory(component.id);
    const temporaryDirectory = this.stagingDirectory(component.id);
    await fsp.mkdir(temporaryDirectory, { recursive: true });

    try {
      let priorDownloadBytes = 0;
      for (const download of component.downloads) {
        if (signal?.aborted) throw signal.reason || abortError();
        const localPath = path.join(temporaryDirectory, download.fileName);
        const resumeBytes = await reusableByteCount(localPath, download.size);
        await this.downloadVerified(download, localPath, signal, (position) => {
          onEvent({
            phase: 'download',
            component,
            fileName: download.fileName,
            fileBytes: position,
            fileTotalBytes: download.size,
            componentBytes: priorDownloadBytes + position
          });
        }, resumeBytes);
        if (download.archive) {
          if (signal?.aborted) throw signal.reason || abortError();
          onEvent({
            phase: 'extract',
            component,
            fileName: download.fileName,
            componentBytes: priorDownloadBytes + download.size
          });
          const extractionDirectory = path.join(temporaryDirectory, 'payload');
          await fsp.mkdir(extractionDirectory, { recursive: true });
          await abortable(extractArchive(localPath, extractionDirectory, signal), signal);
          await fsp.rm(localPath, { force: true });
        }
        priorDownloadBytes += download.size;
      }

      const payloadDirectory = path.join(temporaryDirectory, 'payload');
      const searchDirectory = fs.existsSync(payloadDirectory) ? payloadDirectory : temporaryDirectory;
      for (const fileName of component.requiredFiles) {
        if (!(await findFileRecursive(searchDirectory, fileName))) {
          throw new Error(`${component.label} 压缩包中缺少 ${fileName}。`);
        }
      }
      await fsp.writeFile(path.join(temporaryDirectory, '.installed.json'), JSON.stringify({
        id: component.id,
        version: component.version,
        installedAt: new Date().toISOString()
      }, null, 2));

      await fsp.rm(finalDirectory, { recursive: true, force: true });
      await fsp.rename(temporaryDirectory, finalDirectory);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        await fsp.rm(temporaryDirectory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async removeModel(kind = 'transcribe') {
    const isSummary = kind === 'summary';
    const option = isSummary ? this.manifest.summaryOption : this.manifest.modelOption;
    const optionField = isSummary ? 'summaryOptionId' : 'modelOptionId';
    if (!option) throw new Error(isSummary ? '找不到要删除的总结模型。' : '找不到要删除的转写模型。');
    const component = this.manifest.components.find((item) => (
      item.id === option.componentId && item[optionField] === option.id
    ));
    if (!component) throw new Error(isSummary ? '找不到要删除的总结模型。' : '找不到要删除的转写模型。');

    const status = await this.getStatus();
    const installed = status.components.find((item) => item.id === component.id)?.ready;
    if (!installed) throw new Error(`${option.label} 尚未安装。`);

    await fsp.rm(this.componentDirectory(component.id), { recursive: true, force: true });
    return this.getStatus();
  }

  async verifyInstalledEngines(signal) {
    const checks = [
      ['ffmpeg', 'ffmpeg.exe', ['-version']],
      ['whisper-engine', 'whisper-cli.exe', ['--version']],
      ['llama-engine', 'llama-server.exe', ['--version']]
    ];
    for (const [componentId, fileName, args] of checks) {
      const executable = await this.resolveRequiredFile(componentId, fileName);
      try {
        await runProcess(executable, args, { cwd: path.dirname(executable), signal });
      } catch (error) {
        throw new Error(`${fileName} 启动自检失败。请确认已安装最新 Microsoft Visual C++ 2015–2022 x64 运行库和 NVIDIA 驱动。\n${error.message}`);
      }
    }
    return true;
  }

  async downloadVerified(download, destination, signal, report, resumeBytes = 0) {
    let offset = Math.max(0, Math.min(resumeBytes, download.size));
    let hash = crypto.createHash('sha256');
    await absorbFileBytes(destination, offset, hash);

    if (offset >= download.size) {
      await this.verifyDigest(download, destination, hash);
      report(offset);
      return;
    }

    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const response = await this.fetchImpl(download.url, { signal, redirect: 'follow', headers });
    if (!response.ok || !response.body) {
      throw new Error(`下载 ${download.fileName} 失败（HTTP ${response.status}）。`);
    }
    if (offset > 0 && response.status !== 206) {
      hash = crypto.createHash('sha256');
      offset = 0;
    }

    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        report(offset + received);
        callback(null, chunk);
      }
    });
    const output = offset > 0
      ? fs.createWriteStream(destination, { flags: 'r+', start: offset })
      : fs.createWriteStream(destination);
    try {
      await pipeline(Readable.fromWeb(response.body), meter, output);
    } catch (error) {
      output.destroy();
      throw error;
    }
    await this.verifyDigest(download, destination, hash);
  }

  async verifyDigest(download, destination, hash) {
    const digest = hash.digest('hex');
    if (digest !== download.sha256) {
      await fsp.rm(destination, { force: true });
      throw new Error(`${download.fileName} 的 SHA-256 校验失败，文件已删除。`);
    }
  }
}

module.exports = {
  abortable,
  chooseModelAfterInstall,
  DependencyManager,
  ensureWithin,
  extractArchive,
  findFileRecursive,
  getModelOption,
  selectManifestForModel
};
