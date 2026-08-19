const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkTranscript, paragraphizeTranscript } = require('../src/main/services/transcript-utils.cjs');

test('removes timestamp decorations but preserves spoken filler and repetition', () => {
  const raw = '[00:00:00.000 --> 00:00:03.000] 嗯，我觉得这个方法\n[00:00:03.000 --> 00:00:06.000] 这个方法确实可以。';
  const transcript = paragraphizeTranscript(raw, 200);
  assert.match(transcript, /嗯/);
  assert.match(transcript, /这个方法这个方法/);
  assert.doesNotMatch(transcript, /00:00/);
});

test('splits long transcripts into bounded summarization chunks', () => {
  const text = `${'甲'.repeat(3000)}\n\n${'乙'.repeat(3000)}`;
  const chunks = chunkTranscript(text, 3500);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
});
