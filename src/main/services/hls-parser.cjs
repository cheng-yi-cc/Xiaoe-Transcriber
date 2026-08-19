const { isSafeMediaUrl } = require('./url-utils.cjs');

function parseAttributeList(input) {
  const attributes = {};
  const matcher = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  for (const match of input.matchAll(matcher)) {
    const raw = match[2];
    attributes[match[1].toUpperCase()] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attributes;
}

function nonEmptyLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseMasterPlaylist(text, manifestUrl) {
  const lines = nonEmptyLines(text);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = parseAttributeList(lines[index].slice('#EXT-X-STREAM-INF:'.length));
    const uri = lines[index + 1];
    if (!uri || uri.startsWith('#')) continue;
    const url = new URL(uri, manifestUrl).href;
    if (!isSafeMediaUrl(url)) throw new Error('HLS 清单包含不安全的媒体地址。');
    variants.push({
      url,
      bandwidth: Number(attributes.BANDWIDTH || Number.MAX_SAFE_INTEGER),
      resolution: attributes.RESOLUTION || '',
      codecs: attributes.CODECS || ''
    });
  }
  return variants;
}

function selectSpeechVariant(variants) {
  if (!variants.length) return null;
  return [...variants].sort((left, right) => left.bandwidth - right.bandwidth)[0];
}

function parseMediaPlaylist(text, manifestUrl) {
  const lines = nonEmptyLines(text);
  if (!lines[0] || lines[0] !== '#EXTM3U') throw new Error('页面返回的内容不是有效的 HLS 清单。');

  const encrypted = lines.some((line) => {
    if (!line.startsWith('#EXT-X-KEY:')) return false;
    const attributes = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
    return String(attributes.METHOD || '').toUpperCase() !== 'NONE';
  });
  if (encrypted) {
    throw new Error('该视频使用了加密 HLS，第一版不会尝试解密或绕过保护。');
  }
  if (lines.some((line) => line.startsWith('#EXT-X-BYTERANGE'))) {
    throw new Error('该视频使用了暂不支持的 HLS 字节区间格式。');
  }

  const segments = [];
  let pendingDuration = null;
  let mapUrl = null;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const attributes = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      if (attributes.URI) {
        mapUrl = new URL(attributes.URI, manifestUrl).href;
        if (!isSafeMediaUrl(mapUrl)) throw new Error('HLS 清单包含不安全的媒体地址。');
      }
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length));
      continue;
    }
    if (!line.startsWith('#') && pendingDuration !== null) {
      const url = new URL(line, manifestUrl).href;
      if (!isSafeMediaUrl(url)) throw new Error('HLS 清单包含不安全的媒体地址。');
      segments.push({
        url,
        duration: Number.isFinite(pendingDuration) ? pendingDuration : 0
      });
      pendingDuration = null;
    }
  }

  if (!segments.length) throw new Error('HLS 清单中没有可下载的媒体分片。');
  return {
    segments,
    mapUrl,
    isVod: lines.includes('#EXT-X-ENDLIST') || lines.includes('#EXT-X-PLAYLIST-TYPE:VOD'),
    totalDurationSeconds: segments.reduce((sum, segment) => sum + segment.duration, 0)
  };
}

module.exports = {
  parseAttributeList,
  parseMasterPlaylist,
  parseMediaPlaylist,
  selectSpeechVariant
};
