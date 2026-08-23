const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chunkTranscript,
  paragraphizeTranscript,
  removeFillerWords
} = require('../src/main/services/transcript-utils.cjs');

test('removes standalone filler words but keeps meaningful usage', () => {
  const cleaned = removeFillerWords('嗯，呃，这个方法确实可以，是这样吧。\n哈哈，好的呀。');
  assert.equal(cleaned, '这个方法确实可以，是这样吧。\n好的呀。');
});

test('keeps filler characters attached to words intact', () => {
  assert.equal(removeFillerWords('好啊，那就这样办。'), '好啊，那就这样办。');
});

test('removes timestamp decorations and joins lines into sentences', () => {
  const raw = '[00:00:00.000 --> 00:00:03.000] 这个方法\n[00:00:03.000 --> 00:00:06.000] 这个方法确实可以。';
  const transcript = paragraphizeTranscript(raw, 200);
  assert.equal(transcript, '这个方法这个方法确实可以。');
  assert.doesNotMatch(transcript, /00:00/);
});

test('breaks paragraphs at sentence boundaries instead of mid-sentence', () => {
  const text = '这句话用来测试。'.repeat(40);
  const result = paragraphizeTranscript(text, 100);
  const paragraphs = result.split('\n\n');
  assert.ok(paragraphs.length > 1);
  for (const paragraph of paragraphs) {
    assert.match(paragraph, /。$/);
  }
});

test('falls back to length-based splitting when punctuation is missing', () => {
  const paragraphs = paragraphizeTranscript('甲'.repeat(500), 200).split('\n\n');
  assert.deepEqual(paragraphs.map((part) => part.length), [200, 200, 100]);
});

test('keeps every paragraph near the target length for normal prose', () => {
  const text = '这是一句正常长度的测试句子。'.repeat(60);
  const paragraphs = paragraphizeTranscript(text, 160).split('\n\n');
  assert.ok(paragraphs.length > 1);
  for (const paragraph of paragraphs) {
    assert.ok(paragraph.length <= 160 + '这是一句正常长度的测试句子。'.length);
    assert.match(paragraph, /。$/);
  }
});

test('splits run-on sentences at commas instead of producing walls of text', () => {
  const clause = '这是一个没有句号的从句，';
  const text = clause.repeat(30);
  const paragraphs = paragraphizeTranscript(text, 120).split('\n\n');
  assert.ok(paragraphs.length > 1);
  for (const paragraph of paragraphs) {
    assert.ok(paragraph.length <= 120 + clause.length);
  }
});

test('splits long transcripts into bounded summarization chunks', () => {
  const text = `${'甲'.repeat(3000)}\n\n${'乙'.repeat(3000)}`;
  const chunks = chunkTranscript(text, 3500);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
});
