const net = require('node:net');
const path = require('node:path');
const { spawnManaged } = require('./process-runner.cjs');
const { formatTimeRange } = require('./transcript-utils.cjs');

const ANALYSIS_CHUNK_CHARS = 4800;
const SECTION_SOURCE_CHARS = 3800;
const PLAN_INPUT_CHARS = 6500;
const TOPIC_TYPES = new Set(['content', 'notice', 'noise']);
const REVIEW_ROUNDS = 3;
const REVIEW_FOCI = [
  '这是事实轮：只核对人物、对象、事件、行为和具体事实是否张冠李戴或被凭空添加。',
  '这是逻辑轮：只检查因果倒置、条件丢失、范围扩大、不同观点混合，以及总结自行添加的结论或行为动机。',
  '这是确定性轮：只检查是否把讲师的猜测、希望、听说、不知道、比喻或主观判断改写成确定事实，并检查否定是否被遗漏。'
];
const NUMERIC_CLAIM_PATTERN = /(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:%|％)?/gu;

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, child, signal, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (child.exitCode !== null) throw new Error(`本地总结引擎启动失败（退出码 ${child.exitCode}）。`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal });
      if (response.ok) return;
    } catch {
      // The server is still loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error('本地总结模型启动超时。');
}

async function chat(baseUrl, messages, signal, maxTokens = 700) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'local-summary',
      messages,
      temperature: 0,
      top_p: 0.8,
      max_tokens: maxTokens,
      stream: false
    }),
    signal
  });
  if (!response.ok) throw new Error(`本地总结请求失败（HTTP ${response.status}）。`);
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('本地总结模型返回了空内容。');
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^<\/think>\s*/i, '')
    .replace(/^```(?:json|markdown)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeParagraphs(timedParagraphs, transcript) {
  const supplied = Array.isArray(timedParagraphs)
    ? timedParagraphs.filter((paragraph) => String(paragraph?.text || '').trim())
    : [];
  const hasExactTiming = supplied.length > 0 && supplied.every((paragraph) => (
    Number.isFinite(paragraph.startMs) && Number.isFinite(paragraph.endMs)
  ));
  const source = supplied.length
    ? supplied
    : String(transcript || '').split(/\n{2,}/).map((text) => ({ text: text.trim() })).filter((item) => item.text);
  let estimatedStartMs = 0;
  return source.map((paragraph, index) => {
    const estimatedDurationMs = Math.max(3000, Math.round(String(paragraph.text).length / 4.2) * 1000);
    const startMs = hasExactTiming ? Number(paragraph.startMs) : estimatedStartMs;
    const endMs = hasExactTiming ? Number(paragraph.endMs) : startMs + estimatedDurationMs;
    estimatedStartMs = endMs;
    return {
      ...paragraph,
      id: `P${String(index + 1).padStart(4, '0')}`,
      text: String(paragraph.text).trim(),
      startMs,
      endMs,
      durationSeconds: Math.max(0.1, (endMs - startMs) / 1000),
      volumeRatio: Number.isFinite(paragraph.volumeRatio) ? paragraph.volumeRatio : 1,
      speechRateRatio: Number.isFinite(paragraph.speechRateRatio) ? paragraph.speechRateRatio : 1,
      hasExactTiming
    };
  });
}

function chunkParagraphs(paragraphs, maxChars) {
  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const paragraph of paragraphs) {
    const paragraphLength = paragraph.text.length + 100;
    if (current.length && currentLength + paragraphLength > maxChars) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraphLength;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function formatParagraphForAnalysis(paragraph) {
  const duration = Math.max(1, Math.round(paragraph.durationSeconds));
  const timing = paragraph.hasExactTiming ? formatTimeRange(paragraph.startMs, paragraph.endMs) : '无精确时间';
  return `[${paragraph.id} | ${timing} | ${duration}秒 | 相对音量${paragraph.volumeRatio.toFixed(2)}× | 相对语速${paragraph.speechRateRatio.toFixed(2)}×]\n${paragraph.text}`;
}

function extractJsonArray(output) {
  const source = String(output || '').trim();
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function paragraphRange(startId, endId, validParagraphIds) {
  const start = /^P(\d+)$/.exec(String(startId || '').trim());
  const end = /^P(\d+)$/.exec(String(endId || '').trim());
  if (!start || !end) return [];
  const lower = Math.min(Number(start[1]), Number(end[1]));
  const upper = Math.max(Number(start[1]), Number(end[1]));
  const ids = [];
  for (let value = lower; value <= upper; value += 1) {
    const id = `P${String(value).padStart(4, '0')}`;
    if (validParagraphIds.has(id)) ids.push(id);
  }
  return ids;
}

function parseTopicLines(output, chunk) {
  const validParagraphIds = new Set(chunk.map((paragraph) => paragraph.id));
  const cards = [];
  for (const rawLine of String(output || '').replace(/｜/g, '|').split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    if (!/^TOPIC\s*\|/i.test(line)) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 6) continue;
    const rangeMatch = /^(P\d+)\s*[-–—~至]\s*(P\d+)$/i.exec(parts[2]);
    if (!rangeMatch) continue;
    const paragraphIds = paragraphRange(rangeMatch[1].toUpperCase(), rangeMatch[2].toUpperCase(), validParagraphIds);
    if (!paragraphIds.length) continue;
    cards.push({
      type: parts[1].toLowerCase(),
      paragraphIds,
      emphasis: Number(parts[3]),
      title: parts[4],
      reason: parts.slice(5).join(' ')
    });
  }
  return cards;
}

function parsePlanLines(output) {
  const topics = [];
  for (const rawLine of String(output || '').replace(/｜/g, '|').split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    if (!/^GROUP\s*\|/i.test(line)) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 6) continue;
    const cardIds = parts[3].match(/[CG]\d*(?:-\d+)?/gi) || [];
    if (!cardIds.length) continue;
    topics.push({
      type: parts[1].toLowerCase(),
      importance: Number(parts[2]),
      cardIds,
      title: parts[4],
      reason: parts.slice(5).join(' ')
    });
  }
  return topics;
}

function cleanTitle(value, fallback) {
  const title = String(value || '').replace(/^[#*\s]+|[#*\s]+$/g, '').replace(/[|\r\n]/g, ' ').trim();
  return title ? title.slice(0, 40) : fallback;
}

function normalizeTopicType(value) {
  return TOPIC_TYPES.has(value) ? value : 'content';
}

function normalizeCards(rawCards, chunk, chunkIndex) {
  const validParagraphIds = new Set(chunk.map((paragraph) => paragraph.id));
  const cards = [];
  for (const rawCard of Array.isArray(rawCards) ? rawCards : []) {
    const paragraphIds = [...new Set((Array.isArray(rawCard?.paragraphIds) ? rawCard.paragraphIds : [])
      .map(String).filter((id) => validParagraphIds.has(id)))];
    if (!paragraphIds.length) continue;
    cards.push({
      title: cleanTitle(rawCard.title, `第 ${chunkIndex + 1} 部分`),
      type: normalizeTopicType(rawCard.type),
      paragraphIds,
      emphasis: clamp(Math.round(Number(rawCard.emphasis) || 3), 1, 5),
      reason: String(rawCard.reason || '').replace(/[\r\n|]/g, ' ').trim().slice(0, 80)
    });
  }
  if (cards.length) {
    const coveredIds = new Set(cards.flatMap((card) => card.paragraphIds));
    const uncoveredIds = chunk.map((paragraph) => paragraph.id).filter((id) => !coveredIds.has(id));
    const uncoveredGroups = [];
    for (const id of uncoveredIds) {
      const current = uncoveredGroups.at(-1);
      const number = Number(id.slice(1));
      const previousNumber = current?.length ? Number(current.at(-1).slice(1)) : null;
      if (current && number === previousNumber + 1) current.push(id);
      else uncoveredGroups.push([id]);
    }
    for (const group of uncoveredGroups) {
      cards.push({
        title: `第 ${chunkIndex + 1} 部分的其他内容`,
        type: 'content',
        paragraphIds: group,
        emphasis: 2,
        reason: '这些段落未被模型归入其他主题，自动保留。'
      });
    }
    return cards;
  }
  return [{
    title: `第 ${chunkIndex + 1} 部分`,
    type: 'content',
    paragraphIds: chunk.map((paragraph) => paragraph.id),
    emphasis: 3,
    reason: '模型未返回可解析的主题结构，按原始分段保留。'
  }];
}

function refineCardType(card, paragraphMap) {
  const text = card.paragraphIds.map((id) => paragraphMap.get(id)?.text || '').join('\n');
  const titleLooksLikeMusic = /歌词|背景音乐|歌曲播放|开场音乐/.test(card.title);
  const speakerAnalyzesLyrics = /(?:这首歌|这段歌词|这句歌词|歌词里|歌词中|歌词表达|歌词反映|歌词讲)/.test(text);
  if (titleLooksLikeMusic && !speakerAnalyzesLyrics) return { ...card, type: 'noise' };
  const noticeTerms = ['报名', '优惠', '福利', '付款', '截止', '便宜', '赠送', '月卡', '进群', '助理', '截图'];
  const noticeScore = noticeTerms.filter((term) => text.includes(term)).length;
  return noticeScore >= 2 ? { ...card, type: 'notice' } : card;
}

async function analyzeChunk(baseUrl, chunk, chunkIndex, chunkCount, signal) {
  const material = chunk.map(formatParagraphForAnalysis).join('\n\n');
  const messages = [
    {
      role: 'system',
      content: '你是中文直播内容分析员。你的任务是识别主题边界和讲师强调程度，不要撰写最终总结。必须以逐字稿为准，不得补充外部事实。/no_think'
    },
    {
      role: 'user',
      content: `分析下面第 ${chunkIndex + 1}/${chunkCount} 段带时间信息的逐字稿。相邻且讨论同一问题的段落归入一个主题。每个主题只输出一行，禁止输出解释、Markdown 或 JSON：\nTOPIC|类型|起始段落-结束段落|强调度|准确具体的主题名|简短依据\n例如：TOPIC|content|P0001-P0008|4|单词记忆方法与学习安排|持续讲解且包含方法步骤\n\n判断规则：\n- content：讲师本人正在讲解的观点、知识、方法、推理、案例分析。\n- notice：报名、优惠、课程时间、群聊通知等事务信息。\n- noise：开场或间歇播放的音乐歌词、寒暄、无内容过渡。即使歌词本身看似有社会含义，只要讲师没有明确分析歌词，就必须标为noise，禁止替讲师解读。\n- 强调度使用1到5，主要看持续时间、反复论证、明确的“重点/核心”表述，以及相对音量或语速的显著变化；不要把高音量直接等同于重要。\n- 不要因内容较短就省略方法、数字、条件或时间节点；它们应保留为独立主题。\n- 每个范围必须使用材料中真实存在的段落编号；所有段落必须且只能出现在一个连续范围内，不能遗漏。\n\n${material}`
    }
  ];
  const output = await chat(baseUrl, messages, signal, 650);
  let parsed = parseTopicLines(output, chunk);
  if (!parsed.length) parsed = extractJsonArray(output);
  if (!parsed) {
    const repaired = await chat(baseUrl, [
      {
        role: 'system',
        content: '把输入改成指定的 TOPIC 单行格式，只输出结果行；不要改变主题含义，不要添加未出现的段落编号。/no_think'
      },
      {
        role: 'user',
        content: `格式：TOPIC|content或notice或noise|起始段落-结束段落|1到5|主题名|依据\n允许使用的段落编号：${chunk.map((paragraph) => paragraph.id).join('、')}\n\n待修复内容：\n${output}`
      }
    ], signal, 650);
    parsed = parseTopicLines(repaired, chunk);
    if (!parsed.length) parsed = extractJsonArray(repaired);
  }
  const cards = normalizeCards(parsed, chunk, chunkIndex);
  for (const card of cards) {
    if (!/^第\s*\d+\s*部分(?:的其他内容)?$/.test(card.title)) continue;
    const source = card.paragraphIds.map((id) => chunk.find((paragraph) => paragraph.id === id)?.text || '').join('\n');
    const title = await chat(baseUrl, [
      {
        role: 'system',
        content: '为逐字稿片段拟一个6到18字的具体中文主题名，只输出主题名，不要引号、标题符号或解释。禁止使用“其他内容”“补充内容”“第几部分”。/no_think'
      },
      { role: 'user', content: source }
    ], signal, 60);
    card.title = cleanTitle(title.replace(/[“”"']/g, ''), card.title);
  }
  return cards;
}

function paragraphMapFrom(paragraphs) {
  return new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
}

function uniqueParagraphs(ids, paragraphMap) {
  return [...new Set(ids)].map((id) => paragraphMap.get(id)).filter(Boolean)
    .sort((left, right) => left.startMs - right.startMs);
}

function durationOfParagraphs(paragraphs) {
  return paragraphs.reduce((sum, paragraph) => sum + paragraph.durationSeconds, 0);
}

function metadataForNode(node, cardsById, paragraphMap) {
  const leafCards = node.leafCardIds.map((id) => cardsById.get(id)).filter(Boolean);
  const paragraphIds = leafCards.flatMap((card) => card.paragraphIds);
  const paragraphs = uniqueParagraphs(paragraphIds, paragraphMap);
  const timing = paragraphs.length && paragraphs[0].hasExactTiming
    ? formatTimeRange(paragraphs[0].startMs, paragraphs.at(-1).endMs)
    : '无精确时间';
  const emphasis = leafCards.length
    ? (leafCards.reduce((sum, card) => sum + card.emphasis, 0) / leafCards.length).toFixed(1)
    : Number(node.importance || 3).toFixed(1);
  return `${node.id}|${node.type}|${node.title}|${timing}|约${Math.round(durationOfParagraphs(paragraphs) / 60)}分钟|强调${emphasis}`;
}

function normalizePlan(rawPlan, nodes) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const plan = [];
  for (const rawTopic of Array.isArray(rawPlan) ? rawPlan : []) {
    const nodeIds = [...new Set((Array.isArray(rawTopic?.cardIds) ? rawTopic.cardIds : [])
      .map(String).filter((id) => nodesById.has(id)))];
    if (!nodeIds.length) continue;
    const selected = nodeIds.map((id) => nodesById.get(id));
    plan.push({
      title: cleanTitle(rawTopic.title, selected[0].title),
      type: normalizeTopicType(rawTopic.type || selected[0].type),
      importance: clamp(Math.round(Number(rawTopic.importance) || 3), 1, 5),
      leafCardIds: [...new Set(selected.flatMap((node) => node.leafCardIds))]
    });
  }
  if (plan.length) {
    const coveredNodeIds = new Set((Array.isArray(rawPlan) ? rawPlan : []).flatMap((topic) => (
      Array.isArray(topic?.cardIds) ? topic.cardIds.map(String) : []
    )));
    for (const node of nodes) {
      if (!coveredNodeIds.has(node.id) && node.type !== 'noise') {
        plan.push({
          title: node.title,
          type: node.type,
          importance: node.importance,
          leafCardIds: node.leafCardIds
        });
      }
    }
    return plan;
  }
  return nodes.map((node) => ({
    title: node.title,
    type: node.type,
    importance: node.importance,
    leafCardIds: node.leafCardIds
  }));
}

async function mergeNodeBatch(baseUrl, nodes, cardsById, paragraphMap, signal) {
  const metadata = nodes.map((node) => metadataForNode(node, cardsById, paragraphMap)).join('\n');
  const output = await chat(baseUrl, [
    {
      role: 'system',
      content: '你是中文内容架构编辑。只合并确实讨论同一中心问题的主题卡；不同的论证阶段、方法主题和课程通知不要粗暴合并。/no_think'
    },
    {
      role: 'user',
      content: `下面每行依次是“卡片编号|类型|主题|时间范围|时长|强调度”。合并跨分段重复出现的同一主题。每个合并结果只输出一行，禁止解释、Markdown 或 JSON：\nGROUP|类型|重要度|卡片编号（多个用逗号）|具体主题名|简短依据\n例如：GROUP|content|5|C001,C006|面对失败的强者逻辑|长时间反复论证\n\n重要度使用1到5，综合主题持续时间、反复论证、明确强调和信息密度；notice 不因促销话术重复而提高正文权重。每个正文主题通常包含1到3张卡片，禁止把仅仅都与“成长”“失败”“社会”等宽泛概念相关、但推理阶段不同的卡片合并成一个大主题。保持主题首次出现的顺序，课程通知放在正文主题之后，noise 可以删除。\n\n${metadata}`
    }
  ], signal, 800);
  const parsed = parsePlanLines(output);
  return normalizePlan(parsed.length ? parsed : extractJsonArray(output), nodes);
}

async function buildTopicPlan(baseUrl, cards, paragraphMap, signal) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  let nodes = cards.map((card) => ({
    id: card.id,
    title: card.title,
    type: card.type,
    importance: card.emphasis,
    leafCardIds: [card.id]
  }));
  let depth = 0;
  while (nodes.map((node) => metadataForNode(node, cardsById, paragraphMap)).join('\n').length > PLAN_INPUT_CHARS && depth < 3) {
    const batches = [];
    let batch = [];
    let batchLength = 0;
    for (const node of nodes) {
      const length = metadataForNode(node, cardsById, paragraphMap).length + 1;
      if (batch.length && batchLength + length > Math.floor(PLAN_INPUT_CHARS * 0.75)) {
        batches.push(batch);
        batch = [];
        batchLength = 0;
      }
      batch.push(node);
      batchLength += length;
    }
    if (batch.length) batches.push(batch);
    const merged = [];
    for (const batchNodes of batches) {
      const batchPlan = await mergeNodeBatch(baseUrl, batchNodes, cardsById, paragraphMap, signal);
      for (const item of batchPlan) {
        merged.push({ ...item, id: `G${depth + 1}-${String(merged.length + 1).padStart(3, '0')}` });
      }
    }
    if (merged.length >= nodes.length) break;
    nodes = merged;
    depth += 1;
  }
  const metadataLength = nodes.map((node) => metadataForNode(node, cardsById, paragraphMap)).join('\n').length;
  const plan = nodes.length > 1 && metadataLength <= PLAN_INPUT_CHARS
    ? await mergeNodeBatch(baseUrl, nodes, cardsById, paragraphMap, signal)
    : normalizePlan(null, nodes);
  const paragraphStart = (topic) => {
    const ids = topic.leafCardIds.flatMap((id) => cardsById.get(id)?.paragraphIds || []);
    return uniqueParagraphs(ids, paragraphMap)[0]?.startMs ?? Number.MAX_SAFE_INTEGER;
  };
  return plan.sort((left, right) => {
    if (left.type === 'notice' && right.type !== 'notice') return 1;
    if (right.type === 'notice' && left.type !== 'notice') return -1;
    return paragraphStart(left) - paragraphStart(right);
  });
}

function refineTopicPlan(plan, cardsById, paragraphMap) {
  const refined = [];
  const notices = [];
  const usedCardIds = new Set();
  const titleBigrams = (title) => {
    const normalized = String(title || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '');
    const grams = new Set();
    for (let index = 0; index < normalized.length - 1; index += 1) grams.add(normalized.slice(index, index + 2));
    return grams;
  };
  const titleSimilarity = (left, right) => {
    const leftGrams = titleBigrams(left);
    const rightGrams = titleBigrams(right);
    if (!leftGrams.size || !rightGrams.size) return 0;
    let overlap = 0;
    for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
    return overlap / Math.min(leftGrams.size, rightGrams.size);
  };
  const cardBounds = (card) => {
    const source = uniqueParagraphs(card.paragraphIds, paragraphMap);
    return { startMs: source[0]?.startMs ?? 0, endMs: source.at(-1)?.endMs ?? 0 };
  };
  for (const topic of plan) {
    const leafCards = topic.leafCardIds.map((id) => cardsById.get(id)).filter(Boolean).sort((left, right) => (
      cardBounds(left).startMs - cardBounds(right).startMs
    ));
    const genericTitle = /^(?:其他内容|补充内容|第\s*\d+\s*部分(?:的其他内容)?)$/.test(topic.title);
    const normalizedTopic = genericTitle && leafCards[0] ? { ...topic, title: leafCards[0].title } : topic;
    const containsMixedTypes = new Set(leafCards.map((card) => card.type)).size > 1;
    const typeDisagrees = leafCards.some((card) => card.type !== normalizedTopic.type);
    const semanticallyDisconnected = leafCards.some((card, index) => {
      if (!index) return false;
      const previous = leafCards[index - 1];
      const gapMs = cardBounds(card).startMs - cardBounds(previous).endMs;
      return gapMs > 120000 && titleSimilarity(previous.title, card.title) < 0.2;
    });
    const overBroad = normalizedTopic.type === 'content' && leafCards.length > 3;
    const mustSplit = containsMixedTypes || typeDisagrees || semanticallyDisconnected || overBroad;
    let candidates = [normalizedTopic];
    if (mustSplit) {
      const orderedCards = [...leafCards].sort((left, right) => {
        const leftStart = paragraphMap.get(left.paragraphIds[0])?.startMs ?? Number.MAX_SAFE_INTEGER;
        const rightStart = paragraphMap.get(right.paragraphIds[0])?.startMs ?? Number.MAX_SAFE_INTEGER;
        return leftStart - rightStart;
      });
      candidates = [];
      const groupSize = semanticallyDisconnected || containsMixedTypes || typeDisagrees ? 1 : 3;
      for (let index = 0; index < orderedCards.length; index += groupSize) {
        const group = orderedCards.slice(index, index + groupSize);
        const groupType = new Set(group.map((card) => card.type)).size === 1 ? group[0].type : null;
        if (!groupType) {
          candidates.push(...group.map((card) => ({
            title: card.title,
            type: card.type,
            importance: card.emphasis,
            leafCardIds: [card.id]
          })));
          continue;
        }
        const title = group.length === 1
          ? group[0].title
          : cleanTitle(`${genericTitle ? group[0].title : normalizedTopic.title}：${group[0].title}`, group[0].title);
        candidates.push({
          title,
          type: groupType,
          importance: Math.round(group.reduce((sum, card) => sum + card.emphasis, 0) / group.length),
          leafCardIds: group.map((card) => card.id)
        });
      }
    }
    for (const candidate of candidates) {
      const freshIds = candidate.leafCardIds.filter((id) => !usedCardIds.has(id));
      if (!freshIds.length) continue;
      for (const id of freshIds) usedCardIds.add(id);
      const normalized = { ...candidate, leafCardIds: freshIds };
      if (normalized.type === 'noise') continue;
      if (normalized.type === 'notice') notices.push(normalized);
      else refined.push(normalized);
    }
  }
  if (notices.length) {
    refined.push({
      title: '课程安排与通知',
      type: 'notice',
      importance: Math.min(3, Math.max(...notices.map((topic) => topic.importance))),
      leafCardIds: [...new Set(notices.flatMap((topic) => topic.leafCardIds))]
    });
  }
  const firstStart = (topic) => topicParagraphs(topic, cardsById, paragraphMap)[0]?.startMs ?? Number.MAX_SAFE_INTEGER;
  return refined.sort((left, right) => {
    if (left.type === 'notice' && right.type !== 'notice') return 1;
    if (right.type === 'notice' && left.type !== 'notice') return -1;
    return firstStart(left) - firstStart(right);
  });
}

function mergeTimeRanges(paragraphs, maxGapMs = 45000) {
  const ranges = [];
  for (const paragraph of [...paragraphs].sort((left, right) => left.startMs - right.startMs)) {
    const current = ranges.at(-1);
    if (current && paragraph.startMs <= current.endMs + maxGapMs) {
      current.endMs = Math.max(current.endMs, paragraph.endMs);
    } else {
      ranges.push({ startMs: paragraph.startMs, endMs: paragraph.endMs });
    }
  }
  return ranges;
}

function detailSignalCount(text) {
  const source = String(text || '');
  const numbers = source.match(/\d+(?:\.\d+)?/g) || [];
  const markers = source.match(/第一|第二|第三|首先|其次|然后|最后|步骤|方法|核心|重点|前提|条件|截止|之前|之后/g) || [];
  return numbers.length + markers.length;
}

function calculateTargetCharacters({ sourceChars, durationSeconds, importance, type, text = '' }) {
  if (type === 'notice') {
    return clamp(Math.round(110 + sourceChars * 0.07 + detailSignalCount(text) * 10), 180, 550);
  }
  const emphasisMultiplier = 0.78 + clamp(importance, 1, 5) * 0.1;
  const durationMinutes = durationSeconds / 60;
  const target = (120 + sourceChars * 0.065 + durationMinutes * 14 + detailSignalCount(text) * 10) * emphasisMultiplier;
  return clamp(Math.round(target), 160, 1150);
}

function cleanSectionOutput(output) {
  return String(output || '').replace(/^#{1,6}\s+[^\n]+\n+/u, '').trim();
}

function normalizeNumericClaim(value) {
  return String(value || '').replace(/,/g, '').replace(/％/g, '%');
}

function extractNumericClaims(text) {
  const source = String(text || '');
  const matches = [...source.matchAll(NUMERIC_CLAIM_PATTERN)];
  return matches.map((match) => ({
    raw: match[0],
    normalized: normalizeNumericClaim(match[0]),
    context: source.slice(Math.max(0, match.index - 18), Math.min(source.length, match.index + match[0].length + 18))
      .replace(/\s+/g, ' ').trim()
  }));
}

function unsupportedNumericClaims(summary, source) {
  const sourceClaims = new Set(extractNumericClaims(source).map((claim) => claim.normalized));
  const seen = new Set();
  return extractNumericClaims(summary).filter((claim) => {
    if (sourceClaims.has(claim.normalized) || seen.has(claim.normalized)) return false;
    seen.add(claim.normalized);
    return true;
  });
}

function formatParagraphForReview(paragraph) {
  const timing = paragraph.hasExactTiming ? formatTimeRange(paragraph.startMs, paragraph.endMs) : '无精确时间';
  return `[${paragraph.id} | ${timing}]\n${paragraph.text}`;
}

function reviewSource(block) {
  return block.map(formatParagraphForReview).join('\n\n');
}

function cleanReviewField(value, maximum = 180) {
  return String(value || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function reviewReasonAffirmsSupport(reason) {
  const text = String(reason || '');
  if (/不支持|无法支持|不能支持|未能支持|不足以支持|没有(?:原文|证据|依据)|错误|矛盾|偷换|扩大|遗漏|倒置/.test(text)) {
    return false;
  }
  return /合理概括|合理改写|合理转述|原文(?:能够|可以|足以)?支持|有(?:原文|证据|依据)/.test(text);
}

function parseReviewOutput(output, validParagraphIds = []) {
  const validIds = new Set(validParagraphIds);
  const issues = [];
  let passed = false;
  let issueLineCount = 0;
  let supportedLineCount = 0;
  for (const rawLine of String(output || '').replace(/｜/g, '|').split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    if (/^VERDICT\s*\|\s*PASS\s*$/i.test(line)) {
      passed = true;
      continue;
    }
    if (!/^ISSUE\s*\|/i.test(line)) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 4) continue;
    issueLineCount += 1;
    const reason = cleanReviewField(parts.slice(3).join(' '), 220) || '未说明具体理由';
    if (reviewReasonAffirmsSupport(reason)) {
      supportedLineCount += 1;
      continue;
    }
    const paragraphIds = [...new Set((parts[1].match(/P\d+/gi) || [])
      .map((id) => id.toUpperCase()).filter((id) => validIds.has(id)))];
    issues.push({
      paragraphIds,
      claim: cleanReviewField(parts[2], 140) || '存在无法确认的陈述',
      reason
    });
  }
  if (issues.length) return { passed: false, issues: issues.slice(0, 3), raw: String(output || '') };
  if (passed || (issueLineCount > 0 && supportedLineCount === issueLineCount)) {
    return { passed: true, issues: [], raw: String(output || '') };
  }
  return {
    passed: false,
    issues: [{
      paragraphIds: [],
      claim: '审核结果格式异常',
      reason: cleanReviewField(output, 220) || '审核模型没有返回可解析的结论'
    }],
    raw: String(output || '')
  };
}

async function reviewTopicBlock(baseUrl, topic, block, draft, focus, signal, chatFn = chat, allowPass = false) {
  const validParagraphIds = block.map((paragraph) => paragraph.id);
  const verdictInstruction = allowPass
    ? '如果所有陈述都能被原文以合理概括或同义改写的方式支持，只输出：\nVERDICT|PASS'
    : '这是反方质询轮，只提出一个最可能改变读者理解的最强质疑，不允许直接输出PASS。质疑可以最终被作者驳回，但必须具体到一个陈述。';
  const messages = [
    {
      role: 'system',
      content: '你是对总结稿持怀疑态度的中文事实审核员。审查目标是总结是否忠实转述讲师，而不是核查讲师观点在现实世界是否正确。只判断语义是否得到对应原文支持，不要因为同义改写、口语转书面语、删除重复或合理压缩而挑错；只质疑会实质改变人物、事实、因果、条件、范围或确定性的陈述。只要总结明确归因于讲师并保留了“据说、猜测、希望、不知道”等边界，就不要因原文没有外部证据而质疑。禁止用常识替原文补证据。/no_think'
    },
    {
      role: 'user',
      content: `审核主题“${topic.title}”的总结稿。${focus}\n\n特别规则：如果原文说“我不知道他怎么做，只希望他是这样做的”，而总结写成“他这样做并因此成功”，必须质疑，不能当作合理概括。讲师亲口表达的观点、判断或比喻不需要外部事实证明；只需检查总结有没有准确归因和保留原有语气。\n\n每个确实无法充分支持的问题只输出一行：\nISSUE|证据段落编号（多个用逗号；找不到证据写NONE）|总结中的争议陈述|原文为何不能充分支持\n不要输出“原文支持”“合理概括”或“合理改写”的句子，它们不是问题。${verdictInstruction}\n禁止输出修改稿、解释、Markdown或其他内容。\n\n【对应原文】\n${reviewSource(block)}\n\n【待审核总结】\n${draft}`
    }
  ];
  const output = await chatFn(baseUrl, messages, signal, 650);
  let parsed = parseReviewOutput(output, validParagraphIds);
  if (parsed.issues[0]?.claim !== '审核结果格式异常' && (allowPass || !parsed.passed)) {
    return allowPass ? parsed : { ...parsed, issues: parsed.issues.slice(0, 1) };
  }

  const repaired = await chatFn(baseUrl, [
    {
      role: 'system',
      content: allowPass
        ? '把审核意见整理为指定单行格式，不得新增或删除质疑。只输出 ISSUE 行；如果原意见明确表示全部通过，只输出 VERDICT|PASS。/no_think'
        : '你是反方质询员。上次回复没有完成质询。只提出一个最可能改变读者理解的具体陈述，只输出一行 ISSUE，不允许PASS。不要把合理概括或缺少外部证据当成问题。/no_think'
    },
    {
      role: 'user',
      content: allowPass
        ? `允许使用的段落编号：${validParagraphIds.join('、')}\n格式：ISSUE|P0001,P0002或NONE|争议陈述|质疑理由\n\n待整理内容：\n${output}`
        : `允许使用的段落编号：${validParagraphIds.join('、')}\n格式：ISSUE|P0001,P0002或NONE|争议陈述|原文为何不能充分支持\n\n【对应原文】\n${reviewSource(block)}\n\n【待审总结】\n${draft}`
    }
  ], signal, 500);
  parsed = parseReviewOutput(repaired, validParagraphIds);
  return allowPass ? parsed : { ...parsed, issues: parsed.issues.slice(0, 1) };
}

function formatIssuesForRevision(issues) {
  return issues.map((issue, index) => (
    `${index + 1}. 证据段落：${issue.paragraphIds.join('、') || '未找到'}；争议陈述：${issue.claim}；质疑理由：${issue.reason}`
  )).join('\n');
}

function normalizedComparableText(text) {
  return String(text || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '').toLowerCase();
}

function textBigrams(text) {
  const source = normalizedComparableText(text);
  const grams = new Set();
  for (let index = 0; index < source.length - 1; index += 1) grams.add(source.slice(index, index + 2));
  return grams;
}

function textSimilarity(left, right) {
  const leftGrams = textBigrams(left);
  const rightGrams = textBigrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return overlap / Math.min(leftGrams.size, rightGrams.size);
}

function claimAppearsInText(claim, text) {
  const normalizedClaim = normalizedComparableText(claim);
  const normalizedText = normalizedComparableText(text);
  if (normalizedClaim.length >= 8 && normalizedText.includes(normalizedClaim)) return true;
  const sentences = String(text || '').split(/(?<=[。！？!?；;])/u).map((item) => item.trim()).filter(Boolean);
  return sentences.some((sentence) => textSimilarity(claim, sentence) >= 0.62);
}

function recurringReviewIssues(history, finalText, minimumRounds = 2) {
  const groups = [];
  for (const entry of history) {
    for (const issue of entry.issues) {
      let group = groups.find((candidate) => candidate.items.some((item) => (
        textSimilarity(item.issue.claim, issue.claim) >= 0.68
      )));
      if (!group) {
        group = { items: [] };
        groups.push(group);
      }
      group.items.push({ round: entry.round, issue });
    }
  }
  return groups.flatMap((group) => {
    const rounds = new Set(group.items.map((item) => item.round));
    const remaining = [...group.items].reverse().find((item) => claimAppearsInText(item.issue.claim, finalText));
    return rounds.size >= minimumRounds && remaining ? [remaining.issue] : [];
  });
}

function formatChallengeHistory(history, maximum = 1200) {
  const lines = history.flatMap((entry) => entry.issues.map((issue) => (
    `第${entry.round}轮：${cleanReviewField(issue.claim, 100)}；${cleanReviewField(issue.reason, 140)}`
  )));
  let result = '';
  for (const line of lines) {
    const candidate = result ? `${result}\n- ${line}` : `- ${line}`;
    if (candidate.length > maximum) break;
    result = candidate;
  }
  return result || '- 前三轮没有留下可解析的质疑。';
}

function containsLongSourceCopy(text, source, length = 32) {
  const candidate = normalizedComparableText(text);
  const material = normalizedComparableText(source);
  if (candidate.length < length || material.length < length) return false;
  for (let index = 0; index <= candidate.length - length; index += 1) {
    if (material.includes(candidate.slice(index, index + length))) return true;
  }
  return false;
}

function perspectivePronounCount(text) {
  return (String(text || '').match(/我们|你们|咱们|我|你/gu) || []).length;
}

function revisionIsUsable(draft, revision, source) {
  const before = String(draft || '').trim();
  const after = String(revision || '').trim();
  if (!after) return false;
  const beforeHan = (before.match(/[\p{Script=Han}]/gu) || []).length;
  const afterHan = (after.match(/[\p{Script=Han}]/gu) || []).length;
  if (beforeHan >= 60 && (afterHan < beforeHan * 0.55 || afterHan > beforeHan * 1.45)) return false;
  if (perspectivePronounCount(after) > Math.max(2, perspectivePronounCount(before) + 1)) return false;
  if (!containsLongSourceCopy(before, source) && containsLongSourceCopy(after, source)) return false;
  return true;
}

async function reviseTopicBlock(baseUrl, topic, block, draft, issues, signal, chatFn = chat) {
  const output = await chatFn(baseUrl, [
    {
      role: 'system',
      content: '你是总结稿作者，正在回应事实审核员的质疑。逐项对照原文：质疑成立就保守修正或删除；原文确有支持则保留准确含义。不得为了回应质疑而添加新的事实。必须保留猜测、希望、听说、不确定和讲师明确不知道等语气边界。/no_think'
    },
    {
      role: 'user',
      content: `修订主题“${topic.title}”的正文。直接输出完整修订稿，不要输出标题、时间、答辩过程或修改说明。未被质疑的句子尽量原样保留，只改动需要纠正的内容；修订后总篇幅不得超过当前总结的120%。继续使用第三人称书面语，不得退回“我、你、我们”的直播口语，不得从原文连续照抄。\n\n【对应原文】\n${reviewSource(block)}\n\n【当前总结】\n${draft}\n\n【审核质疑】\n${formatIssuesForRevision(issues)}`
    }
  ], signal, clamp(Math.ceil(draft.length * 1.35), 450, 1550));
  const revision = cleanSectionOutput(output);
  const source = block.map((paragraph) => paragraph.text).join('\n');
  return revisionIsUsable(draft, revision, source) ? revision : draft;
}

async function correctUnsupportedNumbers(baseUrl, topic, block, draft, claims, signal, chatFn = chat) {
  const output = await chatFn(baseUrl, [
    {
      role: 'system',
      content: '你是数字校对员。只纠正总结中无法在对应原文找到的数字、日期、金额、比例或数量；以原文数字为准。能确定正确值就直接替换，无法确定就删除该数字化断言。不得改写其他内容，不得增加新事实。/no_think'
    },
    {
      role: 'user',
      content: `校对主题“${topic.title}”的完整正文，直接输出校正后的正文，不要标题或说明。\n\n未通过硬校验的数字：\n${claims.map((claim) => `- ${claim.raw}（上下文：${claim.context}）`).join('\n')}\n\n【对应原文】\n${reviewSource(block)}\n\n【当前总结】\n${draft}`
    }
  ], signal, clamp(Math.ceil(draft.length * 1.25), 450, 1550));
  const revision = cleanSectionOutput(output);
  const source = block.map((paragraph) => paragraph.text).join('\n');
  return revisionIsUsable(draft, revision, source) ? revision : draft;
}

async function ensureNumericConsistency(baseUrl, topic, block, draft, signal, chatFn = chat) {
  const source = block.map((paragraph) => paragraph.text).join('\n');
  let text = draft;
  let unsupported = unsupportedNumericClaims(text, source);
  for (let attempt = 0; unsupported.length && attempt < 2; attempt += 1) {
    text = await correctUnsupportedNumbers(baseUrl, topic, block, text, unsupported, signal, chatFn);
    unsupported = unsupportedNumericClaims(text, source);
  }
  return { text, unsupported };
}

function paragraphsForIssue(issue, block) {
  const selected = new Set(issue.paragraphIds || []);
  const paragraphs = selected.size ? block.filter((paragraph) => selected.has(paragraph.id)) : block;
  return paragraphs.length ? paragraphs : block;
}

function formatRiskTime(issue, block) {
  const paragraphs = paragraphsForIssue(issue, block);
  if (!paragraphs.length || !paragraphs[0].hasExactTiming) return '无精确时间';
  return mergeTimeRanges(paragraphs).map((range) => formatTimeRange(range.startMs, range.endMs)).join('、');
}

function riskFromIssue(topic, block, issue) {
  return {
    topic: topic.title,
    time: formatRiskTime(issue, block),
    claim: cleanReviewField(issue.claim, 140),
    reason: cleanReviewField(issue.reason, 220)
  };
}

function buildRiskAppendix(risks) {
  if (!risks.length) return '';
  const entries = risks.map((risk) => (
    `- **${risk.time}｜${risk.topic}**：${risk.claim}。质疑理由：${risk.reason}`
  )).join('\n');
  return `## 审核风险提示\n\n> 以下内容经过三轮质询与修正后，终审仍无法从对应时间段的逐字稿中充分确认。正文保留最后修订版本，请结合时间标签回看原视频。\n\n${entries}`;
}

