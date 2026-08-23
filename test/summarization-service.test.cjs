const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRiskAppendix,
  calculateTargetCharacters,
  debateAndReviseTopicBlock,
  ensureNumericConsistency,
  extractJsonArray,
  extractNumericClaims,
  formatTopicHeading,
  mergeTimeRanges,
  normalizeCards,
  normalizeParagraphs,
  parsePlanLines,
  parseReviewOutput,
  parseTopicLines,
  refineCardType,
  refineTopicPlan,
  recurringReviewIssues,
  revisionIsUsable,
  unsupportedNumericClaims
} = require('../src/main/services/summarization-service.cjs');

test('normalizes timed paragraphs without discarding emphasis metadata', () => {
  const paragraphs = normalizeParagraphs([{
    startMs: 1000,
    endMs: 5000,
    text: '核心方法。',
    volumeRatio: 1.4,
    speechRateRatio: 1.2
  }], '');
  assert.equal(paragraphs[0].id, 'P0001');
  assert.equal(paragraphs[0].durationSeconds, 4);
  assert.equal(paragraphs[0].volumeRatio, 1.4);
  assert.equal(paragraphs[0].hasExactTiming, true);
});

test('keeps paragraphs omitted by the topic model in a fallback card', () => {
  const chunk = normalizeParagraphs([
    { startMs: 0, endMs: 1000, text: '课程方法。' },
    { startMs: 1000, endMs: 2000, text: '具体步骤。' }
  ], '');
  const cards = normalizeCards([{
    title: '课程方法',
    type: 'content',
    paragraphIds: ['P0001'],
    emphasis: 4
  }], chunk, 0);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[1].paragraphIds, ['P0002']);
});

test('extracts a JSON array from a fenced model response', () => {
  assert.deepEqual(extractJsonArray('```json\n[{"title":"主题"}]\n```'), [{ title: '主题' }]);
  assert.equal(extractJsonArray('不是 JSON'), null);
});

test('parses compact topic ranges returned by a local model', () => {
  const chunk = normalizeParagraphs([
    { startMs: 0, endMs: 1000, text: '课程方法。' },
    { startMs: 1000, endMs: 2000, text: '具体步骤。' },
    { startMs: 2000, endMs: 3000, text: '报名提醒。' }
  ], '');
  assert.deepEqual(parseTopicLines([
    'TOPIC|content|P0001-P0002|4|学习方法|包含步骤',
    'TOPIC｜notice｜P0003-P0003｜2｜报名通知｜事务信息'
  ].join('\n'), chunk), [
    { type: 'content', paragraphIds: ['P0001', 'P0002'], emphasis: 4, title: '学习方法', reason: '包含步骤' },
    { type: 'notice', paragraphIds: ['P0003'], emphasis: 2, title: '报名通知', reason: '事务信息' }
  ]);
});

test('parses topic-plan lines with non-contiguous card ids', () => {
  assert.deepEqual(parsePlanLines('GROUP|content|5|C001,C006|失败后的强者逻辑|反复论证'), [{
    type: 'content',
    importance: 5,
    cardIds: ['C001', 'C006'],
    title: '失败后的强者逻辑',
    reason: '反复论证'
  }]);
});

test('bounds over-broad content groups and combines notices at the end', () => {
  const paragraphs = normalizeParagraphs(Array.from({ length: 6 }, (_, index) => ({
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `第${index + 1}段内容。`
  })), '');
  const paragraphMap = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const cards = Array.from({ length: 6 }, (_, index) => ({
    id: `C00${index + 1}`,
    title: index < 4 ? `正文主题${index + 1}` : `通知${index - 3}`,
    type: index < 4 ? 'content' : 'notice',
    paragraphIds: [paragraphs[index].id],
    emphasis: index < 4 ? 4 : 2
  }));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const refined = refineTopicPlan([
    { title: '过宽主题', type: 'content', importance: 5, leafCardIds: cards.slice(0, 4).map((card) => card.id) },
    { title: '通知一', type: 'notice', importance: 2, leafCardIds: ['C005'] },
    { title: '通知二', type: 'notice', importance: 2, leafCardIds: ['C006'] }
  ], cardsById, paragraphMap);
  assert.equal(refined.length, 3);
  assert.deepEqual(refined[0].leafCardIds, ['C001', 'C002', 'C003']);
  assert.deepEqual(refined[1].leafCardIds, ['C004']);
  assert.equal(refined.at(-1).title, '课程安排与通知');
  assert.deepEqual(refined.at(-1).leafCardIds, ['C005', 'C006']);
});

