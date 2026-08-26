const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAccountLoginPage,
  isAuthenticatedAccountPage,
  isAuthenticatedCoursePage,
  isInvalidSharePage,
  isLoginPage
} = require('../src/main/services/auth-state.cjs');

test('detects the account-level Xiaoe learner login page', () => {
  assert.equal(isAccountLoginPage({
    url: 'https://study.xiaoe-tech.com/t_l/learnLogin#/acount',
    text: ''
  }), true);
});

test('accepts the loaded multi-store learner account page', () => {
  assert.equal(isAuthenticatedAccountPage({
    url: 'https://study.xiaoe-tech.com/#/muti_index',
    text: '我的课程',
    accountReady: true
  }), true);
});

test('does not accept the account route before its authenticated shell is ready', () => {
  assert.equal(isAuthenticatedAccountPage({
    url: 'https://study.xiaoe-tech.com/#/muti_index',
    text: '',
    accountReady: false
  }), false);
});

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

test('detects an invalid or expired Xiaoe share page', () => {
  assert.equal(isInvalidSharePage({
    url: 'https://link.h5.xiaoeknow.com/p/t/free/v1/account-platform/account-center/common/notFound',
    text: '访问失败，请检查链接是否正确'
  }), true);
  assert.equal(isInvalidSharePage({
    url: 'https://appdemo.h5.xet.pomoho.com/v4/course/alive/l_valid',
    text: '课程回放'
  }), false);
});
