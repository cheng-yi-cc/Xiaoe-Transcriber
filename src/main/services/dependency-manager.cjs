const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { runProcess } = require('./process-runner.cjs');

function getModelOption(manifest, modelId) {
  const options = Array.isArray(manifest.modelOptions) ? manifest.modelOptions : [];
  return options.find((option) => option.id === modelId) || options[0] || null;
}

function selectManifestForModel(manifest, modelId) {
  const modelOption = getModelOption(manifest, modelId);
  const components = manifest.components.filter((component) => (
    !component.modelOptionId || component.modelOptionId === modelOption?.id
  ));
  return {
    ...manifest,
    modelOption,
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

class DependencyManager {
  constructor({ rootDirectory, manifest, fetchImpl = globalThis.fetch, onProgress = () => {} }) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.manifest = manifest;
    this.fetchImpl = fetchImpl;
    this.onProgress = onProgress;
    this.totalDownloadBytes = manifest.components
      .flatMap((component) => component.downloads)
      .reduce((sum, download) => sum + download.size, 0);
  }

  componentDirectory(componentId) {
    return ensureWithin(this.rootDirectory, path.join(this.rootDirectory, 'components', componentId));
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

  async installAll(signal) {
    await fsp.mkdir(path.join(this.rootDirectory, 'components'), { recursive: true });
    let completedBytes = 0;
    const status = await this.getStatus();
    for (const component of this.manifest.components) {
      const existing = status.components.find((item) => item.id === component.id);
      const componentBytes = component.downloads.reduce((sum, item) => sum + item.size, 0);
      if (existing?.ready) {
        completedBytes += componentBytes;
        this.emit({ phase: 'skip', component, completedBytes, currentBytes: 0 });
        continue;
      }
      await this.installComponent(component, completedBytes, signal);
      completedBytes += componentBytes;
    }
    const finalStatus = await this.getStatus();
    if (!finalStatus.ready) throw new Error('依赖安装完成，但完整性检查未通过。');
    await this.verifyInstalledEngines(signal);
    this.emit({ phase: 'complete', completedBytes: this.totalDownloadBytes, currentBytes: 0 });
    return finalStatus;
  }

  async removeModel() {
    const modelOption = this.manifest.modelOption;
    const component = this.manifest.components.find((item) => (
      item.id === modelOption?.componentId && item.modelOptionId === modelOption?.id
    ));
    if (!component) throw new Error('找不到要删除的转写模型。');

    const status = await this.getStatus();
    const installed = status.components.find((item) => item.id === component.id)?.ready;
    if (!installed) throw new Error(`${modelOption.label} 尚未安装。`);

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

  async installComponent(component, completedBefore, signal) {
    const finalDirectory = this.componentDirectory(component.id);
    const temporaryDirectory = ensureWithin(
      this.rootDirectory,
      `${finalDirectory}.installing-${crypto.randomUUID()}`
    );
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
    await fsp.mkdir(temporaryDirectory, { recursive: true });

    try {
      let priorDownloadBytes = 0;
      for (const download of component.downloads) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const localPath = path.join(temporaryDirectory, download.fileName);
        await this.downloadVerified(download, localPath, signal, (received) => {
          this.emit({
            phase: 'download',
            component,
            fileName: download.fileName,
            fileBytes: received,
            fileTotalBytes: download.size,
            completedBytes: completedBefore + priorDownloadBytes + received,
            currentBytes: received
          });
        });
        if (download.archive) {
          this.emit({ phase: 'extract', component, fileName: download.fileName, completedBytes: completedBefore + priorDownloadBytes + download.size, currentBytes: 0 });
          const archivePath = localPath;
          const extractionDirectory = path.join(temporaryDirectory, 'payload');
          await fsp.mkdir(extractionDirectory, { recursive: true });
          await extractArchive(archivePath, extractionDirectory, signal);
          await fsp.rm(archivePath, { force: true });
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
      await fsp.rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async downloadVerified(download, destination, signal, report) {
    const response = await this.fetchImpl(download.url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new Error(`下载 ${download.fileName} 失败（HTTP ${response.status}）。`);
    }
    const hash = crypto.createHash('sha256');
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        report(received);
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination));
    const digest = hash.digest('hex');
    if (digest !== download.sha256) {
      await fsp.rm(destination, { force: true });
      throw new Error(`${download.fileName} 的 SHA-256 校验失败，文件已删除。`);
    }
  }

  emit(event) {
    this.onProgress({ totalBytes: this.totalDownloadBytes, ...event });
  }
}

module.exports = {
  chooseModelAfterInstall,
  DependencyManager,
  ensureWithin,
  extractArchive,
  findFileRecursive,
  getModelOption,
  selectManifestForModel
};
