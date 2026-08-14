import assert from 'assert';
import path from 'path';
import { test } from 'node:test';
import {
  formatResearcherLaunchRefusal,
  PROVIDER_REDIRECT_ADAPTERS,
} from '../sandbox/provider-redirect-adapters';
import { resolveResearcherSandboxHome } from '../sandbox/researcher-home-factory';

test('grok researcher remains a deliberate, refused stub', () => {
  assert.deepStrictEqual(PROVIDER_REDIRECT_ADAPTERS.grok.support, {
    implementation: 'stub',
    verdict: 'not-yet-activated',
    gate: 'researcher-lane-provider-activation',
    inactiveReason: 'no tool-restriction mechanism exists for this provider',
  });

  assert.throws(
    () => resolveResearcherSandboxHome({
      roleLane: 'researcher',
      workspaceStateRoot: path.resolve('C:\\fixture\\workspace\\.lares'),
      agentId: 'grok-researcher',
      provider: 'grok',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /grok/);
      assert.match(error.message, /researcher lane is not-yet-activated for grok/);
      assert.match(error.message, /no tool-restriction mechanism exists/);
      return true;
    },
  );
});

test('generic inactive adapters do not claim a missing tool restriction', () => {
  const message = formatResearcherLaunchRefusal('fixture-provider', {
    implementation: 'stub',
    verdict: 'not-yet-activated',
    gate: 'researcher-lane-provider-activation',
  });

  assert.match(message, /fixture-provider/);
  assert.match(message, /not-yet-activated/);
  assert.doesNotMatch(message, /tool-restriction mechanism/);
});
