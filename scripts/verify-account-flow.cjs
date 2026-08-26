const path = require('node:path');
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const projectRoot = path.resolve(__dirname, '..');
const probeUserData = process.env.XIAOE_AUTH_PROBE_USER_DATA || path.join(projectRoot, '.auth-probe-user-data');
const sourceUrls = process.argv.slice(2);
const child = spawn(electronPath, [`--user-data-dir=${probeUserData}`, '.'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    XIAOE_AUTH_PROBE_MODE: '1',
    XIAOE_AUTH_PROBE_URLS: JSON.stringify(sourceUrls),
    XIAOE_AUTH_PROBE_USER_DATA: probeUserData
  },
  stdio: 'inherit',
  windowsHide: false
});

child.once('error', (error) => {
  console.error(String(error?.message || error));
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = Number.isInteger(code) ? code : 1;
});