async function debateAndReviseTopicBlock({
  baseUrl,
  topic,
  block,
  draft,
  signal,
  chatFn = chat,
  onReview = () => {}
}) {
  let numericResult = await ensureNumericConsistency(baseUrl, topic, block, draft, signal, chatFn);
  let text = numericResult.text;
  const challengeHistory = [];
  for (let round = 0; round < REVIEW_ROUNDS; round += 1) {
    const earlierClaims = challengeHistory.flatMap((entry) => entry.issues.map((issue) => issue.claim));
    const diversityInstruction = earlierClaims.length
      ? `前轮已经质疑：${earlierClaims.map((claim) => `“${cleanReviewField(claim, 80)}”`).join('、')}。本轮应按自己的审查维度寻找不同问题；除非没有其他会改变读者理解的问题，否则不要重复。`
      : '';
    const review = await reviewTopicBlock(
      baseUrl,
      topic,
      block,
      text,
      `${REVIEW_FOCI[round]}${diversityInstruction}`,
      signal,
      chatFn
    );
    challengeHistory.push({ round: round + 1, issues: review.issues });
    if (!review.passed) text = await reviseTopicBlock(baseUrl, topic, block, text, review.issues, signal, chatFn);
    numericResult = await ensureNumericConsistency(baseUrl, topic, block, text, signal, chatFn);
    text = numericResult.text;
    onReview({ phase: 'debate', round: round + 1, totalRounds: REVIEW_ROUNDS });
  }

  const finalReview = await reviewTopicBlock(
    baseUrl,
    topic,
    block,
    text,
    `这是只读终审。综合检查所有事实、数字、因果、否定、条件、范围和确定性，不再提供修改机会。前三轮曾提出以下质疑；只要争议陈述仍在当前总结中且没有被原文充分支持，就必须继续输出 ISSUE，不得因为作者没有修改而默认通过：\n${formatChallengeHistory(challengeHistory)}`,
    signal,
    chatFn,
    true
  );
  onReview({ phase: 'final-review', round: REVIEW_ROUNDS + 1, totalRounds: REVIEW_ROUNDS + 1 });

  const consensusIssues = recurringReviewIssues([
    ...challengeHistory,
    { round: REVIEW_ROUNDS + 1, issues: finalReview.issues }
  ], text);
  const risks = consensusIssues.map((issue) => riskFromIssue(topic, block, issue));
  for (const claim of numericResult.unsupported) {
    risks.push(riskFromIssue(topic, block, {
      paragraphIds: [],
      claim: `数字“${claim.raw}”在自动校正后仍未通过硬校验`,
      reason: `对应原文中没有找到相同数字；所在语句为“${claim.context}”`
    }));
  }
  return { text, risks };
}

