const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractM3u8Candidates,
  extractXiaoeCourseIdentity,
  isAllowedAccountUrl,
  isAllowedCourseUrl,
  isAllowedGatewayUrl,
  isAllowedXiaoeUrl,
  isSameXiaoeCourse,
  isSafeMediaUrl,
  redactSensitiveUrl
} = require('../src/main/services/url-utils.cjs');

test('accepts Xiaoe-tech HTTPS domains and rejects unrelated URLs', () => {
  assert.equal(isAllowedXiaoeUrl('https://demo.xetslk.com/sl/example'), true);
  assert.equal(isAllowedXiaoeUrl('https://app.example.com/video'), false);
  assert.equal(isAllowedXiaoeUrl('http://demo.xetslk.com/sl/example'), false);
});

test('allows only the learner account host for account login', () => {
  assert.equal(isAllowedAccountUrl('https://study.xiaoe-tech.com/#/muti_index'), true);
  assert.equal(isAllowedCourseUrl('https://study.xiaoe-tech.com/#/muti_index'), false);
  assert.equal(isAllowedXiaoeUrl('https://admin.xiaoe-tech.com/'), false);
});

test('allows tightly scoped Xiaoe gateway destinations', () => {
  assert.equal(isAllowedGatewayUrl('https://appabc123.pc.xiaoe-tech.com/t/login'), true);
  assert.equal(isAllowedGatewayUrl('https://h5.xiaoecloud.com/platform/login_cooperate/h5_login'), true);
  assert.equal(isAllowedGatewayUrl('https://admin.xiaoecloud.com/'), false);
  assert.equal(isAllowedGatewayUrl('https://admin.xiaoe-tech.com/t/login'), false);
});

test('extracts app and resource identities from resolved course URLs', () => {
  assert.deepEqual(
    extractXiaoeCourseIdentity('https://appabc123.h5.xet.pomoho.com/v4/course/alive/l_resource123?share_type=5'),
    {
      appId: 'appabc123',
      resourceId: 'l_resource123',
      resourceType: 'alive',
      resolvedUrl: 'https://appabc123.h5.xet.pomoho.com/v4/course/alive/l_resource123?share_type=5'
    }
  );
  assert.equal(extractXiaoeCourseIdentity('https://demo.xetslk.com/sl/example'), null);
});

test('matches the exact resolved course while preserving deep-link parameters', () => {
  const identity = {
    appId: 'appabc123',
    resourceId: 'l_resource123'
  };
  assert.equal(isSameXiaoeCourse(
    'https://appabc123.h5.xet.pomoho.com/v4/course/alive/l_resource123?conduit_type=live_group',
    identity
  ), true);
  assert.equal(isSameXiaoeCourse(
    'https://appabc123.h5.xet.pomoho.com/v4/course/alive/l_other',
    identity
  ), false);
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
