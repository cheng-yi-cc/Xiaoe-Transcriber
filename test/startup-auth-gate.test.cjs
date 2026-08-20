const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeBounds } = require('../src/main/services/startup-auth-gate.cjs');

test('embedded login view bounds are rounded and kept inside the window origin', () => {
  assert.deepEqual(normalizeBounds({ x: -5, y: 12.6, width: 420.4, height: 0 }), {
    x: 0,
    y: 13,
    width: 420,
    height: 1
  });
});
