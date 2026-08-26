const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  ACCOUNT_HOME_URL,
  buildGatewayExchangeScript,
  gatewayFailureMessage,
  isStoreCookieDomain
} = require('../src/main/services/account-gateway.cjs');

async function runGatewayScript({ cards, target, company = false }) {
  const calls = [];
  const elements = cards.map((cardData) => ({
    __vue__: {
      cardData,
      async $request(name, payload) {
        calls.push({ name, payload });
        if (name === 'index_isCompanyShop') return { code: 0, data: { is_company: company } };
        return { code: 0, data: { url: 'https://appshop.h5.xiaoeknow.com/gateway' } };
      }
    }
  }));
  const context = { document: { querySelectorAll: () => elements } };
  const result = await vm.runInNewContext(buildGatewayExchangeScript(target), context);
  return { result: structuredClone(result), calls: structuredClone(calls) };
}

test('uses the fixed multi-store learner account entry', () => {
  assert.equal(ACCOUNT_HOME_URL, 'https://study.xiaoe-tech.com/#/muti_index');
});

test('requests a resource gateway when the exact account card exists', async () => {
  const { result, calls } = await runGatewayScript({
    target: { appId: 'appshop', resourceId: 'l_target' },
    cards: [{
      app_id: 'appshop',
      user_id: 'u_private',
      resource_type: 4,
      resource_id: 'l_target',
      content_app_id: ''
    }]
  });
  assert.deepEqual(result, {
    status: 'ok',
    url: 'https://appshop.h5.xiaoeknow.com/gateway',
    matched: 'resource'
  });
  assert.equal(calls[1].name, 'index_getNewGateway');
  assert.equal(calls[1].payload.type, 2);
  assert.equal(calls[1].payload.user_id, 'u_private');
});

test('falls back to a shop gateway without exposing account data in the result', async () => {
  const { result, calls } = await runGatewayScript({
    target: { appId: 'appshop', resourceId: 'l_nested' },
    cards: [{
      app_id: 'appshop',
      user_id: 'u_private',
      resource_type: 4,
      resource_id: 'l_parent',
      content_app_id: ''
    }]
  });
  assert.equal(result.matched, 'shop');
  assert.equal(Object.hasOwn(result, 'user_id'), false);
  assert.equal(calls[1].payload.type, 1);
});

test('reports unsupported company shops without requesting a gateway', async () => {
  const { result, calls } = await runGatewayScript({
    target: { appId: 'appshop', resourceId: 'l_target' },
    company: true,
    cards: [{ app_id: 'appshop', user_id: 'u_private', resource_type: 4, resource_id: 'l_target' }]
  });
  assert.deepEqual(result, { status: 'company-unsupported' });
  assert.equal(calls.length, 1);
  assert.match(gatewayFailureMessage(result.status), /企学院/);
});

test('clears only cookies belonging to the target store app', () => {
  assert.equal(isStoreCookieDomain('.appshop.h5.xet.pomoho.com', 'appshop'), true);
  assert.equal(isStoreCookieDomain('appshop.h5.xiaoeknow.com', 'APPSHOP'), true);
  assert.equal(isStoreCookieDomain('.xiaoe-tech.com', 'appshop'), false);
  assert.equal(isStoreCookieDomain('appshop-copy.h5.xiaoeknow.com', 'appshop'), false);
});
