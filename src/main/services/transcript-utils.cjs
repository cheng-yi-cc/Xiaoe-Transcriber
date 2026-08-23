const FILLER_CHARACTERS = /[嗯呃哎唉诶欸噢喔呦哟呀嘛咯喽呗哇哦哈嘿哼]/u;
const PUNCTUATION = '，、；：！？,.:;!?…';
const SENTENCE_END = '。！？!?';
const SENTENCE_END_PATTERN = /[。！？!?；;]/;
const CLAUSE_END_PATTERN = /[，、,]/;

function isHanCharacter(character) {
  return character ? /[\p{Script=Han}]/u.test(character) : false;
}

function removeFillerWords(text) {
  const source = String(text || '');
  let result = '';
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (FILLER_CHARACTERS.test(character) && !isHanCharacter(source[index - 1] || '')) {
      let end = index;
      while (source[end + 1] === character) end += 1;
      const after = source[end + 1] || '';
      const isStandalone = end === index && !isHanCharacter(after);
      const isRepeatedRun = end > index;
      if (isStandalone || isRepeatedRun) {
        index = end + 1;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return normalizePunctuation(result);
}

function collapsePunctuation(text) {
  let result = '';
  for (const character of text) {
    const previous = result.slice(-1);
    const currentIsPunct = PUNCTUATION.includes(character);
    const previousIsPunct = previous ? PUNCTUATION.includes(previous) : false;
    if (currentIsPunct && previousIsPunct) {
      if (SENTENCE_END.includes(character) && !SENTENCE_END.includes(previous)) {
        result = `${result.slice(0, -1)}${character}`;
      }
      continue;
    }
    result += character;
  }
  return result;
}

function normalizePunctuation(text) {
  return String(text || '')
    .split('\n')
    .map((line) => collapsePunctuation(line)
      .replace(/^[\s，、；：！？,.:;!?…]+/, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

function cleanWhisperText(raw) {
  return String(raw || '')
    .replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/gm, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function joinLines(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  let joined = '';
  for (const line of lines) {
    joined = joined ? `${joined}${needsSpace(joined, line) ? ' ' : ''}${line}` : line;
  }
  return joined;
}

function splitAfterPunctuation(text, pattern) {
  const parts = [];
  let current = '';
  for (const character of String(text || '')) {
    current += character;
    if (pattern.test(character)) {
      parts.push(current);
      current = '';
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function buildParagraphUnits(text, targetLength) {
  const units = [];
  for (const sentence of splitAfterPunctuation(text, SENTENCE_END_PATTERN)) {
    if (sentence.length <= targetLength) {
      units.push({ text: sentence, closed: true });
      continue;
    }
    let buffer = '';
    for (const clause of splitAfterPunctuation(sentence, CLAUSE_END_PATTERN)) {
      if (buffer && buffer.length + clause.length > targetLength) {
        units.push({ text: buffer, closed: true });
        buffer = clause;
      } else {
        buffer += clause;
      }
      while (buffer.length > targetLength) {
        units.push({ text: buffer.slice(0, targetLength), closed: false });
        buffer = buffer.slice(targetLength);
      }
    }
    if (buffer) units.push({ text: buffer, closed: true });
  }
  return units;
}

function paragraphizeTranscript(raw, targetLength = 160) {
  const text = joinLines(cleanWhisperText(raw));
  if (!text) return '';
  const paragraphs = [];
  let current = '';
  const flushCurrent = () => {
    if (current.trim()) paragraphs.push(current.trim());
    current = '';
  };
  for (const unit of buildParagraphUnits(text, targetLength)) {
    if (!unit.closed) {
      flushCurrent();
      paragraphs.push(unit.text);
      continue;
    }
    const separator = current && needsSpace(current, unit.text) ? ' ' : '';
    if (current && current.length + separator.length + unit.text.length > targetLength) {
      flushCurrent();
    }
    current = current
      ? `${current}${needsSpace(current, unit.text) ? ' ' : ''}${unit.text}`
      : unit.text;
  }
  flushCurrent();
  return paragraphs.join('\n\n');
}

function needsSpace(left, right) {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

function chunkTranscript(text, maxChars = 5200) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      continue;
    }
    if (current && current.length + paragraph.length + 2 > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseSrtTimestamp(value) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(String(value || '').trim());
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  return (((Number(hours) * 60 + Number(minutes)) * 60) + Number(seconds)) * 1000 + Number(milliseconds);
}

function parseSrtSegments(raw) {
  const blocks = String(raw || '').replace(/\r/g, '').trim().split(/\n{2,}/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = /^(\S+)\s*-->\s*(\S+)/.exec(lines[timingIndex]);
    if (!match) continue;
    const startMs = parseSrtTimestamp(match[1]);
    const endMs = parseSrtTimestamp(match[2]);
    const text = lines.slice(timingIndex + 1).join(' ').trim();
    if (startMs === null || endMs === null || endMs < startMs || !text) continue;
    segments.push({ startMs, endMs, text });
  }
  return segments;
}

function buildTimedParagraphs(segments, targetLength = 160) {
  const paragraphs = [];
  let current = null;
  const flush = () => {
    if (current?.text.trim()) paragraphs.push({ ...current, text: current.text.trim() });
    current = null;
  };
  for (const segment of Array.isArray(segments) ? segments : []) {
    const text = String(segment.text || '').trim();
    if (!text) continue;
    const separator = current && needsSpace(current.text, text) ? ' ' : '';
    if (current && current.text.length + separator.length + text.length > targetLength) flush();
    if (!current) {
      current = { startMs: segment.startMs, endMs: segment.endMs, text };
    } else {
      current.text += `${separator}${text}`;
      current.endMs = Math.max(current.endMs, segment.endMs);
    }
  }
  flush();
  return paragraphs;
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatTimeRange(startMs, endMs) {
  return `${formatTimestamp(startMs)}–${formatTimestamp(endMs)}`;
}

function formatTimedTranscript(paragraphs) {
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .map((paragraph) => `[${formatTimeRange(paragraph.startMs, paragraph.endMs)}]\n${paragraph.text}`)
    .join('\n\n');
}

function plainTextFromTimedParagraphs(paragraphs) {
  return (Array.isArray(paragraphs) ? paragraphs : [])
    .map((paragraph) => String(paragraph.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  buildTimedParagraphs,
  chunkTranscript,
  cleanWhisperText,
  formatTimedTranscript,
  formatTimeRange,
  formatTimestamp,
  paragraphizeTranscript,
  parseSrtSegments,
  parseSrtTimestamp,
  plainTextFromTimedParagraphs,
  removeFillerWords
};
