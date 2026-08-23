const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { captureAuthorizedReplay } = require('./services/auth-capture.cjs');
const { writeRawModelOutput, writeSummaryFile, writeTranscriptFile } = require('./services/export-service.cjs');
const { makeResultFolderPath, sanitizeWindowsName } = require('./services/file-utils.cjs');
const { downloadHls } = require('./services/hls-downloader.cjs');
const { summarizeTranscript } = require('./services/summarization-service.cjs');
const { extractAudio, transcribeAudio } = require('./services/transcription-service.cjs');

class JobController {
  constructor({ mainWindow, settings, createDependencyManager, onAuthStatus = () => {}, onHistory = () => {} }) {
    this.mainWindow = mainWindow;
    this.settings = settings;
    this.createDependencyManager = createDependencyManager;
    this.onAuthStatus = onAuthStatus;
    this.onHistory = onHistory;
    this.current = null;
  }

  send(event) {
    if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.send('job:progress', event);
  }

  cancel() {
    this.current?.abortController.abort();
  }

  async start({ sourceUrl, jobSettings = null }) {
    if (this.current) throw new Error('已有任务正在运行。');
    const abortController = new AbortController();
    const taskSettings = structuredClone(jobSettings || this.settings.getAll());
    this.current = { abortController, settings: taskSettings };
    const signal = abortController.signal;
    let temporaryDirectory = null;
    let resultDirectory = null;
    let transcriptPath = null;
    let historyRecorded = false;

    try {
      if (!taskSettings.outputDirectory) throw new Error('请先选择文档保存位置。');
      const dependencies = this.createDependencyManager(
        taskSettings.selectedModelId,
        taskSettings.selectedSummaryModelId,
        taskSettings.modelDirectory
      );
      const dependencyStatus = await dependencies.getStatus();
      if (!dependencyStatus.ready) throw new Error('本地模型尚未安装完成。');

      this.send({ stage: 'capture', percent: 2, message: '正在打开小鹅通登录页…' });
      const captured = await captureAuthorizedReplay({
        parent: this.mainWindow,
        sourceUrl,
        signal,
        onStatus: ({ message, authStatus }) => {
          if (authStatus) this.onAuthStatus({ status: authStatus, message });
          this.send({ stage: 'capture', percent: 6, message });
        }
      });

      const title = sanitizeWindowsName(captured.title || '小鹅通视频', 88);
      await fsp.mkdir(taskSettings.outputDirectory, { recursive: true });
      resultDirectory = makeResultFolderPath(taskSettings.outputDirectory, title);
      await fsp.mkdir(resultDirectory, { recursive: false });
      temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-transcription-'));
      const mediaPath = path.join(temporaryDirectory, 'media.bin');
      const audioPath = path.join(temporaryDirectory, 'audio.wav');

      this.send({ stage: 'download', percent: 10, message: `正在下载回放分片（约 ${Math.round(captured.inspected.totalDurationSeconds / 60)} 分钟）…` });
      await downloadHls({
        fetchImpl: fetch,
        manifestUrl: captured.manifestUrl,
        headers: captured.headers,
        signal,
        inspected: captured.inspected,
        destination: mediaPath,
        onProgress: ({ completedSegments, totalSegments }) => {
          const percent = 10 + Math.round((completedSegments / totalSegments) * 25);
          this.send({ stage: 'download', percent, message: `下载视频分片 ${completedSegments}/${totalSegments}` });
        }
      });

      const ffmpegPath = await dependencies.resolveRequiredFile('ffmpeg', 'ffmpeg.exe');
      this.send({ stage: 'audio', percent: 36, message: '正在提取静音音轨…' });
      await extractAudio({
        ffmpegPath,
        mediaPath,
        audioPath,
        signal,
        onProgress: ({ processedSeconds }) => {
          const ratio = Math.min(1, processedSeconds / captured.inspected.totalDurationSeconds);
          this.send({ stage: 'audio', percent: 36 + Math.round(ratio * 6), message: '正在提取静音音轨…' });
        }
      });
      await fsp.rm(mediaPath, { force: true });

      const modelOption = dependencies.manifest.modelOption;
      if (!modelOption) throw new Error('尚未选择转写模型。');
      const whisperPath = await dependencies.resolveRequiredFile('whisper-engine', 'whisper-cli.exe');
      const whisperModelPath = await dependencies.resolveRequiredFile(modelOption.componentId, modelOption.fileName);
      const vadModelPath = await dependencies.resolveRequiredFile('vad-model', 'ggml-silero-v5.1.2.bin');
      this.send({ stage: 'transcribe', percent: 43, message: `${modelOption.label} 正在使用 NVIDIA GPU 转写…` });
      const transcript = await transcribeAudio({
        whisperPath,
        modelPath: whisperModelPath,
        audioPath,
        workDirectory: temporaryDirectory,
        signal,
        vadModelPath,
        onProgress: ({ percent }) => this.send({
          stage: 'transcribe',
          percent: 43 + Math.round((percent / 100) * 32),
          message: `正在转写… ${percent}%`
        })
      });

      transcriptPath = await writeTranscriptFile({
        resultDirectory,
        title,
        sourceUrl,
        transcript
      });
      this.send({ stage: 'summarize', percent: 77, message: '正在加载本地总结模型…', transcriptPath });

      const llamaServerPath = await dependencies.resolveRequiredFile('llama-engine', 'llama-server.exe');
      const summaryOption = dependencies.manifest.summaryOption;
      if (!summaryOption) throw new Error('尚未选择总结模型。');
      const summaryModelPath = await dependencies.resolveRequiredFile(summaryOption.componentId, summaryOption.fileName);
      const { text: summary, modelOutput, gatePassed, gateReason } = await summarizeTranscript({
        llamaServerPath,
        modelPath: summaryModelPath,
        transcript,
        signal,
        onProgress: ({ percent, completed, total }) => this.send({
          stage: 'summarize',
          percent: 77 + Math.round((percent / 100) * 21),
          message: completed ? `正在总结第 ${completed}/${total} 部分…` : '正在生成内容总结…'
        })
      });
      if (!gatePassed) {
        const rawOutputPath = await writeRawModelOutput({
          resultDirectory,
          title,
          sourceUrl,
          output: modelOutput,
          reason: gateReason
        });
        this.send({
          stage: 'summarize',
          percent: 99,
          message: '总结未通过可靠性检查，已改用原文摘录；模型原始输出已保存供排查。',
          rawOutputPath
        });
      }
      const summaryPath = await writeSummaryFile({ resultDirectory, title, sourceUrl, summary });

      const result = { resultDirectory, transcriptPath, summaryPath, title };
      this.onHistory({ title, sourceUrl, resultDirectory, modelId: modelOption.id });
      historyRecorded = true;
      this.send({ stage: 'complete', percent: 100, message: '总结和完整文字稿已生成。', ...result });
      return result;
    } catch (error) {
      if (signal.aborted || error.name === 'AbortError') {
        if (resultDirectory && !transcriptPath) {
          await fsp.rmdir(resultDirectory).catch(() => {});
          resultDirectory = null;
        }
        this.send({ stage: 'cancelled', percent: 0, message: '任务已取消。', resultDirectory, transcriptPath });
        throw new Error('任务已取消。');
      }
      if (resultDirectory && !transcriptPath) {
        await fsp.rmdir(resultDirectory).catch(() => {});
        resultDirectory = null;
      }
      if (resultDirectory && transcriptPath && !historyRecorded) {
        this.onHistory({
          title: path.basename(resultDirectory),
          sourceUrl,
          resultDirectory,
          modelId: taskSettings.selectedModelId
        });
      }
      this.send({ stage: 'error', percent: 0, message: error.message, resultDirectory, transcriptPath });
      throw error;
    } finally {
      if (temporaryDirectory) await fsp.rm(temporaryDirectory, { recursive: true, force: true });
      this.current = null;
    }
  }
}

module.exports = { JobController };
