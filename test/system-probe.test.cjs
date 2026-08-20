const assert = require('node:assert/strict');
const test = require('node:test');
const { recommendWhisperModel } = require('../src/main/services/system-probe.cjs');

test('hardware recommendation uses conservative GPU and system memory thresholds', () => {
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 2048 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'small');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 4096 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'medium');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 8192 }, totalMemoryBytes: 16 * 1024 ** 3 }), 'large-v3-turbo');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 8192 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'medium');
});
