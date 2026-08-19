const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeResultFolderPath, sanitizeWindowsName } = require('../src/main/services/file-utils.cjs');

test('sanitizes Windows-invalid video title characters', () => {
  assert.equal(sanitizeWindowsName('课程：AI / 学习？ '), '课程：AI 学习？');
  assert.equal(sanitizeWindowsName('CON'), '未命名视频');
});

test('creates a timestamped result folder to preserve older results', () => {
  const date = new Date(2026, 7, 19, 21, 30, 45);
  const result = makeResultFolderPath('D:\\Documents', '课程标题', date);
  assert.equal(path.basename(result), '课程标题_20260819_213045');
});
