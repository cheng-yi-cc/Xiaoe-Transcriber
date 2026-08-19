const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMasterPlaylist, parseMediaPlaylist, selectSpeechVariant } = require('../src/main/services/hls-parser.cjs');

test('selects the lowest-bandwidth rendition for speech transcription', () => {
  const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=680000,RESOLUTION=640x360
low/index.m3u8`;
  const variants = parseMasterPlaylist(playlist, 'https://vod.example/course/master.m3u8');
  assert.equal(variants.length, 2);
  assert.equal(selectSpeechVariant(variants).url, 'https://vod.example/course/low/index.m3u8');
});

test('parses a standard VOD media playlist', () => {
  const playlist = `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:4.5,
001.ts?token=x
#EXTINF:5,
002.ts?token=x
#EXT-X-ENDLIST`;
  const media = parseMediaPlaylist(playlist, 'https://vod.example/course/list.m3u8');
  assert.equal(media.isVod, true);
  assert.equal(media.segments.length, 2);
  assert.equal(media.totalDurationSeconds, 9.5);
  assert.equal(media.segments[0].url, 'https://vod.example/course/001.ts?token=x');
});

test('refuses encrypted HLS rather than attempting decryption', () => {
  const encrypted = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:5,
001.ts
#EXT-X-ENDLIST`;
  assert.throws(() => parseMediaPlaylist(encrypted, 'https://vod.example/list.m3u8'), /加密 HLS/);
});

test('refuses media playlists that point to a private network', () => {
  const playlist = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:5,\nhttp://127.0.0.1/private.ts\n#EXT-X-ENDLIST';
  assert.throws(
    () => parseMediaPlaylist(playlist, 'https://media.example.com/index.m3u8'),
    /不安全的媒体地址/
  );
});