async function writeTopicBlock(baseUrl, topic, block, blockIndex, blockCount, signal) {
  const text = block.map((paragraph) => paragraph.text).join('\n\n');
  const durationSeconds = durationOfParagraphs(block);
  const targetCharacters = calculateTargetCharacters({
    sourceChars: text.length,
    durationSeconds,
    importance: topic.importance,
    type: topic.type,
    text
  });
  const typeInstruction = topic.type === 'notice'
    ? '这是课程安排与通知。完整保留原文实际给出的可执行信息，如具体内容、适用对象、金额、时间、截止点和操作方式；压缩推销语气与重复催促。原文没有给出操作方式时，不得自行补写操作步骤。'
    : '这是正文主题。重点还原讲师的思考路径：由什么问题或前提出发，经过哪些判断、因果关系、转折和论证，最终得到什么结论或建议。方法、步骤、数字、时间和限定条件必须具体写出。例子只保留其在论证中的作用，不必复述枝节。';
  const continuityInstruction = blockCount > 1
    ? `这是该主题原文的第 ${blockIndex + 1}/${blockCount} 段，只写这一段新增的逻辑和细节，避免重复主题总述。`
    : '完整覆盖这组原文中的逻辑和关键细节。';
  const output = await chat(baseUrl, [
    {
      role: 'system',
      content: '你是严谨的中文课程总结编辑，一律使用简体中文。所有事实必须来自输入原文，禁止编造、用常识补全或给讲师的观点添加原文没有的理论标签。必须准确区分讲师确认的事实与讲师的猜测、希望、听说、不知道或不愿求证；不得把后者写成确定事实。统一用第三人称“讲师”叙述。必须用自己的话概括，不得连续照抄原文。优先保留讲师的推理链和可执行细节，删除口头语、机械重复和无关枝节。/no_think'
    },
    {
      role: 'user',
      content: `请为主题“${topic.title}”撰写总结正文，不要输出标题或时间范围。\n${typeInstruction}\n${continuityInstruction}\n篇幅约 ${targetCharacters} 个汉字，可按信息量上下浮动 20%；若原文信息稀疏，可以明显短于目标，绝不能补写。通常使用连贯段落；只有明确的方法步骤、日程或并列条件用简短列表。动笔前检查所有明确出现的数字、日期、先后顺序、条件和截止点，凡与本主题相关都必须保留，不能只写成“介绍了方法和安排”。每一段都应承载原文中的具体判断、因果或细节，不要用泛泛评价凑篇幅；不要写“原文提到”“根据材料”等套话。\n\n${text}`
    }
  ], signal, clamp(Math.ceil(targetCharacters * 1.35), 450, 1550));
  return cleanSectionOutput(output);
}

