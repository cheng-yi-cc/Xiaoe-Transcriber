function cleanWhisperText(raw) {
  return String(raw || '')
    .replace(/^\s*\[[^\]]*-->[^\]]*\]\s*/gm, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function paragraphizeTranscript(raw, targetLength = 420) {
  const lines = cleanWhisperText(raw).split('\n').filter(Boolean);
  const paragraphs = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length > targetLength) {
      paragraphs.push(current);
      current = line;
    } else {
      current = current ? `${current}${needsSpace(current, line) ? ' ' : ''}${line}` : line;
    }
  }
  if (current) paragraphs.push(current);
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
  paragraphizeTranscript
};
