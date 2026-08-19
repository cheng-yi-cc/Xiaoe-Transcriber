const { execFile } = require('node:child_process');

function probeNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], {
      windowsHide: true,
      timeout: 10000
    }, (error, stdout) => {
      if (error) return resolve({ supported: false, detail: '未检测到可用的 NVIDIA 显卡或驱动。' });
      const [name = '', memory = '', driver = ''] = String(stdout).trim().split(',').map((part) => part.trim());
      resolve({ supported: Boolean(name), name, memory, driver, detail: `${name} · ${memory}` });
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

module.exports = { probeNvidiaGpu, probeVcRuntime };