function topicParagraphs(topic, cardsById, paragraphMap) {
  const paragraphIds = topic.leafCardIds.flatMap((cardId) => cardsById.get(cardId)?.paragraphIds || []);
  return uniqueParagraphs(paragraphIds, paragraphMap);
}

function formatTopicHeading(topic, paragraphs) {
  if (!paragraphs.length || !paragraphs[0].hasExactTiming) return `## ${topic.title}`;
  const ranges = mergeTimeRanges(paragraphs).map((range) => formatTimeRange(range.startMs, range.endMs));
  return `## ${topic.title}（${ranges.join('、')}）`;
}

function buildOverview(plan) {
  const contentTitles = plan.filter((topic) => topic.type === 'content').map((topic) => topic.title);
  const noticeCount = plan.filter((topic) => topic.type === 'notice').length;
  const visibleTitles = contentTitles.slice(0, 5);
  let overview = visibleTitles.length
    ? `这次直播主要围绕${visibleTitles.map((title) => `“${title}”`).join('、')}${contentTitles.length > visibleTitles.length ? '等主题' : ''}展开。`
    : '这次直播以课程安排和相关通知为主。';
  if (noticeCount) overview += ' 文末另行整理了课程安排与通知，保留具体时间、条件和操作信息。';
  return overview;
}

