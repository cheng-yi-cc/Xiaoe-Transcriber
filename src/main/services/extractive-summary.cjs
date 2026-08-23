const STOP_WORDS = new Set([
  '一个', '一些', '一下', '已经', '因为', '所以', '但是', '如果', '然后', '就是', '这个', '那个',
  '这些', '那些', '这里', '那里', '这样', '那样', '什么', '怎么', '可以', '可能', '没有', '不是',
  '我们', '你们', '他们', '自己', '现在', '时候', '里面', '其实', '还是', '比较', '非常', '进行',
  '需要', '觉得', '知道', '看到', '出来', '之后', '之前', '目前', '开始', '最后', '继续', '主要',
  '很多', '大家', '今天', '的话', '东西', '事情', '问题', '部分', '方式', '来说', '比如', '包括',
  '通过', '这边', '那边', '内容', '直播', '老师', '那么', '而且', '或者', '以及',
  '一個', '一些', '一下', '已經', '因為', '所以', '但是', '如果', '然後', '就是', '這個', '那個',
  '這些', '那些', '這裡', '那裡', '這樣', '那樣', '什麼', '怎麼', '可以', '可能', '沒有', '不是',
  '我們', '你們', '他們', '自己', '現在', '時候', '裡面', '其實', '還是', '比較', '非常', '進行',
  '需要', '覺得', '知道', '看到', '出來', '之後', '之前', '目前', '開始', '最後', '繼續', '主要',
  '很多', '大家', '今天', '的話', '東西', '事情', '問題', '部分', '方式', '來說', '比如', '包括',
  '通過', '這邊', '那邊', '內容', '直播', '老師', '那麼', '而且', '或者', '以及', '感覺',
  '你的', '我的', '他的', '它的', '咱们', '咱們', '能够', '能夠', '当中', '當中', '其中',
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'just', 'about', 'you', 'your', 'are', 'to'
]);

const SUMMARY_WORDS = new Set([
  ...STOP_WORDS,
  '材料', '原文', '总结', '观点', '细节', '明确', '提到', '涉及', '进一步', '值得', '核心', '重要'
]);

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function termsFromText(text, stopWords = STOP_WORDS) {
  const terms = [];
  for (const segment of segmenter.segment(String(text || ''))) {
    if (!segment.isWordLike) continue;
    const term = segment.segment.trim().toLowerCase();
    if (!term || stopWords.has(term)) continue;
    if (/^\d+(?:\.\d+)?$/.test(term)) continue;
    if (/^[\p{Script=Han}]$/u.test(term)) continue;
    if (term.length < 2) continue;
    terms.push(term);
  }
  return terms;
}

function splitLongText(text, targetLength = 170) {
  const clauses = String(text || '').split(/(?<=[，,；;：:！？!?])/u).map((item) => item.trim()).filter(Boolean);
  const units = [];
  let current = '';
  const flush = () => {
    if (current.trim()) units.push(current.trim());
    current = '';
  };
  for (const clause of clauses.length ? clauses : [text]) {
    if (clause.length > targetLength * 1.6) {
      flush();
      for (let index = 0; index < clause.length; index += targetLength) {
        units.push(clause.slice(index, index + targetLength).trim());
      }
    } else if (current && current.length + clause.length > targetLength) {
      flush();
      current = clause;
    } else {
      current += clause;
    }
  }
  flush();
  return units.filter((unit) => unit.length >= 24);
}

function excerptUnits(transcript) {
  const paragraphs = String(transcript || '').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return paragraphs.flatMap((paragraph) => splitLongText(paragraph))
    .filter((unit) => (unit.match(/[\p{Script=Han}]/gu) || []).length >= 20);
}

