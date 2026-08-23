const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function stubModule(relativePath, exports) {
  const modulePath = require.resolve(path.join(__dirname, '..', 'src', 'main', relativePath));
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports
  };
}

test('a running job keeps the settings captured when it started', async (t) => {
  let releaseCapture;
  const captureStarted = new Promise((resolve) => { releaseCapture = resolve; });
  let continueCapture;
  const captureCanFinish = new Promise((resolve) => { continueCapture = resolve; });

  stubModule('services/auth-capture.cjs', {
    captureAuthorizedReplay: async () => {
      releaseCapture();
      await captureCanFinish;
      return {
        title: '快照测试',
        manifestUrl: 'https://example.com/playlist.m3u8',
        headers: {},
        inspected: { totalDurationSeconds: 60 }
      };
    }
  });
  stubModule('services/hls-downloader.cjs', { downloadHls: async () => {} });
  stubModule('services/transcription-service.cjs', {
    extractAudio: async () => {},
    transcribeAudio: async () => '测试逐字稿'
  });
  stubModule('services/summarization-service.cjs', {
    summarizeTranscript: async () => ({
      text: '测试总结',
      modelOutput: '测试总结',
      gatePassed: true,
      gateReason: ''
    })
  });
  stubModule('services/export-service.cjs', {
    writeRawModelOutput: async () => '',
    writeTranscriptFile: async ({ resultDirectory }) => path.join(resultDirectory, '完整文字稿.md'),
    writeSummaryFile: async ({ resultDirectory }) => path.join(resultDirectory, '总结.md')
  });

  const controllerPath = require.resolve('../src/main/job-controller.cjs');
  delete require.cache[controllerPath];
  const { JobController } = require(controllerPath);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-job-settings-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const oldOutputDirectory = path.join(root, 'old-output');
  const newOutputDirectory = path.join(root, 'new-output');
  const factoryCalls = [];
  const historyEntries = [];
  const dependencyManager = {
    manifest: {
      modelOption: { id: 'medium', label: 'Whisper Medium', componentId: 'whisper', fileName: 'whisper.bin' },
      summaryOption: { id: 'qwen3-8b', componentId: 'summary', fileName: 'summary.gguf' }
    },
    getStatus: async () => ({ ready: true }),
    resolveRequiredFile: async (_componentId, fileName) => path.join(root, fileName)
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: { send: () => {} }
  };
  const mutableJobSettings = {
    outputDirectory: oldOutputDirectory,
    modelDirectory: path.join(root, 'old-models'),
    selectedModelId: 'medium',
    selectedSummaryModelId: 'qwen3-8b'
  };
  const controller = new JobController({
    mainWindow,
    settings: { getAll: () => mutableJobSettings },
    createDependencyManager: (...args) => {
      factoryCalls.push(args);
      return dependencyManager;
    },
    onHistory: (entry) => historyEntries.push(entry)
  });

  const runningJob = controller.start({
    sourceUrl: 'https://example.com/replay',
    jobSettings: mutableJobSettings
  });
  await captureStarted;
  mutableJobSettings.outputDirectory = newOutputDirectory;
  mutableJobSettings.modelDirectory = path.join(root, 'new-models');
  mutableJobSettings.selectedModelId = 'large-v3-turbo';
  mutableJobSettings.selectedSummaryModelId = 'qwen2.5-1.5b';
  continueCapture();

  const result = await runningJob;
  assert.deepEqual(factoryCalls, [[
    'medium',
    'qwen3-8b',
    path.join(root, 'old-models')
  ]]);
  assert.ok(result.resultDirectory.startsWith(oldOutputDirectory));
  assert.equal(historyEntries[0].modelId, 'medium');
});
