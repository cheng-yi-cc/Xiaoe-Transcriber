const path = require('node:path');

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeWindowsName(value, maxLength = 72) {
  let result = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!result || WINDOWS_RESERVED.test(result)) result = '未命名视频';
  return [...result].slice(0, maxLength).join('').replace(/[. ]+$/g, '') || '未命名视频';
}

function formatFolderTimestamp(date = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function makeResultFolderPath(outputRoot, title, date = new Date()) {
  return path.join(outputRoot, `${sanitizeWindowsName(title)}_${formatFolderTimestamp(date)}`);
}

function ffconcatEscape(filePath) {
  return String(filePath).replace(/'/g, "'\\''").replace(/\\/g, '/');
}

module.exports = {
  ffconcatEscape,
  formatFolderTimestamp,
  makeResultFolderPath,
  sanitizeWindowsName
};
