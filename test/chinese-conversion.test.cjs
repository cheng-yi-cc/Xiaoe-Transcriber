const test = require('node:test');
const assert = require('node:assert/strict');
const { toSimplifiedChinese } = require('../src/main/services/chinese-conversion.cjs');

test('converts traditional characters to simplified', () => {
  assert.equal(toSimplifiedChinese('這是一個繁體測試，涵蓋頭髮和裡面。'), '这是一个繁体测试，涵盖头发和里面。');
});

test('protects ambiguous names with phrase rules', () => {
  assert.equal(toSimplifiedChinese('乾隆皇帝'), '乾隆皇帝');
  assert.equal(toSimplifiedChinese('乾杯'), '干杯');
});

test('leaves non-Chinese text unchanged', () => {
  const mixed = 'English 混合 123，Markdown 標題 # heading';
  assert.equal(toSimplifiedChinese(mixed), 'English 混合 123，Markdown 标题 # heading');
});

test('handles empty input and surrogate pairs without corruption', () => {
  assert.equal(toSimplifiedChinese(''), '');
  assert.equal(toSimplifiedChinese(null), null);
  const surrogatePair = '𫝈';
  assert.equal(toSimplifiedChinese(`前${surrogatePair}後`), `前${surrogatePair}后`);
});
