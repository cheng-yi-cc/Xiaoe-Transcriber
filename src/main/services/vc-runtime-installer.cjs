const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { probeVcRuntime } = require('./system-probe.cjs');

const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

function runElevatedInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const script = `Start-Process -FilePath '${installerPath}' -ArgumentList '/install','/passive','/norestart' -Verb RunAs -Wait`;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    });
    let tail = '';
    child.stderr.on('data', (chunk) => { tail = `${tail}${chunk}`.slice(-500); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`运行库安装未完成（代码 ${code}）。若取消了 UAC 授权弹窗，请重试；仍失败时可手动安装：${VC_REDIST_URL}${tail ? `\n${tail}` : ''}`));
    });
  });
}

async function installVcRuntime({ fetchImpl = globalThis.fetch, onProgress = () => {} }) {
  const current = await probeVcRuntime();
  if (current.supported) return current;

  const installerPath = path.join(os.tmpdir(), `vc_redist.x64-${crypto.randomUUID()}.exe`);
  onProgress({ phase: 'download' });
  const response = await fetchImpl(VC_REDIST_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`下载 VC++ 运行库失败（HTTP ${response.status}）。请检查网络后重试。`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(installerPath));

  onProgress({ phase: 'elevate' });
  try {
    await runElevatedInstaller(installerPath);
  } finally {
    await fsp.rm(installerPath, { force: true });
  }

  const result = await probeVcRuntime();
  if (!result.supported) {
    throw new Error('VC++ 运行库安装后仍未检测到新版本，请重试或手动安装最新运行库。');
  }
  return result;
}

module.exports = { installVcRuntime, VC_REDIST_URL };
