const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExtractiveSummary,
  generatedSummaryIsSupported,
  selectHighlights
} = require('../src/main/services/extractive-summary.cjs');

const transcript = [
  '今天介绍本地转写流程，先获取音频，再使用显卡识别语音，最后保存完整文字稿。',
  '处理长视频时不需要按原速播放，可以并发下载视频分片，播放窗口保持静音。',
  '完整文字稿用于搜索细节，总结用于快速判断课程是否值得继续深入。',
  '所有识别和总结都在本机完成，不调用云端接口，也不会上传课程内容。'
].join('\n\n');

test('builds an extractive summary from transcript-supported text', () => {
  const summary = buildExtractiveSummary(transcript);
  assert.match(summary, /## 内容概览/);
  assert.match(summary, /## 核心观点/);
  assert.match(summary, /本地|转写|文字稿/);
  const { highlights } = selectHighlights(transcript);
  assert.ok(highlights.length >= 2);
});

test('rejects generated summaries with missing sections or invented entities', () => {
  const hallucinated = `## 最终总结\n\n刘卓和团队积累了大量用户数据。\n\n## 核心观点\n- 他们优化了思维导图。`;
  assert.equal(generatedSummaryIsSupported(hallucinated, transcript), false);
});

test('accepts a fully structured summary whose terms occur in the transcript', () => {
  const supported = `## 内容概览\n本地转写流程用于处理长视频。\n\n## 核心观点\n- 识别和总结都在本机完成。\n\n## 重要细节\n- 播放窗口保持静音。\n\n## 值得进一步看的部分\n- 可以搜索完整文字稿。`;
  assert.equal(generatedSummaryIsSupported(supported, transcript), true);
});
