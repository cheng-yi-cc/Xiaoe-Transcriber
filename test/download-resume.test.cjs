const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { DependencyManager } = require('../src/main/services/dependency-manager.cjs');

const payload = Buffer.from('0123456789'.repeat(100));
const payloadSha256 = crypto.createHash('sha256').update(payload).digest('hex');

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

function makeComponent() {
  return {
    id: 'test-model',
    label: '测试模型',
    version: 'v1',
    requiredFiles: ['model.bin'],
    downloads: [{
      url: 'https://example.com/model.bin',
      fileName: 'model.bin',
      size: payload.length,
      sha256: payloadSha256
    }]
  };
}

function makeManager(rootDirectory, fetchImpl) {
  return new DependencyManager({
    rootDirectory,
    manifest: { components: [makeComponent()], modelOptions: [], summaryOptions: [] },
    fetchImpl
  });
}

function webBody(chunks, signal) {
  const source = Readable.from(chunks);
  if (signal) {
    const onAbort = () => source.destroy(abortError());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return Readable.toWeb(source);
}

function makeRangeFetch({ honorRange = true } = {}) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.Range || null;
    requests.push({ url, range, signal: options.signal || null });
    if (!honorRange || !range) {
      return { ok: true, status: 200, body: webBody([payload], options.signal) };
    }
    const start = Number(/bytes=(\d+)-/.exec(range)[1]);
    if (start >= payload.length) return { ok: false, status: 416, body: null };
    return { ok: true, status: 206, body: webBody([payload.subarray(start)], options.signal) };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

async function makeRoot(t) {
  const rootDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'xiaoe-resume-'));
  t.after(() => fsp.rm(rootDirectory, { recursive: true, force: true }));
  return rootDirectory;
}

function stagingFile(manager) {
  return path.join(manager.stagingDirectory('test-model'), 'model.bin');
}

function expectInstalledFile(manager) {
  const installed = fs.readFileSync(path.join(manager.componentDirectory('test-model'), 'model.bin'));
  assert.ok(installed.equals(payload));
}

function pauseAfterFirstChunk(controller) {
  const chunks = [payload.subarray(0, 400), payload.subarray(400)];
  return async function* () {
    yield chunks[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!controller.signal.aborted) yield chunks[1];
  };
}

test('fresh download sends no Range header and installs the component', async (t) => {
  const rootDirectory = await makeRoot(t);
  const fetchImpl = makeRangeFetch();
  const manager = makeManager(rootDirectory, fetchImpl);

  await manager.installComponent(makeComponent());

  assert.equal(fetchImpl.requests.length, 1);
  assert.equal(fetchImpl.requests[0].range, null);
  expectInstalledFile(manager);
});

test('resuming keeps existing bytes, sends Range and completes the file', async (t) => {
  const rootDirectory = await makeRoot(t);
  const fetchImpl = makeRangeFetch();
  const manager = makeManager(rootDirectory, fetchImpl);
  const localPath = stagingFile(manager);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, payload.subarray(0, 400));

  await manager.installComponent(makeComponent());

  assert.equal(fetchImpl.requests.length, 1);
  assert.equal(fetchImpl.requests[0].range, 'bytes=400-');
  expectInstalledFile(manager);
});

test('server that ignores Range restarts the download from scratch', async (t) => {
  const rootDirectory = await makeRoot(t);
  const fetchImpl = makeRangeFetch({ honorRange: false });
  const manager = makeManager(rootDirectory, fetchImpl);
  const localPath = stagingFile(manager);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, payload.subarray(0, 400));

  await manager.installComponent(makeComponent());

  assert.equal(fetchImpl.requests[0].range, 'bytes=400-');
  expectInstalledFile(manager);
});

test('a fully downloaded staging file is verified without touching the network', async (t) => {
  const rootDirectory = await makeRoot(t);
  const fetchImpl = makeRangeFetch();
  const manager = makeManager(rootDirectory, fetchImpl);
  const localPath = stagingFile(manager);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await fsp.writeFile(localPath, payload);

  await manager.installComponent(makeComponent());

  assert.equal(fetchImpl.requests.length, 0);
  assert.equal(fs.existsSync(path.join(manager.componentDirectory('test-model'), '.installed.json')), true);
});

test('corrupted staged bytes fail the digest check and get deleted', async (t) => {
  const rootDirectory = await makeRoot(t);
  const manager = makeManager(rootDirectory, makeRangeFetch());
  const localPath = stagingFile(manager);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  const corrupt = Buffer.from(payload.subarray(0, 400));
  corrupt[0] ^= 0xff;
  await fsp.writeFile(localPath, corrupt);

  await assert.rejects(
    () => manager.installComponent(makeComponent()),
    /SHA-256 校验失败/
  );
  assert.equal(fs.existsSync(manager.stagingDirectory('test-model')), false);
});

test('aborting mid-download keeps the staging file for a later resume', async (t) => {
  const rootDirectory = await makeRoot(t);
  const controller = new AbortController();
  const fetchImpl = async (_url, options = {}) => ({
    ok: true,
    status: 200,
    body: webBody(pauseAfterFirstChunk(controller)(), options.signal)
  });
  const manager = makeManager(rootDirectory, fetchImpl);

  await assert.rejects(
    () => manager.installComponent(makeComponent(), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.phase === 'download' && event.fileBytes >= 400) controller.abort();
      }
    }),
    (error) => error.name === 'AbortError'
  );

  const stagedSize = (await fsp.stat(stagingFile(manager))).size;
  assert.ok(stagedSize > 0);
  assert.ok(stagedSize < payload.length);
});

test('resuming after an aborted install completes the model', async (t) => {
  const rootDirectory = await makeRoot(t);
  const controller = new AbortController();
  const abortingFetch = async (_url, options = {}) => ({
    ok: true,
    status: 200,
    body: webBody(pauseAfterFirstChunk(controller)(), options.signal)
  });
  const manager = makeManager(rootDirectory, abortingFetch);
  await assert.rejects(
    () => manager.installComponent(makeComponent(), {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.phase === 'download' && event.fileBytes >= 400) controller.abort();
      }
    }),
    (error) => error.name === 'AbortError'
  );
  const partialSize = (await fsp.stat(stagingFile(manager))).size;

  const resumeFetch = makeRangeFetch();
  const resumeManager = makeManager(rootDirectory, resumeFetch);
  await resumeManager.installComponent(makeComponent());

  assert.equal(resumeFetch.requests[0].range, `bytes=${partialSize}-`);
  expectInstalledFile(resumeManager);
});
