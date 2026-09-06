import assert from 'node:assert/strict';
import test from 'node:test';
import { isCanonicalLanePath } from './index';

test('canonical supervisor lanes accept the transitional flat path and supported provider children', () => {
  assert.equal(isCanonicalLanePath(['supervisor']), true);
  assert.equal(isCanonicalLanePath(['supervisor', 'claude']), true);
  assert.equal(isCanonicalLanePath(['supervisor', 'codex']), true);
});

test('canonical supervisor lanes reject unsupported provider children', () => {
  assert.equal(isCanonicalLanePath(['supervisor', 'grok']), false);
});
