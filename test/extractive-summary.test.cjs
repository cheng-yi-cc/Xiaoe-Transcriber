const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildExtractiveSummary,
  evaluateGeneratedSummary,
  generatedSummaryIsSupported,
  selectHighlights
} = require('../src/main/services/extractive-summary.cjs');

const transcript = [
  '今天介绍本地转写流程，先获取音频，再使用显卡识别语音，最后保存完整文字稿。',
  '处理长视频时不需要按原速播放，可以并发下载视频分片，播放窗口保持静音。',
  '完整文字稿用于搜索细节，总结用于快速判断课程是否值得继续深入。',
  '所有识别和总结都在本机完成，不调用云端接口，也不会上传课程内容。'
].join('\n\n');

const faithfulProseSummary = [
  '这次分享介绍了本地转写的整体流程：先获取音频，再使用显卡识别语音，最后保存完整的文字稿。',
  '处理长视频时不需要按原速播放，可以并发下载视频分片，同时让播放窗口保持静音。',
  '生成的完整文字稿可以用来搜索细节，总结则帮助大家快速判断课程是否值得继续深入。',
  '整个识别和总结的过程都在本机完成，不会调用云端接口，也不会上传课程内容，隐私更有保障。'
].join('\n\n');

test('builds a heading-free excerpt fallback without term-frequency noise', () => {
  const summary = buildExtractiveSummary(transcript);
  assert.doesNotMatch(summary, /##|高频|词频/);
  assert.match(summary, /可靠性|摘自逐字稿/);
  assert.match(summary, /本地转写|显卡|文字稿/);
  const { highlights } = selectHighlights(transcript);
  assert.ok(highlights.length >= 2);
});

test('rejects invented content and fabricated numbers', () => {
  const hallucinated = [
    '刘卓老师分享了团队积累的用户增长经验，强调私域运营的核心是思维导图式的用户分层。',
    '转化率可以提升到百分之三十以上，还介绍了如何优化会员体系、设计打卡活动。',
    '他给出了新账号冷启动的完整方案和时间表，并建议每天复盘数据看板的关键指标变化。',
    '最后提醒大家注意投放素材的迭代节奏，避免预算浪费在低质量渠道上。'
  ].join('\n');
  assert.equal(generatedSummaryIsSupported(hallucinated, transcript), false);

  const fabricatedNumber = `${faithfulProseSummary}并发下载还能把整体速度提升 80%。`;
  assert.equal(generatedSummaryIsSupported(fabricatedNumber, transcript), false);
});

test('accepts prose summaries that paraphrase the transcript', () => {
  assert.equal(generatedSummaryIsSupported(faithfulProseSummary, transcript), true);
});

test('rejects summaries that are too short to be useful', () => {
  assert.equal(generatedSummaryIsSupported('这次直播讲了本地转写的基本流程。', transcript), false);
});

test('explains which reliability rule rejected a summary', () => {
  const short = evaluateGeneratedSummary('这次直播讲了本地转写。', transcript);
  assert.equal(short.supported, false);
  assert.match(short.reason, /120/);

  const hallucinated = evaluateGeneratedSummary([
    '刘卓老师分享了团队积累的用户增长经验，强调私域运营的核心是思维导图式的用户分层。',
    '转化率可以提升到百分之三十以上，还介绍了如何优化会员体系、设计打卡活动。',
    '他给出了新账号冷启动的完整方案和时间表，并建议每天复盘数据看板的关键指标变化。',
    '最后提醒大家注意投放素材的迭代节奏，避免预算浪费在低质量渠道上。'
  ].join('\n'), transcript);
  assert.equal(hallucinated.supported, false);
  assert.match(hallucinated.reason, /60%|实词/);

  assert.equal(evaluateGeneratedSummary(faithfulProseSummary, transcript).supported, true);
});
