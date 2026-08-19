const test = require('node:test');
const assert = require('node:assert/strict');
const { isAuthenticatedCoursePage, isLoginPage } = require('../src/main/services/auth-state.cjs');

test('detects Xiaoe WeChat login URLs', () => {
  assert.equal(isLoginPage({
    url: 'https://example.h5.xet.pomoho.com/p/t/free/v1/basic-platform/h5_basic/login/auth?redirect_url=x',
    text: ''
  }), true);
});

test('detects login copy even when an SPA keeps its original URL', () => {
  assert.equal(isLoginPage({
    url: 'https://example.xetslk.com/sl/abc',
    text: '请使用微信扫码登录后继续观看'
  }), true);
});

test('accepts an authenticated course playback page', () => {
  assert.equal(isAuthenticatedCoursePage({
    url: 'https://example.h5.xet.pomoho.com/v4/course/alive/l_123',
    text: '第一节 课程回放',
    hasVideo: true
  }), true);
});

test('never treats a login page as authenticated', () => {
  assert.equal(isAuthenticatedCoursePage({
    url: 'https://example.h5.xet.pomoho.com/v4/course/alive/l_123',
    text: '微信扫码登录',
    hasVideo: true
  }), false);
});