test('reclassifies promotion-heavy cards as notices', () => {
  const paragraphs = normalizeParagraphs([
    { startMs: 0, endMs: 1000, text: '早鸟报名享受优惠福利，付款截止后把截图发给助理。' }
  ], '');
  const paragraphMap = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  const card = refineCardType({
    id: 'C001',
    title: '报名事项',
    type: 'content',
    paragraphIds: ['P0001'],
    emphasis: 3
  }, paragraphMap);
  assert.equal(card.type, 'notice');
});

test('treats unexamined song lyrics as noise but keeps explicit lyric analysis', () => {
  const paragraphs = normalizeParagraphs([
    { startMs: 0, endMs: 1000, text: '有人高贵，有人平凡，夜夜夜夜。' },
    { startMs: 1000, endMs: 2000, text: '这段歌词表达了人物的矛盾。' }
  ], '');
  const paragraphMap = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
  assert.equal(refineCardType({
    id: 'C001', title: '开场歌词', type: 'content', paragraphIds: ['P0001'], emphasis: 4
  }, paragraphMap).type, 'noise');
  assert.equal(refineCardType({
    id: 'C002', title: '歌词分析', type: 'content', paragraphIds: ['P0002'], emphasis: 3
  }, paragraphMap).type, 'content');
});

test('dynamic detail budget grows with duration and emphasis while notices remain capped', () => {
  const short = calculateTargetCharacters({ sourceChars: 1200, durationSeconds: 180, importance: 2, type: 'content' });
  const emphasized = calculateTargetCharacters({ sourceChars: 5000, durationSeconds: 900, importance: 5, type: 'content' });
  const notice = calculateTargetCharacters({ sourceChars: 10000, durationSeconds: 1800, importance: 5, type: 'notice' });
  assert.ok(emphasized > short);
  assert.ok(notice <= 550);
});

test('merges nearby ranges and displays separated returns to a topic', () => {
  const paragraphs = normalizeParagraphs([
    { startMs: 0, endMs: 10000, text: '第一段。' },
    { startMs: 20000, endMs: 30000, text: '第二段。' },
    { startMs: 120000, endMs: 130000, text: '稍后再次讨论。' }
  ], '');
  assert.deepEqual(mergeTimeRanges(paragraphs), [
    { startMs: 0, endMs: 30000 },
    { startMs: 120000, endMs: 130000 }
  ]);
  assert.equal(
    formatTopicHeading({ title: '学习方法' }, paragraphs),
    '## 学习方法（00:00:00–00:00:30、00:02:00–00:02:10）'
  );
});

test('hard-checks numeric claims against the corresponding source block', () => {
  assert.deepEqual(
    extractNumericClaims('2015年费用为1,000.5元，完成率23％。').map((claim) => claim.normalized),
    ['2015', '1000.5', '23%']
  );
  assert.deepEqual(
    unsupportedNumericClaims('费用从200元降到100元，完成率30%。', '原价150元，现价100元，完成率30%。')
      .map((claim) => claim.raw),
    ['200']
  );
});

test('parses reviewer challenges and rejects unstructured audit output', () => {
  const parsed = parseReviewOutput(
    'ISSUE|P0001,P9999|讲师确认对方低调|原文只是讲师的猜测',
    ['P0001']
  );
  assert.equal(parsed.passed, false);
  assert.deepEqual(parsed.issues[0].paragraphIds, ['P0001']);
  assert.match(parsed.issues[0].reason, /猜测/);
  assert.equal(parseReviewOutput('VERDICT|PASS', ['P0001']).passed, true);
  assert.equal(parseReviewOutput(
    'ISSUE|P0001|规模更大|属于合理概括，原文支持',
    ['P0001']
  ).passed, true);
  assert.equal(parseReviewOutput('大致没有问题', ['P0001']).issues[0].claim, '审核结果格式异常');
});