async function summarizeTranscript({
  llamaServerPath,
  modelPath,
  transcript,
  timedParagraphs = null,
  signal,
  onProgress = () => {}
}) {
  const paragraphs = normalizeParagraphs(timedParagraphs, transcript);
  if (!paragraphs.length) throw new Error('逐字稿为空，无法生成总结。');
  const paragraphMap = paragraphMapFrom(paragraphs);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverTail = '';
  const child = spawnManaged(llamaServerPath, [
    '-m', modelPath,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-ngl', '99',
    '-c', '8192',
    '--parallel', '1'
  ], { cwd: path.dirname(llamaServerPath), signal });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { serverTail = `${serverTail}${chunk}`.slice(-10000); });
  }

  try {
    onProgress({ phase: 'loading', percent: 2 });
    await waitForServer(baseUrl, child, signal);
    const analysisChunks = chunkParagraphs(paragraphs, ANALYSIS_CHUNK_CHARS);
    const cards = [];
    for (let index = 0; index < analysisChunks.length; index += 1) {
      const chunkCards = await analyzeChunk(baseUrl, analysisChunks[index], index, analysisChunks.length, signal);
      for (const card of chunkCards) {
        const identified = { ...card, id: `C${String(cards.length + 1).padStart(3, '0')}` };
        cards.push(refineCardType(identified, paragraphMap));
      }
      onProgress({
        phase: 'topics',
        completed: index + 1,
        total: analysisChunks.length,
        percent: 5 + Math.round(((index + 1) / analysisChunks.length) * 45)
      });
    }

    const cardsById = new Map(cards.map((card) => [card.id, card]));
    let plan = await buildTopicPlan(baseUrl, cards, paragraphMap, signal);
    if (!plan.length) {
      plan = [{ title: '直播主要内容', type: 'content', importance: 3, leafCardIds: cards.map((card) => card.id) }];
    }
    plan = refineTopicPlan(plan, cardsById, paragraphMap);
    onProgress({ phase: 'plan', percent: 56 });

    const topicWork = plan.map((topic) => {
      const sourceParagraphs = topicParagraphs(topic, cardsById, paragraphMap);
      return { topic, sourceParagraphs, blocks: chunkParagraphs(sourceParagraphs, SECTION_SOURCE_CHARS) };
    }).filter((item) => item.blocks.length);
    const totalBlocks = topicWork.reduce((sum, item) => sum + item.blocks.length, 0);
    const totalSummarySteps = totalBlocks * (REVIEW_ROUNDS + 2);
    let completedSummarySteps = 0;
    const sections = [];
    const risks = [];
    const reportProgress = (event) => {
      completedSummarySteps += 1;
      onProgress({
        ...event,
        completed: completedSummarySteps,
        total: totalSummarySteps,
        percent: 58 + Math.round((completedSummarySteps / totalSummarySteps) * 40)
      });
    };
    for (const { topic, sourceParagraphs, blocks } of topicWork) {
      const bodies = [];
      for (let index = 0; index < blocks.length; index += 1) {
        const draft = await writeTopicBlock(baseUrl, topic, blocks[index], index, blocks.length, signal);
        reportProgress({ phase: 'draft' });
        const reviewed = await debateAndReviseTopicBlock({
          baseUrl,
          topic,
          block: blocks[index],
          draft,
          signal,
          onReview: reportProgress
        });
        bodies.push(reviewed.text);
        risks.push(...reviewed.risks);
      }
      sections.push(`${formatTopicHeading(topic, sourceParagraphs)}\n\n${bodies.join('\n\n')}`);
    }

    const riskAppendix = buildRiskAppendix(risks);
    const summary = `${buildOverview(plan)}\n\n${sections.join('\n\n')}${riskAppendix ? `\n\n${riskAppendix}` : ''}`.trim();
    onProgress({ phase: 'complete', percent: 100 });
    return {
      text: summary,
      riskCount: risks.length
    };
  } catch (error) {
    if (!signal?.aborted && serverTail) error.message = `${error.message}\n${serverTail.slice(-2500)}`;
    throw error;
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

module.exports = {
  buildOverview,
  buildRiskAppendix,
  calculateTargetCharacters,
  chat,
  chunkParagraphs,
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
  reservePort,
  revisionIsUsable,
  summarizeTranscript,
  unsupportedNumericClaims,
  waitForServer
};
