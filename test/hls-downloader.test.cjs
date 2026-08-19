const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadHls, inspectHls } = require('../src/main/services/hls-downloader.cjs');

test('downloads HLS segments concurrently but writes them in playlist order', async () => {
  const responses = new Map([
    ['https://vod.example/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nmedia/list.m3u8'],
    ['https://vod.example/media/list.m3u8', '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:5,\n1.ts\n#EXTINF:5,\n2.ts\n#EXT-X-ENDLIST'],
    ['https://vod.example/media/1.ts', Buffer.from('first')],
    ['https://vod.example/media/2.ts', Buffer.from('second')]
  ]);
  const fakeFetch = async (url) => {
    const body = responses.get(String(url));
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
  };
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'hls-test-'));
  try {
    const inspected = await inspectHls({ fetchImpl: fakeFetch, manifestUrl: 'https://vod.example/master.m3u8' });
    const destination = path.join(temporary, 'media.bin');
    await downloadHls({
      fetchImpl: fakeFetch,
      manifestUrl: 'https://vod.example/master.m3u8',
      destination,
      inspected,
      concurrency: 2
    });
    assert.equal(await fsp.readFile(destination, 'utf8'), 'firstsecond');
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});
