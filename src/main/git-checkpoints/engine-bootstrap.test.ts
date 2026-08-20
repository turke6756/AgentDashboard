import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import {
  buildHumanCheckpointMergeRoutes,
} from './engine-bootstrap';
import type {
  CheckpointPreviewResult,
  CheckpointService,
  RestoreOutcome,
} from './checkpoint-service';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const capability: GitCapability = {
  resolution: { agentShell: { source: 'system', note: '' }, internal: null },
  repoState: 'repo',
  commonDir: 'C:/repo/.git',
  repoRoot: 'C:/repo',
  workspacePrefix: '',
  commonDirQueueKey: 'C:/repo/.git',
  protectedRoot: false,
  reason: 'ok',
  detail: null,
};

function previewResult(strategy: 'exact' | 'merge-undo'): CheckpointPreviewResult {
  return {
    available: true,
    reason: null,
    turnId: 'turn-1',
    witnessedSet: ['a.txt'],
    tokens: {},
    validatedPaths: ['a.txt'],
    rejectedPaths: [],
    contention: [],
    strategy,
  };
}

function restoreResult(kind: RestoreOutcome['kind']): RestoreOutcome {
  return {
    status: 'failed',
    operationId: '',
    kind,
    preRef: null,
    preOid: null,
    requestedPaths: ['a.txt'],
    completedPaths: [],
    rejectedPaths: [],
    failures: [],
    contention: [],
    failureReason: 'recording-service',
  };
}

test('production human adapter forwards merge strategy and token to preview, restore, and revert service calls', async () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  const service: Pick<CheckpointService, 'previewRestore' | 'restorePaths' | 'revertTurn'> = {
    previewRestore: async (args) => {
      calls.push({ method: 'previewRestore', args });
      return previewResult(args.strategy ?? 'exact');
    },
    restorePaths: async (args) => {
      calls.push({ method: 'restorePaths', args });
      return restoreResult('merge_undo_paths');
    },
    revertTurn: async (args) => {
      calls.push({ method: 'revertTurn', args });
      return restoreResult('merge_undo_turn');
    },
  };
  const capabilityRequests: string[] = [];
  const routes = buildHumanCheckpointMergeRoutes({
    service,
    requireCapability: async (workspaceId) => {
      capabilityRequests.push(workspaceId);
      return capability;
    },
  });

  await routes.preview('ws-1', 'turn-1', ['a.txt'], 'merge-undo');
  await routes.restore({
    workspaceId: 'ws-1',
    turnId: 'turn-1',
    paths: ['a.txt'],
    previewTokens: { 'a.txt': 'exact-token' },
    force: false,
    strategy: 'merge-undo',
    mergePreviewToken: 'opaque-restore-token',
  });
  await routes.revert({
    workspaceId: 'ws-1',
    turnId: 'turn-1',
    previewTokens: { 'a.txt': 'exact-token' },
    force: false,
    strategy: 'merge-undo',
    mergePreviewToken: 'opaque-revert-token',
  });

  assert.deepEqual(capabilityRequests, ['ws-1', 'ws-1', 'ws-1']);
  assert.deepEqual(calls, [
    {
      method: 'previewRestore',
      args: {
        turnId: 'turn-1', workspaceId: 'ws-1', capability,
        requestedPaths: ['a.txt'], strategy: 'merge-undo',
      },
    },
    {
      method: 'restorePaths',
      args: {
        turnId: 'turn-1', requestedPaths: ['a.txt'], workspaceId: 'ws-1',
        actor: 'human-ipc', capability, previewTokens: { 'a.txt': 'exact-token' },
        force: false, strategy: 'merge-undo', mergePreviewToken: 'opaque-restore-token',
      },
    },
    {
      method: 'revertTurn',
      args: {
        turnId: 'turn-1', workspaceId: 'ws-1', actor: 'human-ipc', capability,
        previewTokens: { 'a.txt': 'exact-token' }, force: false,
        strategy: 'merge-undo', mergePreviewToken: 'opaque-revert-token',
      },
    },
  ], 'REACHABILITY:engine-human-merge-forwarding');
});

(async () => {
  let failures = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failures++;
      console.error(`  ✗ ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failures > 0) process.exit(1);
  console.log(`\nAll ${tests.length} engine-bootstrap tests passed`);
})();
