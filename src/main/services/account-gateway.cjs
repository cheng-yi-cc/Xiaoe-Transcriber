const ACCOUNT_HOME_URL = 'https://study.xiaoe-tech.com/#/muti_index';

function buildGatewayExchangeScript({ appId, resourceId }) {
  const target = JSON.stringify({
    appId: String(appId || ''),
    resourceId: String(resourceId || '')
  });
  return `(() => {
    const target = ${target};
    const findCards = () => [...document.querySelectorAll('.course-card-list')]
      .map((element) => element.__vue__)
      .filter((vm) => vm?.cardData && typeof vm.$request === 'function');
    return (async () => {
      const cards = findCards();
      if (!cards.length) return { status: 'unsupported-frontend' };
      const exact = cards.find((vm) => vm.cardData.app_id === target.appId
        && (vm.cardData.resource_id === target.resourceId || vm.cardData.resources_id === target.resourceId));
      const sameShop = cards.find((vm) => vm.cardData.app_id === target.appId);
      const vm = exact || sameShop;
      if (!vm) return { status: 'not-found' };
      const card = vm.cardData;
      try {
        const company = await vm.$request('index_isCompanyShop', { app_id: target.appId });
        if (company?.code !== 0) return { status: 'request-error' };
        if (company?.data?.is_company) return { status: 'company-unsupported' };
        const payload = {
          type: exact ? 2 : 1,
          app_id: card.app_id,
          user_id: card.user_id || '',
          resource_type: card.resource_type || '',
          resource_id: card.resource_id || '',
          content_app_id: card.content_app_id || ''
        };
        if (card.resource_type === 11 && card.exercise_id) payload.exercise_id = card.exercise_id;
        const response = await vm.$request('index_getNewGateway', payload);
        const url = response?.data?.url;
        if (response?.code !== 0 || typeof url !== 'string') return { status: 'request-error' };
        return { status: 'ok', url, matched: exact ? 'resource' : 'shop' };
      } catch {
        return { status: 'request-error' };
      }
    })();
  })()`;
}

function gatewayFailureMessage(status) {
  if (status === 'company-unsupported') return '该课程属于企学院，账号学习中心暂不支持自动换店授权。';
  if (status === 'not-found') return '账号学习中心暂未找到这条课程。';
  if (status === 'unsupported-frontend') return '小鹅通学习中心页面结构已变化。';
  return '小鹅通未能建立目标店铺会话。';
}

function isStoreCookieDomain(domain, appId) {
  const normalizedDomain = String(domain || '').replace(/^\./, '').toLowerCase();
  const normalizedAppId = String(appId || '').toLowerCase();
  return Boolean(normalizedAppId && normalizedDomain.split('.')[0] === normalizedAppId);
}

module.exports = {
  ACCOUNT_HOME_URL,
  buildGatewayExchangeScript,
  gatewayFailureMessage,
  isStoreCookieDomain
};
