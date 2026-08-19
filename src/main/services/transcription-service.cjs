const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./process-runner.cjs');
const { paragraphizeTranscript } = require('./transcript-utils.cjs');

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

async function transcribeAudio({ whisperPath, modelPath, audioPath, workDirectory, signal, onProgress = () => {} }) {
  const outputBase = path.join(workDirectory, 'whisper-output');
  const threadCount = Math.max(4, Math.min(12, (os.cpus()?.length || 8) - 2));
  let lastProgress = 0;
  await runProcess(whisperPath, [
    '-m', modelPath,
    '-f', audioPath,
    '-l', 'auto',
    '-t', String(threadCount),
    '-fa',
    '-pp',
    '-otxt',
    '-of', outputBase
  ], {
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
  const raw = await fsp.readFile(`${outputBase}.txt`, 'utf8');
  const transcript = paragraphizeTranscript(raw);
  if (!transcript.trim()) throw new Error('转写引擎没有生成有效文字。');
  onProgress({ percent: 100 });
  return transcript;
}

module.exports = { extractAudio, transcribeAudio };