function termStatistics(text) {
  const counts = new Map();
  for (const segment of segmenter.segment(String(text || ''))) {
    if (!segment.isWordLike) continue;
    const normalized = segment.segment.trim().toLowerCase();
    if (!termsFromText(segment.segment).length) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return { counts };
}

function overlapRatio(leftTerms, rightTerms) {
  const left = new Set(leftTerms);
  const right = new Set(rightTerms);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const term of left) if (right.has(term)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

function selectHighlights(transcript, limit = 9) {
  const units = excerptUnits(transcript);
  const { counts, display } = termStatistics(transcript);
  const rankedTerms = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 36);
  const important = new Set(rankedTerms.map(([term]) => term));
  const rankedUnits = units.map((text, index) => {
    const terms = termsFromText(text);
    const unique = new Set(terms);
    let score = 0;
    for (const term of unique) {
      if (important.has(term)) score += Math.log2(2 + (counts.get(term) || 0));
    }
    score /= Math.sqrt(Math.max(40, text.length));
    return { text, index, terms, score };
  }).filter((item) => item.terms.length >= 2);

  const selected = [];
  const add = (candidate) => {
    if (!candidate) return;
    if (selected.some((item) => overlapRatio(item.terms, candidate.terms) > 0.62)) return;
    selected.push(candidate);
  };

  for (const candidate of [...rankedUnits].sort((left, right) => right.score - left.score)) {
    add(candidate);
    if (selected.length >= Math.min(4, limit)) break;
  }
  const sliceCount = Math.min(5, units.length);
  for (let slice = 0; slice < sliceCount && selected.length < limit; slice += 1) {
    const start = Math.floor((units.length * slice) / sliceCount);
    const end = Math.floor((units.length * (slice + 1)) / sliceCount);
    add(rankedUnits.filter((item) => item.index >= start && item.index < end)
      .sort((left, right) => right.score - left.score)[0]);
  }
  for (const candidate of [...rankedUnits].sort((left, right) => right.score - left.score)) {
    add(candidate);
    if (selected.length >= limit) break;
  }

  return {
    highlights: selected.slice(0, limit)
  };
}

function cleanExcerpt(text, maxLength = 160) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function buildExtractiveSummary(transcript) {
  const { highlights } = selectHighlights(transcript);
  const excerptLines = highlights.length
    ? highlights.map((item) => `- ${cleanExcerpt(item.text)}`).join('\n')
    : '- 这份逐字稿过短或结构异常，未能提取代表性片段。';
  return `本地总结模型这次输出的内容没有通过可靠性检查，因此不展示可能失真的概括。以下条目直接摘自逐字稿原文，可快速了解内容脉络；更多信息请阅读同目录下的完整文字稿。\n\n${excerptLines}`;
}

function evaluateGeneratedSummary(summary, transcript) {
  const summaryText = String(summary || '').trim();
  const normalizedTranscript = String(transcript || '').toLowerCase().replace(/\s+/g, '');
  if (!normalizedTranscript) return { supported: false, reason: '逐字稿为空，无法校验。' };

  const hanCount = (summaryText.match(/[\p{Script=Han}]/gu) || []).length;
  if (hanCount < 120) {
    return { supported: false, reason: `总结只有约 ${hanCount} 个汉字，低于 120 字的最低长度要求。` };
  }

  const terms = [...new Set(termsFromText(summaryText, SUMMARY_WORDS))];
  if (!terms.length) return { supported: false, reason: '总结中没有可校验的实词。' };
  const missedTerms = terms
    .filter((term) => !normalizedTranscript.includes(term.replace(/\s+/g, '')));
  const termRatio = 1 - (missedTerms.length / terms.length);
  if (termRatio < 0.6) {
    const samples = missedTerms.slice(0, 8).join('、');
    return {
      supported: false,
      reason: `总结中的实词只有 ${Math.round(termRatio * 100)}% 能在逐字稿原文中找到（要求 60%），未命中的词如：${samples}。`
    };
  }

  const numbers = [...new Set(summaryText.match(/\d{2,}(?:\.\d+)?/gu) || [])];
  if (numbers.length) {
    const missedNumbers = numbers.filter((value) => !normalizedTranscript.includes(value));
    const numberRatio = 1 - (missedNumbers.length / numbers.length);
    if (numberRatio < 0.7) {
      return {
        supported: false,
        reason: `总结中的数字只有 ${Math.round(numberRatio * 100)}% 出现在逐字稿原文中（要求 70%），未命中的数字：${missedNumbers.slice(0, 8).join('、')}。`
      };
    }
  }

  return { supported: true, reason: '' };
}

function generatedSummaryIsSupported(summary, transcript) {
  return evaluateGeneratedSummary(summary, transcript).supported;
}

module.exports = {
  buildExtractiveSummary,
  evaluateGeneratedSummary,
  excerptUnits,
  generatedSummaryIsSupported,
  selectHighlights,
  termsFromText
};
