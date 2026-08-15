import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertResearcherProviderCredentials,
  PROVIDER_REDIRECT_ADAPTERS,
} from '../sandbox/provider-redirect-adapters';

test('agy researcher credential preflight uses the normal OS keychain without a file redirect', () => {
  assert.deepEqual(
    PROVIDER_REDIRECT_ADAPTERS.agy.support,
    { implementation: 'active', verdict: 'degraded', gate: null },
  );
  assert.doesNotThrow(() => assertResearcherProviderCredentials('agy', null));
});
