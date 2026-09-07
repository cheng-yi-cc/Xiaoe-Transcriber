const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildLoginQrScrollScript,
  isUsableBounds,
  normalizeBounds,
  StartupAuthGate
} = require('../src/main/services/startup-auth-gate.cjs');

test('embedded login view bounds are rounded and kept inside the window origin', () => {
  assert.deepEqual(normalizeBounds({ x: -5, y: 12.6, width: 420.4, height: 0 }), {
    x: 0,
    y: 13,
    width: 420,
    height: 1
  });
});

test('login view waits for usable bounds before showing', () => {
  const gate = new StartupAuthGate({ mainWindow: null, onStatus: () => {} });
  assert.equal(gate.hasUsableBounds, false);
  gate.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  assert.equal(gate.hasUsableBounds, false);
  gate.setBounds({ x: 10.4, y: 20.6, width: 340, height: 430 });
  assert.equal(gate.hasUsableBounds, true);
  assert.deepEqual(gate.bounds, { x: 10, y: 21, width: 340, height: 430 });
});

test('login qr scroll script targets the qr area', () => {
  const script = buildLoginQrScrollScript();
  assert.match(script, /scrollIntoView/);
  assert.match(script, /微信/);
  assert.match(script, /iframe/);
  assert.match(script, /canvas/);
});
