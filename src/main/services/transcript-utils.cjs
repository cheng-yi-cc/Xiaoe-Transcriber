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

module.exports = {
  chunkTranscript,
  cleanWhisperText,
  paragraphizeTranscript,
  removeFillerWords
};
