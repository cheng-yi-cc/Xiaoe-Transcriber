const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  chooseModelAfterInstall,
  DependencyManager,
  selectManifestForModel
} = require('../src/main/services/dependency-manager.cjs');

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'dependencies.json'), 'utf8'));
}

test('selected model manifest includes shared components and exactly one Whisper model', () => {
  const manifest = loadManifest();
  const selected = selectManifestForModel(manifest, 'medium');
  assert.equal(selected.modelOption.id, 'medium');
  assert.ok(selected.components.some((item) => item.id === 'ffmpeg'));
  assert.ok(selected.components.some((item) => item.id === 'whisper-model-medium'));
  assert.equal(selected.components.filter((item) => item.modelOptionId).length, 1);
});

test('downloading an extra model does not replace a ready active model', () => {
  assert.equal(chooseModelAfterInstall('small', true, 'medium'), 'small');
  assert.equal(chooseModelAfterInstall('large-v3-turbo', false, 'medium'), 'medium');
});

test('dependency downloads use pinned files with integrity metadata', () => {
  const manifest = loadManifest();
  for (const component of manifest.components) {
    for (const download of component.downloads) {
      assert.match(download.url, /^https:\/\/(?:github\.com|huggingface\.co)\//);
      assert.doesNotMatch(download.url, /\/(?:latest|main)(?:\/|\?|$)/i);
      assert.match(download.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(download.size) && download.size > 0);
    }
  }
});

test('removing a model preserves shared components and other model directories', async (t) => {
  const rootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-model-remove-'));
  t.after(() => fsp.rm(rootDirectory, { recursive: true, force: true }));

  const manifest = selectManifestForModel(loadManifest(), 'small');
  const manager = new DependencyManager({ rootDirectory, manifest });
  const modelComponent = manifest.components.find((item) => item.modelOptionId === 'small');
  const modelDirectory = manager.componentDirectory(modelComponent.id);
  const sharedDirectory = manager.componentDirectory('ffmpeg');
  const otherModelDirectory = path.join(rootDirectory, 'components', 'whisper-model-medium');
  await fsp.mkdir(modelDirectory, { recursive: true });
  await fsp.mkdir(sharedDirectory, { recursive: true });
  await fsp.mkdir(otherModelDirectory, { recursive: true });
  await fsp.writeFile(path.join(modelDirectory, '.installed.json'), JSON.stringify({ version: modelComponent.version }));
  await fsp.writeFile(path.join(modelDirectory, modelComponent.requiredFiles[0]), 'model');
  await fsp.writeFile(path.join(sharedDirectory, 'keep.txt'), 'shared');
  await fsp.writeFile(path.join(otherModelDirectory, 'keep.txt'), 'other model');

  await manager.removeModel();

  assert.equal(fs.existsSync(modelDirectory), false);
  assert.equal(fs.existsSync(path.join(sharedDirectory, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(otherModelDirectory, 'keep.txt')), true);
});
