const test = require('node:test');
const assert = require('node:assert/strict');
const { extractM3u8Candidates, isAllowedXiaoeUrl, isSafeMediaUrl, redactSensitiveUrl } = require('../src/main/services/url-utils.cjs');

test('accepts Xiaoe-tech HTTPS domains and rejects unrelated URLs', () => {
  assert.equal(isAllowedXiaoeUrl('https://demo.xetslk.com/sl/example'), true);
  assert.equal(isAllowedXiaoeUrl('https://app.example.com/video'), false);
  assert.equal(isAllowedXiaoeUrl('http://demo.xetslk.com/sl/example'), false);
});

test('extracts an encoded play_url from a reporting request', () => {
  const manifest = 'https://vod.xet.tech/course/playlist_eof.m3u8?sign=secret&t=123';
  const report = `https://report.xiaoeknow.com/event?params%5Bplay_url%5D=${encodeURIComponent(manifest)}&kind=play`;
  assert.ok(extractM3u8Candidates(report).includes(manifest));
});

test('redacts every query value from sensitive media URLs', () => {
  const redacted = redactSensitiveUrl('https://vod.xet.tech/a.m3u8?sign=abc&uuid=user');
  assert.equal(redacted.includes('abc'), false);
  assert.equal(redacted.includes('user'), false);
  assert.match(redacted, /REDACTED/);
});

test('rejects local and private media targets', () => {
  assert.equal(isSafeMediaUrl('https://127.0.0.1/video.m3u8'), false);
  assert.equal(isSafeMediaUrl('https://192.168.1.10/video.m3u8'), false);
  assert.equal(isSafeMediaUrl('https://vod.xet.tech/video.m3u8'), true);
});