test('rejects revisions that regress into first-person transcript copying', () => {
  const source = '讲师在直播里反复说道我不知道对方当时怎么处理我只是希望他低着头继续把自己的事情做好然后获得更好的结果。';
  const draft = '讲师并不知道对方当时如何处理，只是希望对方没有抱怨，而是继续低头做事。';
  assert.equal(revisionIsUsable(draft, draft, source), true);
  assert.equal(revisionIsUsable(draft, `${source}${source}`, source), false);
  assert.equal(revisionIsUsable(draft, '我不知道他怎么做你也不知道我们就希望他继续低着头做事。', source), false);
});

test('keeps a repeated unresolved challenge even when the final reviewer passes it', () => {
  const issue = {
    paragraphIds: ['P0001'],
    claim: '讲师认为对方成功源于低调务实的态度',
    reason: '原文只说讲师不知道实际情况并希望如此'
  };
  const history = [
    { round: 1, issues: [issue] },
    { round: 2, issues: [] },
    { round: 3, issues: [{ ...issue, reason: '讲师的愿望不能改写成确定因果' }] }
  ];
  assert.equal(recurringReviewIssues(history, `当前稿仍写道：${issue.claim}。`).length, 1);
  assert.equal(recurringReviewIssues(history, '当前稿已经明确写成讲师的个人猜测。').length, 0);
});

test('repairs unsupported numbers directly and verifies the repaired draft again', async () => {
  const block = normalizeParagraphs([
    { startMs: 0, endMs: 5000, text: '课程价格为100元。' }
  ], '');
  let calls = 0;
  const result = await ensureNumericConsistency(
    'http://local',
    { title: '课程价格' },
    block,
    '课程价格为200元。',
    null,
    async () => {
      calls += 1;
      return '课程价格为100元。';
    }
  );
  assert.equal(result.text, '课程价格为100元。');
  assert.deepEqual(result.unsupported, []);
  assert.equal(calls, 1);
});

test('runs three challenge-revision rounds and a read-only final review', async () => {
  const block = normalizeParagraphs([
    { startMs: 60000, endMs: 90000, text: '讲师说自己不知道对方当时怎么处理，只希望对方是低头做事。' }
  ], '');
  const responses = [
    'ISSUE|P0001|对方通过低调取得成功|原文明确说讲师并不知道实际情况',
    '对方通过低调务实取得了成功。',
    'ISSUE|P0001|对方通过低调取得成功|讲师只是在表达希望，并未确认实际情况',
    '对方通过低调务实取得了成功。',
    'ISSUE|P0001|对方通过低调取得成功|总结必须保留讲师不知道实际情况这一限定',
    '对方通过低调务实取得了成功。',
    'VERDICT|PASS'
  ];
  const progress = [];
  const result = await debateAndReviseTopicBlock({
    baseUrl: 'http://local',
    topic: { title: '低头做人与现实判断' },
    block,
    draft: '对方通过低调务实取得了成功。',
    signal: null,
    chatFn: async () => responses.shift(),
    onReview: (event) => progress.push(event.phase)
  });
  assert.equal(result.text, '对方通过低调务实取得了成功。');
  assert.deepEqual(progress, ['debate', 'debate', 'debate', 'final-review']);
  assert.equal(result.risks.length, 1);
  assert.equal(result.risks[0].time, '00:01:00–00:01:30');
  assert.match(result.risks[0].reason, /不知道实际情况/);
  assert.equal(responses.length, 0);
});

test('renders unresolved final-review risks at the end with video timestamps', () => {
  const appendix = buildRiskAppendix([{
    topic: '低头做人与现实判断',
    time: '00:01:00–00:01:30',
    claim: '对方当时的真实想法',
    reason: '逐字稿只记录了讲师的猜测'
  }]);
  assert.match(appendix, /^## 审核风险提示/m);
  assert.match(appendix, /00:01:00–00:01:30/);
  assert.match(appendix, /保留最后修订版本/);
});
