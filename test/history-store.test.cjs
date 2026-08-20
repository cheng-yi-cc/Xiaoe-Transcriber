const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HistoryStore } = require('../src/main/services/history-store.cjs');

test('history store keeps newest unique result directories within its limit', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoe-history-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new HistoryStore(path.join(directory, 'history.json'), 2);
  store.add({ title: '第一课', sourceUrl: 'https://example.invalid/a', resultDirectory: path.join(directory, 'one') });
  store.add({ title: '第二课', sourceUrl: 'https://example.invalid/b', resultDirectory: path.join(directory, 'two') });
  store.add({ title: '第一课更新', sourceUrl: 'https://example.invalid/c', resultDirectory: path.join(directory, 'one') });

  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '第一课更新');
  assert.equal(entries[1].title, '第二课');
  assert.deepEqual(new HistoryStore(path.join(directory, 'history.json'), 2).list(), entries);
});
