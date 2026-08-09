import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plan, Workspace } from '../../shared/types';
import type { ProposalRecord } from '../database';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';
import {
  registerPermanentPlanDeleteIpc,
  registerProposalDeleteIpc,
} from './plan-ipc';
import { permanentlyDeletePlan } from './plan-lifecycle';
import { deleteProposal, type ProposalDeleteDeps } from './proposal-delete';
import { listPlanningEntries, resetPlanningReaderRegistryForTests } from './planning-reader';

interface TestCase { name: string; run(): void | Promise<void> }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-delete-'));

function workspace(name: string): Workspace {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, '.lares', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(root, '.lares', 'plans'), { recursive: true });
  return {
    id: `ws-${name}`, title: name, path: root, pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
  };
}

function proposalRow(ws: Workspace, overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    id: `proposal-${ws.id}`, artifactId: 'prop_de1e7e00', workspaceId: ws.id,
    path: '.lares/proposals/idea.md', slug: 'idea', title: 'Idea', state: 'proposal',
    authorAgentId: null, authorRole: 'unknown', authorDisplay: null, authoredAt: null,
    createdAt: 1, updatedAt: 1, mtimeMs: 1, sizeBytes: 1,
    promotedToPlanId: null, deletedAt: null, ...overrides,
  };
}

function writeProposalAndList(ws: Workspace): string {
  fs.writeFileSync(
    path.join(ws.path, '.lares', 'proposals', 'idea.md'),
    '---\nartifact_id: prop_de1e7e00\n---\n# Idea\n',
  );
  return listPlanningEntries(ws.path, { pathType: ws.pathType }).entries
    .flatMap((entry) => entry.documents)
    .find((document) => document.name === 'idea.md')!.docId;
}

function proposalDeps(ws: Workspace, row: ProposalRecord): Partial<ProposalDeleteDeps> {
  return {
    getWorkspace: (id) => id === ws.id ? ws : null,
    getProposalByWorkspacePath: (workspaceId, relPath) =>
      workspaceId === ws.id && relPath === row.path ? row : null,
  };
}

function plan(ws: Workspace, runState: string): Plan {
  return {
    id: `plan-${runState}`, workspaceId: ws.id,
    path: `.lares/plans/${runState}/plan.md`, slug: `${runState}-plan`,
    format: 'structured', runState, mtimeMs: 1, sizeBytes: 1,
    createdAt: '', updatedAt: '', deletedAt: null,
  };
}

test('un-promoted proposal delete removes the authoritative flat file', () => {
  resetPlanningReaderRegistryForTests();
  const ws = workspace('ordinary');
  const docId = writeProposalAndList(ws);
  assert.deepEqual(deleteProposal(
    { workspaceId: ws.id, proposalDocumentId: docId },
    proposalDeps(ws, proposalRow(ws)),
  ), { ok: true });
  assert.equal(fs.existsSync(path.join(ws.path, '.lares', 'proposals', 'idea.md')), false);
});

test('promoted proposal delete refusal names its governing plan through IPC', () => {
  resetPlanningReaderRegistryForTests();
  const ws = workspace('promoted');
  const docId = writeProposalAndList(ws);
  const planFolder = path.join(ws.path, '.lares', 'plans', 'governing-plan');
  fs.mkdirSync(planFolder, { recursive: true });
  fs.writeFileSync(path.join(planFolder, 'plan.json'), JSON.stringify({
    plan_artifact_id: 'plan_governor',
    plan_sku: '2026-08-09-governing-plan-governor',
    source_proposal: {
      artifact_id: 'prop_de1e7e00',
      rel_path: '.lares/proposals/idea.md',
    },
  }));
  let handler: ((event: unknown, raw: unknown) => unknown) | undefined;
  registerProposalDeleteIpc({
    handle: (channel, listener) => {
      assert.equal(channel, 'proposal:delete');
      handler = listener;
    },
  }, (request) => deleteProposal(
    request,
    proposalDeps(ws, proposalRow(ws, { state: 'promoted', promotedToPlanId: 'db-plan-1' })),
  ));
  assert.deepEqual(handler!(null, { workspaceId: ws.id, proposalDocumentId: docId }), {
    ok: false,
    reason: 'promoted',
    governingPlan: { id: 'plan_governor', name: '2026-08-09-governing-plan-governor' },
  });
  assert.equal(fs.existsSync(path.join(ws.path, '.lares', 'proposals', 'idea.md')), true);
});

test('non-archived permanent plan delete is refused before any destructive dependency', async () => {
  const ws = workspace('ready');
  const candidate = plan(ws, 'ready');
  let destructiveCall = false;
  const result = await permanentlyDeletePlan({ planId: candidate.id, confirmed: true }, {
    getPlan: () => candidate,
    getWorkspace: () => ws,
    listBaselineRefs: () => { destructiveCall = true; return []; },
    releaseBaselineRefs: async () => { destructiveCall = true; return true; },
    removePlanFolder: () => { destructiveCall = true; return true; },
    cascadeDelete: () => { destructiveCall = true; return true; },
  });
  assert.deepEqual(result, { ok: false, reason: 'plan-not-archived', runState: 'ready' });
  assert.equal(destructiveCall, false);
});

test('archived permanent delete enters through IPC, releases refs, removes folder, and cascades rows', async () => {
  const ws = workspace('archived');
  const candidate = plan(ws, 'archived');
  const refs = ['refs/lares/plans/plan/run-1', 'refs/lares/plans/plan/run-2'];
  const calls: string[] = [];
  let handler: ((event: unknown, raw: unknown) => unknown) | undefined;
  registerPermanentPlanDeleteIpc({
    handle: (channel, listener) => {
      assert.equal(
        channel,
        'plan:deletePermanent',
        'REACHABILITY:wp5-deletion production registration must expose plan:deletePermanent',
      );
      handler = listener;
    },
  }, (request) => permanentlyDeletePlan(request, {
    getPlan: () => candidate,
    getWorkspace: () => ws,
    listBaselineRefs: () => refs,
    releaseBaselineRefs: async (root, released) => {
      calls.push(`refs:${root}:${released.join(',')}`);
      return true;
    },
    removePlanFolder: () => { calls.push('folder'); return true; },
    cascadeDelete: (planId) => { calls.push(`cascade:${planId}`); return true; },
  }));

  assert.ok(handler, 'REACHABILITY:wp5-deletion production registration must expose plan:deletePermanent');
  assert.deepEqual(await handler!(null, { planId: candidate.id, confirmed: false }), {
    ok: false, reason: 'confirmation-required', runState: null,
  });
  assert.deepEqual(await handler!(null, { planId: candidate.id, confirmed: true }), {
    ok: true, planId: candidate.id, releasedBaselineRefs: refs,
  });
  assert.deepEqual(calls, [
    `refs:${ws.path}:${refs.join(',')}`,
    'folder',
    `cascade:${candidate.id}`,
  ]);
  console.log('REACHABILITY:wp5-deletion');
});

(async () => {
  let passed = 0;
  let failed = 0;
  try {
    for (const item of tests) {
      try {
        await item.run();
        console.log(`  ok  ${item.name}`);
        passed += 1;
      } catch (error) {
        console.error(`  FAIL ${item.name}`);
        console.error('       ', error instanceof Error ? error.stack ?? error.message : error);
        failed += 1;
      }
    }
  } finally {
    resetWorkspaceStateDirCacheForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
