const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./process-runner.cjs');
const { addAudioEmphasis } = require('./audio-emphasis.cjs');
const {
  buildTimedParagraphs,
  formatTimedTranscript,
  parseSrtSegments,
  plainTextFromTimedParagraphs,
  removeFillerWords
} = require('./transcript-utils.cjs');
const { toSimplifiedChinese } = require('./chinese-conversion.cjs');

async function extractAudio({ ffmpegPath, mediaPath, audioPath, signal, onProgress = () => {} }) {
  let lastTimeSeconds = 0;
  await runProcess(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y',
    '-i', mediaPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-progress', 'pipe:2',
    audioPath
  ], {
    signal,
    cwd: path.dirname(ffmpegPath),
    onLine(line) {
      const match = /^out_time_ms=(\d+)$/.exec(line.trim());
      if (match) {
        lastTimeSeconds = Number(match[1]) / 1_000_000;
        onProgress({ processedSeconds: lastTimeSeconds });
      }
    }
  });
  return { audioPath, processedSeconds: lastTimeSeconds };
}

async function transcribeAudio({ whisperPath, modelPath, audioPath, workDirectory, signal, vadModelPath = null, onProgress = () => {} }) {
  const outputBase = path.join(workDirectory, 'whisper-output');
  const threadCount = Math.max(4, Math.min(12, (os.cpus()?.length || 8) - 2));
  let lastProgress = 0;
  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-l', 'zh',
    '--prompt', '以下是普通话的句子。',
    '--carry-initial-prompt',
    '--beam-size', '5',
    '-t', String(threadCount),
    '-fa',
    '-pp',
    '-osrt',
    '-of', outputBase
  ];
  if (vadModelPath) args.push('--vad', '-vm', vadModelPath);
  await runProcess(whisperPath, args, {
    signal,
    cwd: path.dirname(whisperPath),
    onLine(line) {
      const match = /progress\s*=\s*(\d+)%/i.exec(line);
      if (match) {
        lastProgress = Number(match[1]);
        onProgress({ percent: lastProgress });
      }
    }
  });
  const rawSrt = await fsp.readFile(`${outputBase}.srt`, 'utf8');
  const segments = parseSrtSegments(rawSrt).map((segment) => ({
    ...segment,
    text: toSimplifiedChinese(removeFillerWords(segment.text))
  })).filter((segment) => segment.text.trim());
  let paragraphs = buildTimedParagraphs(segments);
  if (!paragraphs.length) throw new Error('转写引擎没有生成有效文字。');
  paragraphs = await addAudioEmphasis(paragraphs, audioPath);
  const transcript = formatTimedTranscript(paragraphs);
  const plainTranscript = plainTextFromTimedParagraphs(paragraphs);
  onProgress({ percent: 100 });
  return { paragraphs, plainTranscript, transcript };
}

module.exports = { extractAudio, transcribeAudio };
