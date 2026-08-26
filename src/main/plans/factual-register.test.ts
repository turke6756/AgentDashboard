import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AssertedDispatchEvidence,
  MissionBoardPackageState,
  PlanFactualRegister,
} from '../../shared/types';
import type {
  PackageFinalization,
  PlanPackageEvidenceProjection,
  PlanWorkPackage,
} from '../database';
import { checkArcAgainstLedger } from './arc-status-check';
import {
  clearFactualRegisterCache,
  projectPlanFactualRegister,
  type FactualRegisterDeps,
} from './factual-register';
import { registerPlanFactualRegisterIpc } from './plan-ipc';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function pkg(state: MissionBoardPackageState = 'executing'): PlanWorkPackage {
  return { id: 'WP-5', workspaceId: 'ws', planId: 'plan', intentId: 'intent', schemaVersion: 2,
    contentHash: 'hash', projectionStatus: 'synced', title: 'WP-5', acceptanceCondition: null,
    state, assigneeAgentId: 'agent', revision: 1, createdAt: 1, updatedAt: 1 };
}

function evidence(oid = A, status: AssertedDispatchEvidence['scanStatus'] = 'complete'): AssertedDispatchEvidence {
  return { packageId: 'WP-5', dispatchAttemptId: 'dispatch', scanStatus: status,
    candidates: status === 'unavailable' ? [] : [{ commitOid: oid, subject: 'land', verifiedTrailer: 'tests',
      scopeOmittedTrailer: null, changedPathsMatchFrozen: true }],
    ...(status === 'unavailable' ? { refusal: 'branch-unresolvable' as const } : {}) };
}

function projection(state: MissionBoardPackageState, acceptedOid?: string): PlanPackageEvidenceProjection {
  const gate = acceptedOid ? { id: 'gate-1', workspaceId: 'ws', planId: 'plan', planArtifactId: 'plan_16910c64',
    intentId: 'intent', packageId: 'WP-5', packageRevision: 1, gateKey: 'supervisor-acceptance',
    gateRevision: 1, attemptNo: 1, outcome: 'passed' as const, finalizationId: null,
    witnessAgentId: 'agent', witnessSessionId: 'session', witnessTurnId: 'turn', evidenceJson: null,
    decidedAt: 5, createdAt: 5 } : null;
  return { package: pkg(state), dispatchAttempts: [], gateAttempts: gate ? [gate] : [],
    latestGateAttempts: gate ? [gate] : [], gateCommitLinks: gate ? [{ gateAttemptId: gate.id,
      repositoryKey: 'repo', commitOid: acceptedOid!, createdAt: 5 }] : [],
    deploymentEvents: [], latestDeploymentEvents: [] };
}

function finalization(): PackageFinalization {
  return { id: 'final-1', packageId: 'WP-5', repositoryKey: 'repo', finalizationKind: 'plan-package',
    planId: 'plan', planItemId: 'WP-5', packageRevision: 1, finalizedAt: 8, finalizedBy: 'sup',
    checkpointTurnId: 'turn', checkpointOid: A, boundaryRef: 'refs/lares/final', boundaryStatus: 'ready',
    lifecycleStatus: 'active', supersededByFinalizationId: null, releasedAt: null,
    memberManifestJson: '[]', contractVersion: 1, failureReason: null, createdFromWorkspaceId: 'ws' };
}

function deps(input: {
  state?: MissionBoardPackageState; asserted?: AssertedDispatchEvidence[]; acceptedOid?: string;
  finalizations?: PackageFinalization[]; stampedTurns?: number; arcPath?: string | null;
} = {}): FactualRegisterDeps {
  const state = input.state ?? 'executing';
  return {
    listPackages: () => [pkg(state)],
    discoverAsserted: async () => input.asserted ?? [],
    getProjection: () => projection(state, input.acceptedOid),
    listFinalizations: () => input.finalizations ?? [],
    countStampedTurns: () => input.stampedTurns ?? 1,
    resolveArcPath: () => input.arcPath ?? null,
    checkArc: checkArcAgainstLedger,
    evaluateReadiness: () => [{ kind: 'explicit-deployment-state-missing' }],
    cacheKey: async () => `${Math.random()}`,
  };
}

async function findings(input: Parameters<typeof deps>[0]) {
  clearFactualRegisterCache();
  return (await projectPlanFactualRegister('plan', deps(input))).packages[0];
}

test('commit without declaration has a sole-mechanism fixture', async () => {
  const result = await findings({ asserted: [evidence()] });
  assert.deepEqual(result.findings, [{ kind: 'commit-without-declaration', commitOid: A }]);
});

