const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');

const APP_ID = 'io.github.cheng-yi-cc.xiaoe-transcriber';
const NSIS_GUID = '805bbb7b-dc99-5c4b-8354-e25c2432ec73';

test('keeps the Windows application identity stable for upgrades', () => {
  assert.equal(
    packageJson.build?.appId,
    APP_ID,
    'build.appId is a permanent application identity and must not change'
  );
  assert.equal(
    packageJson.build?.nsis?.guid,
    NSIS_GUID,
    'build.nsis.guid is a permanent installer identity and must not change'
  );
});
