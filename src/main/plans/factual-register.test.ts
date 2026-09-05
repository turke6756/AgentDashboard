import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import * as database from '../database';
import { checkArcAgainstLedger } from './arc-status-check';
import {
  clearFactualRegisterCache,
  createFactualRegisterDeps,
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
    candidates: status === 'unavailable' ? [] : [{ commitOid: oid, parentOid: B, subject: 'land',
      sources: ['labels', 'changed-paths'], labelsMatch: true, changedPathsMatchFrozen: true,
      planTrailer: 'plan_16910c64', wpTrailer: 'WP-5', verifiedTrailers: ['tests'],
      scopeOmittedTrailers: [] }],
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
    now: () => 1,
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

test('an extra complete-scan WIP candidate does not contradict a present accepted OID', async () => {
  const complete = evidence(A);
  complete.candidates.push(evidence(B).candidates[0]);
  const result = await findings({ state: 'done', asserted: [complete], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 1 });
  assert.deepEqual(result.findings, []);
});

test('truncated-only candidates emit availability but never declaration mismatch', async () => {
  const result = await findings({ state: 'done', asserted: [evidence(B, 'truncated')], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 1 });
  assert.deepEqual(result.findings, [{ kind: 'evidence-unavailable', scope: 'asserted',
    detail: 'dispatch dispatch scan truncated' }]);
});

test('an unavailable-only scan never emits declaration mismatch', async () => {
  const result = await findings({ state: 'done', asserted: [evidence(B, 'unavailable')], acceptedOid: A,
    finalizations: [finalization()], stampedTurns: 1 });
  assert.deepEqual(result.findings, [{ kind: 'evidence-unavailable', scope: 'asserted',
    detail: 'dispatch dispatch: branch-unresolvable' }]);
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
  if (process.env.LARES_FACTUAL_REAL_DB_CHILD !== '1') {
    execFileSync(path.resolve('node_modules', 'electron', 'dist', 'electron.exe'), [__filename], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LARES_FACTUAL_REAL_DB_CHILD: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factual-cache-arc-'));
  const priorAppData = process.env.APPDATA;
  process.env.APPDATA = path.join(root, 'appdata');
  try {
    database.initDatabase();
    const workspace = database.createWorkspace({ title: 'cache', path: root, pathType: 'windows' });
    const plan = database.createOrRevivePlan({
      workspaceId: workspace.id, path: 'plan.md', format: 'structured', runState: 'ready',
    });
    const folderRelPath = '.lares/plans/cache-production';
    database.getDb().prepare(
      'UPDATE plans SET artifact_id = ?, folder_rel_path = ? WHERE id = ?',
    ).run('plan_16910c64', folderRelPath, plan.id);
    database.upsertPlanWorkPackage({
      id: 'WP-5-cache', workspaceId: workspace.id, planId: plan.id, intentId: 'intent-cache',
      schemaVersion: 2, contentHash: 'hash', projectionStatus: 'synced', title: 'cache',
      acceptanceCondition: null, state: 'executing', assigneeAgentId: null, revision: 1,
      createdAt: 1, updatedAt: 1,
    });
    const folder = path.join(root, '.lares', 'plans', 'cache-production');
    fs.mkdirSync(folder, { recursive: true });
    const arcPath = path.join(folder, 'ARC.md');
    const prefix = '## Package status\n| WP | State |\n| --- | --- |\n';
    const firstArc = `${prefix}| WP-5-cache | ready |\n`;
    const secondArc = `${prefix}| WP-5-cache | done  |\n`;
    assert.equal(Buffer.byteLength(firstArc), Buffer.byteLength(secondArc));

    fs.writeFileSync(arcPath, firstArc);
    clearFactualRegisterCache();
    const productionDeps = createFactualRegisterDeps({ now: () => 1 });
    const first = await projectPlanFactualRegister(plan.id, productionDeps);
    fs.writeFileSync(arcPath, secondArc);
    const second = await projectPlanFactualRegister(plan.id, productionDeps);
    const arcClaim = (register: PlanFactualRegister) => register.packages[0].findings
      .find((finding) => finding.kind === 'arc-contradicts-ledger')?.arcClaim;
    assert.equal(arcClaim(first), 'ready');
    assert.equal(arcClaim(second), 'done',
      'REACHABILITY:wpf2-same-size-cache production digest must invalidate equal-length ARC edits');
  } finally {
    database.closeDatabaseForTests();
    if (priorAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = priorAppData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
