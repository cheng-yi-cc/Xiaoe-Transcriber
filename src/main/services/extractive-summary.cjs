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
  const display = new Map();
  for (const segment of segmenter.segment(String(text || ''))) {
    if (!segment.isWordLike) continue;
    const original = segment.segment.trim();
    const normalized = original.toLowerCase();
    if (!termsFromText(original).length) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
    if (!display.has(normalized)) display.set(normalized, original);
  }
  return { counts, display };
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
    highlights: selected.slice(0, limit),
    topTerms: rankedTerms.slice(0, 8).map(([term, count]) => ({
      term: term === 'ai' ? 'AI' : (display.get(term) || term),
      count
    }))
  };
}

function cleanExcerpt(text, maxLength = 160) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function buildExtractiveSummary(transcript) {
  const { highlights, topTerms } = selectHighlights(transcript);
  const core = highlights.slice(0, 4);
  const details = highlights.slice(4, 9);
  const topicText = topTerms.length
    ? topTerms.slice(0, 6).map(({ term }) => `“${term}”`).join('、')
    : '若干课程主题';
  const coreLines = core.length
    ? core.map((item) => `- ${cleanExcerpt(item.text)}`).join('\n')
    : '- 未能从文字稿中稳定提取代表性片段。';
  const detailLines = details.length
    ? details.map((item) => `- ${cleanExcerpt(item.text)}`).join('\n')
    : '- 未提取到更多细节。';
  const termLines = topTerms.length
    ? topTerms.slice(0, 6).map(({ term, count }) => `- **${term}**：在文字稿中出现约 ${count} 次，可直接搜索查看上下文。`).join('\n')
    : '- 可直接在完整文字稿中按关键词搜索。';

  return `## 内容概览

文字稿的高频主题集中在 ${topicText}。以下要点直接摘自逐字稿，以避免本地模型补充原文没有的信息。

## 核心观点

${coreLines}

## 重要细节

${detailLines}

## 值得进一步看的部分

${termLines}`;
}

function generatedSummaryIsSupported(summary, transcript) {
  const requiredHeadings = ['## 内容概览', '## 核心观点', '## 重要细节', '## 值得进一步看的部分'];
  if (!requiredHeadings.every((heading) => String(summary || '').includes(heading))) return false;
  const normalizedTranscript = String(transcript || '').toLowerCase().replace(/\s+/g, '');
  const contentLines = String(summary || '').split(/\r?\n/)
    .map((line) => line.replace(/^[-*>#\s]+/, '').replace(/\*+/g, '').trim())
    .filter((line) => line.length >= 8 && !/^未(?:涉及|提取|能)/.test(line));
  if (contentLines.length < 4) return false;

  for (const line of contentLines) {
    const terms = [...new Set(termsFromText(line, SUMMARY_WORDS))];
    if (terms.length < 2) continue;
    let bestSupported = 0;
    for (const anchor of terms) {
      const normalizedAnchor = anchor.replace(/\s+/g, '');
      let position = normalizedTranscript.indexOf(normalizedAnchor);
      while (position >= 0) {
        const window = normalizedTranscript.slice(Math.max(0, position - 360), position + 720);
        const supported = terms.filter((term) => window.includes(term.replace(/\s+/g, ''))).length;
        bestSupported = Math.max(bestSupported, supported);
        position = normalizedTranscript.indexOf(normalizedAnchor, position + normalizedAnchor.length);
      }
    }
    if (bestSupported / terms.length < 0.55) return false;
  }
  return true;
}

module.exports = {
  buildExtractiveSummary,
  excerptUnits,
  generatedSummaryIsSupported,
  selectHighlights,
  termsFromText
};
