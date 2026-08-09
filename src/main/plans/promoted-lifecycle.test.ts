import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TurnRecord } from '../database';
import { derivePromotedLifecycle } from './promoted-lifecycle';
import { listPromotedPlanFolders } from './plan-ipc';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function turn(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'id'>): TurnRecord {
  return {
    workspaceId: 'ws-1',
    turnSeq: 1,
    agentId: null,
    agentTitle: null,
    ownerAgentId: null,
    ownerBrickGeneration: null,
    planId: null,
    planItemId: null,
    planStampSource: 'legacy-unstamped',
    sessionId: null,
    taskLabel: null,
    startedAt: 1,
    endedAt: null,
    status: 'open',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: null,
    afterQuality: null,
    beforeRawFilterBypassed: false,
    beforeFilteredPaths: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    touched: null,
    diffStats: null,
    compactDiff: null,
    compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

test('all-done packages complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', turns: [],
    packages: [{ state: 'done' }, { state: 'done' }],
  });
  assert.equal(result.lifecycle, 'ready');
  assert.deepEqual(result.rollup, { total: 2, landed: 2, remaining: 0, archived: 0, completed: true });
});

test('mixed done and archived packages do not complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'executing', turns: [],
    packages: [{ state: 'done' }, { state: 'archived' }],
  });
  assert.deepEqual(result.rollup, { total: 2, landed: 1, remaining: 0, archived: 1, completed: false });
});

test('all-archived packages do not complete the rollup', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'archived', turns: [],
    packages: [{ state: 'archived' }, { state: 'archived' }],
  });
  assert.equal(result.rollup?.completed, false);
  assert.equal(result.rollup?.landed, 0);
});

test('active count includes only open verified turns stamped to this plan', () => {
  const nowMs = 2_000_000;
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: null, packages: [],
    nowMs,
    liveAgents: [{ id: 'fresh-agent', lastHookEventAt: nowMs - 1_000 }],
    turns: [
      turn({ id: 'active', agentId: 'fresh-agent', planId: 'plan-1', planStampSource: 'explicit' }),
      turn({ id: 'other-plan', planId: 'plan-2', planStampSource: 'agent-default' }),
      turn({ id: 'legacy', planId: 'plan-1', planStampSource: 'legacy-unstamped' }),
      turn({ id: 'closed', planId: 'plan-1', planStampSource: 'explicit', status: 'accepted' }),
    ],
  });
  assert.equal(result.lifecycle, 'promoted');
  assert.equal(result.rollup, null);
  assert.equal(result.activeVerifiedTurnCount, 1);
  assert.equal(result.activityTier, 'active');
});

test('badge precedence is completed then archived then run state then promoted', () => {
  const common = { planId: 'plan-1', packages: [], turns: [] } as const;
  assert.equal(derivePromotedLifecycle({ ...common, runState: 'archived', latestLifecycleKind: 'completed' }).lifecycle, 'completed');
  assert.equal(derivePromotedLifecycle({ ...common, runState: 'executing', latestLifecycleKind: 'archived' }).lifecycle, 'archived');
  assert.equal(derivePromotedLifecycle({ ...common, runState: 'hardening', latestLifecycleKind: 'promoted' }).lifecycle, 'hardening');
  assert.equal(derivePromotedLifecycle({ ...common, runState: 'ready' }).lifecycle, 'ready');
  assert.equal(derivePromotedLifecycle({ ...common, runState: 'unexpected' }).lifecycle, 'promoted');
});

test('rollup completion never yields the completed badge', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', latestLifecycleKind: 'implementation_started', turns: [],
    packages: [{ state: 'done' }, { state: 'done' }],
  });
  assert.equal(result.rollup?.completed, true);
  assert.equal(result.lifecycle, 'ready');
  assert.notEqual(result.lifecycle as string, 'completed');
});

test('fresh owner without an active plan turn is owner-live', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', packages: [], turns: [], nowMs: 20_000,
    responsibleSupervisorAgentId: 'owner',
    liveAgents: [{ id: 'owner', lastHookEventAt: 19_000 }],
  });
  assert.equal(result.activeVerifiedTurnCount, 0);
  assert.equal(result.activityTier, 'owner-live');
});

test('active tier takes precedence over a live owner', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'executing', packages: [], nowMs: 20_000,
    responsibleSupervisorAgentId: 'owner',
    liveAgents: [
      { id: 'owner', lastHookEventAt: 19_000 },
      { id: 'worker', lastHookEventAt: 19_000 },
    ],
    turns: [turn({ id: 'active', agentId: 'worker', planId: 'plan-1', planStampSource: 'explicit' })],
  });
  assert.equal(result.activityTier, 'active');
});

test('stale turn agent contributes to neither active nor owner-live', () => {
  const result = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'executing', packages: [], nowMs: 20_000, heartbeatStaleMs: 5_000,
    responsibleSupervisorAgentId: 'stale-agent',
    liveAgents: [{ id: 'stale-agent', lastHookEventAt: 14_999 }],
    turns: [turn({ id: 'stale', agentId: 'stale-agent', planId: 'plan-1', planStampSource: 'explicit' })],
  });
  assert.equal(result.activeVerifiedTurnCount, 0);
  assert.equal(result.activityTier, 'idle');
});

test('missing heartbeat and terminal-registry absence are idle', () => {
  const missingHeartbeat = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', packages: [], turns: [], nowMs: 20_000,
    responsibleSupervisorAgentId: 'owner', liveAgents: [{ id: 'owner' }],
  });
  const absentOwner = derivePromotedLifecycle({
    planId: 'plan-1', runState: 'ready', packages: [], turns: [], nowMs: 20_000,
    responsibleSupervisorAgentId: 'owner', liveAgents: [],
  });
  assert.equal(missingHeartbeat.activityTier, 'idle');
  assert.equal(absentOwner.activityTier, 'idle');
});

test('listPromotedPlanFolders production seam projects latest event and live-owner tier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp3-card-'));
  try {
    const folder = path.join(root, '.lares', 'plans', 'one');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'plan.json'), JSON.stringify({
      plan_artifact_id: 'plan-one', title: 'One', updated_at: 1,
      responsibility_events: [{ event: 'assigned', agent_id: 'owner', at: 1 }],
      lifecycle_events: [
        { event_id: 'older', kind: 'completed', at: 10, source: 'manual-skill' },
        { event_id: 'newer', kind: 'archived', at: 20, source: 'manual-skill' },
      ],
    }));
    resetWorkspaceStateDirCacheForTests();
    const nowMs = Date.now();
    const result = listPromotedPlanFolders('ws-1', root, 'windows', () => 'plan-one', {
      getPlan: () => ({ runState: 'executing' }) as any,
      listPackages: () => [],
      listTurns: () => [],
      listAgents: () => [{ id: 'owner', workspaceId: 'ws-1', lastHookEventAt: nowMs }] as any,
    });
    assert.equal(result.plans[0]?.latestLifecycleKind, 'archived', 'REACHABILITY:wp3-card-projection latest lifecycle event must enter the IPC card projection');
    assert.equal(result.plans[0]?.lifecycle, 'archived', 'REACHABILITY:wp3-card-projection lifecycle precedence must enter the IPC card projection');
    assert.equal(result.plans[0]?.activityTier, 'owner-live', 'REACHABILITY:wp3-card-projection live registry must enter the IPC card projection');
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('refusing to remove non-temp fixture');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { failed++; console.error(`  FAIL ${t.name}`); console.error(err); }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
