const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');

test('settings lists transcription models from largest to smallest', () => {
  const large = html.indexOf('data-model="large-v3-turbo"');
  const medium = html.indexOf('data-model="medium"');
  const small = html.indexOf('data-model="small"');

  assert.ok(large >= 0 && medium >= 0 && small >= 0);
  assert.ok(large < medium && medium < small);
});

test('settings lists summary models from largest to smallest', () => {
  const large = html.indexOf('data-summary-model="qwen3-8b"');
  const small = html.indexOf('data-summary-model="qwen2.5-1.5b"');

  assert.ok(large >= 0 && small >= 0);
  assert.ok(large < small);
});