test('acceptance suppresses commit-without-declaration and emits only accepted-not-landed', async () => {
  const result = await findings({ asserted: [evidence()], acceptedOid: A });
  assert.deepEqual(result.findings, [{ kind: 'accepted-not-landed', commitOid: A,
    gateAttemptId: 'gate-1', unmet: [{ kind: 'explicit-deployment-state-missing' }] }]);
});

test('successful completion emits neither asserted/declaration transient finding', async () => {
  const result = await findings({ state: 'done', asserted: [evidence()], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 1 });
  assert.ok(result.landed);
  assert.deepEqual(result.findings, []);
});

test('direct stamped-turn count is the sole mechanism for declaration-without-witness', async () => {
  // Citation and asserted evidence agree; only the direct count is zero.
  const result = await findings({ state: 'done', asserted: [evidence()], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 0 });
  assert.deepEqual(result.findings, [{ kind: 'declaration-without-witness' }]);
});

test('differing completed citation and asserted OID solely emit declaration-commit-mismatch', async () => {
  const result = await findings({ state: 'done', asserted: [evidence(B)], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 1 });
  assert.deepEqual(result.findings, [{ kind: 'declaration-commit-mismatch', declared: A, asserted: B }]);
});

test('done without a projectable citation solely emits its integrity finding', async () => {
  const result = await findings({ state: 'done', stampedTurns: 1 });
  assert.deepEqual(result.findings, [{ kind: 'done-without-finalization-citation' }]);
});

test('unavailable asserted scan solely emits evidence-unavailable', async () => {
  const result = await findings({ asserted: [evidence(A, 'unavailable')] });
  assert.deepEqual(result.findings, [{ kind: 'evidence-unavailable', scope: 'asserted',
    detail: 'dispatch dispatch: branch-unresolvable' }]);
});

test('real async IPC enters projectPlanFactualRegister -> checkArcAgainstLedger consumer path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factual-ipc-'));
  const arcPath = path.join(root, 'ARC.md');
  fs.writeFileSync(arcPath, '## Package status\n| WP | State |\n| --- | --- |\n| WP-5 | done |\n');
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerPlanFactualRegisterIpc({ handle: (channel, listener) => handlers.set(channel, listener) },
    (planId) => projectPlanFactualRegister(planId, deps({ arcPath })));
  const handler = handlers.get('plan:factualRegister');
  assert.ok(handler, 'production registerPlanIpc path must register plan:factualRegister');
  clearFactualRegisterCache();
  const result = await handler!(null, 'plan') as PlanFactualRegister;
  assert.deepEqual(result.packages[0].findings, [{ kind: 'arc-contradicts-ledger',
    wpId: 'WP-5', arcClaim: 'done', ledgerState: 'executing' }],
  'REACHABILITY:wp5-arc-contradiction');
  fs.rmSync(root, { recursive: true, force: true });
});

test('cache invalidates on commit-link high-water while package updatedAt is unchanged', async () => {
  clearFactualRegisterCache();
  let commitLinkHighWater = 0;
  let projections = 0;
  const base = deps();
  const cacheDeps: FactualRegisterDeps = {
    ...base,
    getProjection: (...args) => { projections += 1; return base.getProjection(...args); },
    // updatedAt is intentionally absent: the evidence high-water is authoritative.
    cacheKey: async () => `links:${commitLinkHighWater}`,
  };
  await projectPlanFactualRegister('plan-cache-links', cacheDeps);
  await projectPlanFactualRegister('plan-cache-links', cacheDeps);
  assert.equal(projections, 1);
  commitLinkHighWater += 1;
  await projectPlanFactualRegister('plan-cache-links', cacheDeps);
  assert.equal(projections, 2);
});

test('cache invalidates on a same-size ARC content digest change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factual-cache-arc-'));
  const arcPath = path.join(root, 'ARC.md');
  fs.writeFileSync(arcPath, 'alpha');
  clearFactualRegisterCache();
  let projections = 0;
  const base = deps({ arcPath });
  const cacheDeps: FactualRegisterDeps = {
    ...base,
    getProjection: (...args) => { projections += 1; return base.getProjection(...args); },
    cacheKey: async () => createHash('sha256').update(fs.readFileSync(arcPath)).digest('hex'),
  };
  await projectPlanFactualRegister('plan-cache-arc', cacheDeps);
  fs.writeFileSync(arcPath, 'omega');
  await projectPlanFactualRegister('plan-cache-arc', cacheDeps);
  assert.equal(projections, 2, 'same byte length must not preserve the cached register');
  fs.rmSync(root, { recursive: true, force: true });
});
