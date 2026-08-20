const { execFile } = require('node:child_process');
const os = require('node:os');

function probeNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], {
      windowsHide: true,
      timeout: 10000
    }, (error, stdout) => {
      if (error) return resolve({ supported: false, detail: '未检测到可用的 NVIDIA 显卡或驱动。' });
      const [name = '', memory = '', driver = ''] = String(stdout).trim().split(',').map((part) => part.trim());
      const memoryMb = Number.parseInt(memory.replace(/[^\d]/g, ''), 10) || 0;
      resolve({ supported: Boolean(name), name, memory, memoryMb, driver, detail: `${name} · ${memory}` });
    });
  });
}

function probeVcRuntime() {
  return new Promise((resolve) => {
    execFile('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64',
      '/v',
      'Version'
    ], { windowsHide: true, timeout: 10000 }, (error, stdout) => {
      if (error) return resolve({ supported: false, version: '', detail: '未安装 Microsoft Visual C++ 2015–2022 x64 运行库。' });
      const match = /Version\s+REG_SZ\s+v?([\d.]+)/i.exec(String(stdout));
      const version = match?.[1] || '';
      const [major = 0, minor = 0] = version.split('.').map(Number);
      const supported = major > 14 || (major === 14 && minor >= 30);
      resolve({
        supported,
        version,
        detail: supported ? `Microsoft Visual C++ ${version}` : `运行库版本 ${version || '未知'} 过旧，需要升级。`
      });
    });
  });
}

function recommendWhisperModel({ gpu = {}, totalMemoryBytes = os.totalmem() } = {}) {
  const gpuMemoryMb = Number(gpu.memoryMb) || 0;
  const systemMemoryGb = totalMemoryBytes / (1024 ** 3);
  if (gpuMemoryMb >= 6144 && systemMemoryGb >= 12) return 'large-v3-turbo';
  if (gpuMemoryMb >= 4096 && systemMemoryGb >= 8) return 'medium';
  return 'small';
}

function getSystemProfile(gpu) {
  const cpu = os.cpus()?.[0]?.model?.trim() || '未知处理器';
  const totalMemoryBytes = os.totalmem();
  return {
    cpu,
    logicalCores: os.cpus()?.length || 0,
    totalMemoryBytes,
    totalMemoryGb: Math.max(1, Math.round(totalMemoryBytes / (1024 ** 3))),
    platform: `${os.type()} ${os.release()} · ${os.arch()}`,
    recommendedModelId: recommendWhisperModel({ gpu, totalMemoryBytes })
  };
}

module.exports = { getSystemProfile, probeNvidiaGpu, probeVcRuntime, recommendWhisperModel };
