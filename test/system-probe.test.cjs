const assert = require('node:assert/strict');
const test = require('node:test');
const { recommendSummaryModel, recommendWhisperModel } = require('../src/main/services/system-probe.cjs');

test('hardware recommendation uses conservative GPU and system memory thresholds', () => {
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 2048 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'small');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 4096 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'medium');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 8192 }, totalMemoryBytes: 16 * 1024 ** 3 }), 'large-v3-turbo');
  assert.equal(recommendWhisperModel({ gpu: { memoryMb: 8192 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'medium');
});

test('summary model recommendation prefers the large model only on high-VRAM GPUs', () => {
  assert.equal(recommendSummaryModel({ gpu: { memoryMb: 2048 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'qwen2.5-1.5b');
  assert.equal(recommendSummaryModel({ gpu: { memoryMb: 6144 }, totalMemoryBytes: 8 * 1024 ** 3 }), 'qwen2.5-1.5b');
  assert.equal(recommendSummaryModel({ gpu: { memoryMb: 8192 }, totalMemoryBytes: 16 * 1024 ** 3 }), 'qwen3-8b');
});
