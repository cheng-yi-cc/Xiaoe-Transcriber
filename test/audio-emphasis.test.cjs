const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { addAudioEmphasis, median, spokenCharacterCount } = require('../src/main/services/audio-emphasis.cjs');

function pcmWave(samples, sampleRate = 8000) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, 44 + index * 2));
  return buffer;
}

test('calculates median and spoken character counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(spokenCharacterCount('方法 A-1！'), 4);
});

test('detects relative loudness between timed paragraphs', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-audio-emphasis-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const sampleRate = 8000;
  const quiet = Array.from({ length: sampleRate }, (_, index) => Math.round(Math.sin(index / 10) * 1000));
  const loud = Array.from({ length: sampleRate }, (_, index) => Math.round(Math.sin(index / 10) * 8000));
  const audioPath = path.join(directory, 'sample.wav');
  await fsp.writeFile(audioPath, pcmWave([...quiet, ...loud], sampleRate));
  const analyzed = await addAudioEmphasis([
    { startMs: 0, endMs: 1000, text: '较轻的一段。' },
    { startMs: 1000, endMs: 2000, text: '明显强调的一段。' }
  ], audioPath);
  assert.ok(analyzed[1].volumeRatio > analyzed[0].volumeRatio * 5);
});
