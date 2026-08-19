const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { parseMasterPlaylist, parseMediaPlaylist, selectSpeechVariant } = require('./hls-parser.cjs');

async function fetchOrThrow(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`${label}失败（HTTP ${response.status}）。`);
  return response;
}

async function inspectHls({ fetchImpl, manifestUrl, headers = {}, signal }) {
  let selectedUrl = manifestUrl;
  let response = await fetchOrThrow(fetchImpl, selectedUrl, { headers, signal }, '读取 HLS 清单');
  let text = await response.text();
  const variants = parseMasterPlaylist(text, selectedUrl);
  if (variants.length) {
    const selected = selectSpeechVariant(variants);
    selectedUrl = selected.url;
    response = await fetchOrThrow(fetchImpl, selectedUrl, { headers, signal }, '读取 HLS 清晰度清单');
    text = await response.text();
  }
  const media = parseMediaPlaylist(text, selectedUrl);
  if (!media.isVod) throw new Error('当前链接看起来仍是直播流；请等待回放生成后再转写。');
  return { ...media, manifestUrl: selectedUrl };
}

async function fetchBufferWithRetry(fetchImpl, url, options, label, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchOrThrow(fetchImpl, url, options, label);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function appendBuffer(stream, buffer) {
  if (!stream.write(buffer)) await once(stream, 'drain');
}

async function downloadHls({
  fetchImpl,
  manifestUrl,
  destination,
  headers = {},
  signal,
  concurrency = 8,
  onProgress = () => {},
  inspected = null
}) {
  const media = inspected || await inspectHls({ fetchImpl, manifestUrl, headers, signal });
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const output = fs.createWriteStream(temporary);
  let bytesWritten = 0;

  try {
    if (media.mapUrl) {
      const map = await fetchBufferWithRetry(fetchImpl, media.mapUrl, { headers, signal }, '下载 HLS 初始化分片');
      await appendBuffer(output, map);
      bytesWritten += map.length;
    }

    for (let start = 0; start < media.segments.length; start += concurrency) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const batch = media.segments.slice(start, start + concurrency);
      const buffers = await Promise.all(batch.map((segment, index) => fetchBufferWithRetry(
        fetchImpl,
        segment.url,
        { headers, signal },
        `下载媒体分片 ${start + index + 1}`
      )));
      for (const buffer of buffers) {
        await appendBuffer(output, buffer);
        bytesWritten += buffer.length;
      }
      onProgress({
        completedSegments: Math.min(start + batch.length, media.segments.length),
        totalSegments: media.segments.length,
        bytesWritten,
        totalDurationSeconds: media.totalDurationSeconds
      });
    }
    output.end();
    await once(output, 'finish');
    await fsp.rename(temporary, destination);
    return { ...media, destination, bytesWritten };
  } catch (error) {
    output.destroy();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

module.exports = { downloadHls, fetchBufferWithRetry, inspectHls };
