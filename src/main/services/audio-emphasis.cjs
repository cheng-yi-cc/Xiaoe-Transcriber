const fsp = require('node:fs/promises');

async function readWaveMetadata(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const header = Buffer.alloc(Math.min(stats.size, 1024 * 1024));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('音频文件不是可识别的 WAV 格式。');
    }
    let offset = 12;
    let format = null;
    let data = null;
    while (offset + 8 <= bytesRead) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      const bodyOffset = offset + 8;
      if (id === 'fmt ' && size >= 16 && bodyOffset + 16 <= bytesRead) {
        format = {
          audioFormat: header.readUInt16LE(bodyOffset),
          channels: header.readUInt16LE(bodyOffset + 2),
          sampleRate: header.readUInt32LE(bodyOffset + 4),
          blockAlign: header.readUInt16LE(bodyOffset + 12),
          bitsPerSample: header.readUInt16LE(bodyOffset + 14)
        };
      }
      if (id === 'data') {
        data = { offset: bodyOffset, size: Math.min(size, Math.max(0, stats.size - bodyOffset)) };
        break;
      }
      offset = bodyOffset + size + (size % 2);
    }
    if (!format || !data) throw new Error('WAV 文件缺少音频格式或数据区。');
    if (format.audioFormat !== 1 || format.bitsPerSample !== 16 || !format.channels || !format.sampleRate) {
      throw new Error('强调分析仅支持 16 位 PCM WAV。');
    }
    return { ...format, ...data };
  } finally {
    await handle.close();
  }
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spokenCharacterCount(text) {
  return (String(text || '').match(/[\p{Script=Han}A-Za-z0-9]/gu) || []).length;
}

async function paragraphRms(handle, metadata, startMs, endMs) {
  const { offset, size, sampleRate, channels, blockAlign } = metadata;
  const totalFrames = Math.floor(size / blockAlign);
  const startFrame = Math.max(0, Math.min(totalFrames, Math.floor((startMs / 1000) * sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil((endMs / 1000) * sampleRate)));
  const buffer = Buffer.alloc(64 * 1024);
  const sampleStride = 4;
  let frame = startFrame;
  let sumSquares = 0;
  let sampleCount = 0;
  while (frame < endFrame) {
    const framesToRead = Math.min(endFrame - frame, Math.floor(buffer.length / blockAlign));
    const byteCount = framesToRead * blockAlign;
    const position = offset + frame * blockAlign;
    const { bytesRead } = await handle.read(buffer, 0, byteCount, position);
    const framesRead = Math.floor(bytesRead / blockAlign);
    if (!framesRead) break;
    for (let localFrame = 0; localFrame < framesRead; localFrame += sampleStride) {
      let channelSquareSum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = buffer.readInt16LE(localFrame * blockAlign + channel * 2) / 32768;
        channelSquareSum += sample * sample;
      }
      sumSquares += channelSquareSum / channels;
      sampleCount += 1;
    }
    frame += framesRead;
  }
  return sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
}

async function addAudioEmphasis(paragraphs, audioPath) {
  const source = Array.isArray(paragraphs) ? paragraphs : [];
  if (!source.length) return source;
  const metadata = await readWaveMetadata(audioPath);
  const handle = await fsp.open(audioPath, 'r');
  try {
    const measured = [];
    for (const paragraph of source) {
      const durationSeconds = Math.max(0.1, (paragraph.endMs - paragraph.startMs) / 1000);
      measured.push({
        ...paragraph,
        durationSeconds,
        rms: await paragraphRms(handle, metadata, paragraph.startMs, paragraph.endMs),
        speechRate: spokenCharacterCount(paragraph.text) / durationSeconds
      });
    }
    const baselineRms = median(measured.map((paragraph) => paragraph.rms).filter((value) => value > 0)) || 1;
    const baselineSpeechRate = median(measured.map((paragraph) => paragraph.speechRate).filter((value) => value > 0)) || 1;
    return measured.map((paragraph) => ({
      ...paragraph,
      volumeRatio: Number((paragraph.rms / baselineRms).toFixed(2)),
      speechRateRatio: Number((paragraph.speechRate / baselineSpeechRate).toFixed(2))
    }));
  } finally {
    await handle.close();
  }
}

module.exports = { addAudioEmphasis, median, readWaveMetadata, spokenCharacterCount };
