import assert from 'node:assert/strict';

import type {
  PackageFinalization,
  PlanDispatchAttempt,
  PlanWorkPackage,
  PlanWpReachabilityEvidence,
  PlanWpReachabilityObligation,
} from '../database';
import type { GitRunBytesResult, GitRunResult } from '../git-checkpoints/git-command';
import { finalizePlanItemDone } from './plan-ipc';
import {
  resolveLandedFinalizeRequest,
  type LandedFinalizeEnrichmentDeps,
} from './landed-finalize-enrichment';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const MUTATION = 'd'.repeat(40);

function pkg(): PlanWorkPackage {
  return {
    id: 'pkg-landed', workspaceId: 'ws-1', planId: 'plan-1', intentId: 'intent-1',
    schemaVersion: 2, contentHash: 'current-hash', projectionStatus: 'synced',
    title: 'landed', acceptanceCondition: null, state: 'executing', assigneeAgentId: 'agent-1',
    revision: 3, createdAt: 1, updatedAt: 1,
  };
}

function attempt(): PlanDispatchAttempt {
  return {
    id: 'attempt-1', packageId: 'pkg-landed', planId: 'plan-1', executionRunId: 'run-1',
    intentId: 'intent-1', targetAgentId: 'agent-1', packageRevision: 3,
    orchestrationId: null, targetSessionId: 'session-1', repositoryKey: 'repo-1',
    branchRef: 'refs/heads/master', dispatchTipOid: 'e'.repeat(40),
    frozenPaths: ['src/present.ts', 'src/deleted.ts'], captureStatus: 'captured', captureFailure: null,
    requestedPlanItemId: 'pkg-landed', confirmedTurnId: 'turn-1', state: 'delivered',
    createdAt: 1, confirmedAt: 2, reconciledAt: null,
  };
}

function obligation(): PlanWpReachabilityObligation {
  return {
    id: 'ob-1', packageId: 'pkg-landed', packageContentHash: 'current-hash', schemaVersion: 2,
    obligationKind: 'entry-link', ordinal: 0, declaredJson: '{}', mutationPath: 'mutation.patch',
    verificationTarget: 'target', expectFailureId: 'REACHABILITY:test',
  };
}

function evidence(over: Partial<PlanWpReachabilityEvidence> = {}): PlanWpReachabilityEvidence {
  return {
    id: 'evidence-current', obligationId: 'ob-1', packageContentHash: 'current-hash',
    specimenBaseOid: 'f'.repeat(40), specimenTreeOid: TREE, mutationBlobOid: MUTATION,
    baselineResult: 'pass', mutatedResult: 'fail', failureClassification: 'expected',
    verdict: 'pass', verificationTargetVersion: 'registry-current', verifiedAt: 20,
    ...over,
  };
}

function gitText(stdout: string): GitRunResult { return { code: 0, stdout, stderr: '' }; }
function gitBytes(stdout: Buffer): GitRunBytesResult { return { code: 0, stdout, stderr: '' }; }
function treeRecord(path: string): Buffer {
  return Buffer.from(`100644 blob ${BLOB}\t${path}\0`, 'utf8');
}

function deps(rows: PlanWpReachabilityEvidence[]): LandedFinalizeEnrichmentDeps {
  return {
    getAttempt: () => attempt(),
    getPackage: () => pkg(),
    listObligations: () => [obligation()],
    listEvidence: () => rows,
    verificationTargetVersion: 'registry-current',
    runGit: async (_cwd, args) => {
      assert.deepEqual(args, ['rev-parse', '--verify', `${COMMIT}^{tree}`]);
      return gitText(`${TREE}\n`);
    },
    runGitBytes: async (_cwd, args) => {
      const path = args[args.length - 1];
      return gitBytes(path === 'src/present.ts' ? treeRecord(path) : Buffer.alloc(0));
    },
  };
}

test('accepted commit produces a complete present/ABSENT manifest and fresh witness', async () => {
  const result = await resolveLandedFinalizeRequest({
    dispatchAttemptId: 'attempt-1', commitOid: COMMIT, repoRoot: 'C:/repo', finalizedBy: 'supervisor',
  }, deps([
    evidence({ id: 'stale-hash', packageContentHash: 'old-hash', verifiedAt: 100 }),
    evidence({ id: 'stale-tree', specimenTreeOid: '9'.repeat(40), verifiedAt: 90 }),
    evidence(),
  ]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.request.boundaryOid, COMMIT);
  assert.equal(result.request.pinnedHeadOid, COMMIT);
  assert.equal(result.request.candidateTreeOid, TREE);
  assert.deepEqual(result.request.members.map((member) => ({
    path: member.path.displayPath,
    state: member.expectedWorktreeState,
    blob: member.rawWorktreeBlobOid,
  })), [
    { path: 'src/present.ts', state: 'present', blob: BLOB },
    { path: 'src/deleted.ts', state: 'absent', blob: null },
  ]);
  assert.deepEqual(result.request.mutationBlobOidByObligationId, { 'ob-1': MUTATION });
});

test('stale proof rows are not revived into the landed witness', async () => {
  const result = await resolveLandedFinalizeRequest({
    dispatchAttemptId: 'attempt-1', commitOid: COMMIT, repoRoot: 'C:/repo', finalizedBy: 'supervisor',
  }, deps([evidence({ packageContentHash: 'old-hash', verifiedAt: 100 })]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.request.mutationBlobOidByObligationId, {});
});

test('resolved reachability witness enters finalizePlanItemDone completion callback', async () => {
  const resolved = await resolveLandedFinalizeRequest({
    dispatchAttemptId: 'attempt-1', commitOid: COMMIT, repoRoot: 'C:/repo', finalizedBy: 'supervisor',
  }, deps([evidence()]));
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  let completionWitness: unknown = null;
  await finalizePlanItemDone(resolved.request, {
    getPlanWorkPackage: () => pkg(),
    getPlanArtifactId: () => 'plan_12345678',
    getCompletionDeclaration: () => ({
      kind: 'code', requiredGateKeys: [], implementationCommits: [],
      boundary: 'ready', deploymentEnvironments: [],
    }),
    complete: (_command, witness) => {
      completionWitness = witness;
      return {
        commandType: 'complete', idempotencyKey: 'key', packageId: 'pkg-landed', packageRevision: 3,
        stateBefore: 'executing', stateAfter: 'done', stateChanged: true, evidenceIds: [], replayed: false,
      };
    },
    finalize: async (_request, options) => {
      options?.onReady?.({ id: 'fin-1', finalizedAt: 42 } as PackageFinalization);
      return {
        finalization: { id: 'fin-1' } as PackageFinalization,
        outcome: 'created', memberManifestJson: '[]',
      };
    },
  });
  assert.deepEqual(completionWitness, {
    kind: 'completion', actor: 'supervisor', observedAt: 42,
    candidateTreeOid: TREE, verificationTargetVersion: 'registry-current',
    mutationBlobOidByObligationId: { 'ob-1': MUTATION },
  });
});

(async () => {
  let passed = 0, failed = 0;
  for (const entry of tests) {
    try { await entry.run(); console.log(`  ok  ${entry.name}`); passed += 1; }
    catch (error) {
      console.error(`  FAIL ${entry.name}`);
      console.error('       ', error instanceof Error ? error.stack || error.message : error);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
