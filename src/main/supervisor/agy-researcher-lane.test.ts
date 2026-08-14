import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PROVIDER_REDIRECT_ADAPTERS } from '../sandbox/provider-redirect-adapters';
import { resolveResearcherSandboxHome } from '../sandbox/researcher-home-factory';
import { prepareResearcherSandboxHome } from '../sandbox/researcher-home-lifecycle';

test('agy researcher enters the active app-derived argv redirect seam', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-agy-researcher-'));
  try {
    const sandbox = resolveResearcherSandboxHome({
      roleLane: 'researcher', workspaceStateRoot: path.join(root, 'workspace', '.lares'),
      agentId: 'agy-researcher', provider: 'agy',
    });
    assert.ok(sandbox);
    assert.deepEqual(PROVIDER_REDIRECT_ADAPTERS.agy.support, { implementation: 'active', verdict: 'degraded', gate: null });
    assert.deepEqual(sandbox.launchRedirect, { kind: 'argv', argument: `--gemini_dir=${sandbox.researcherSandboxHomePath}` });
    const prepared = prepareResearcherSandboxHome({
      provider: 'agy', sandboxHome: sandbox,
      filesystemHomePath: sandbox.researcherSandboxHomePath,
      trustedProviderStateRoot: path.join(root, 'account', '.claude'), accountTempPath: path.join(root, 'temp'),
    });
    assert.deepEqual(prepared.extraArgs, [`--gemini_dir=${sandbox.researcherSandboxHomePath}`]);
    assert.equal(prepared.extraEnv.TMP, path.join(sandbox.researcherSandboxHomePath, 'tmp'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
