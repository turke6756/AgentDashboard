import assert from 'node:assert/strict';
import http from 'node:http';

import { ApiServer, type CheckpointRoutes } from '../api-server';
import type { AgentSupervisor } from '../supervisor';
import { agentCapabilities } from '../security/agent-capabilities';
import {
  ActivityRoutes,
  PREVIEW_CONCURRENCY,
  registerActivityRoutes,
  type ActivityPushEvent,
  type ActivityRouteDeps,
} from './activity-routes';
import type { ActivitySourcePage, TurnRecord } from '../database';
import type {
  ActivityFileActivity,
} from '../database';
import type { ActivityHeartbeatSnapshot, ActivityPage, CheckpointPreviewResult } from '../../shared/types';
import { ACTIVITY_CHANNELS } from '../../shared/types';
import { registerCheckpointIpc } from '../git-checkpoints/checkpoint-ipc';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const db = require('../database') as Record<string, unknown>;
db.getWorkspace = (id: string) => ({ id, title: 'Workspace', path: '/repo', pathType: 'windows' });
db.getSupervisorAgent = () => null;
db.getAllAgents = () => [];
db.getAgentsByWorkspace = () => [];

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 'turn-1', workspaceId: 'ws', turnSeq: 7, agentId: 'a1', agentTitle: 'Agent',
    ownerAgentId: null, ownerBrickGeneration: null, planId: null, planItemId: null,
    planStampSource: 'legacy-unstamped', intentId: null, intentStampSource: null, sessionId: 's1',
    taskLabel: 'Task', startedAt: 100, endedAt: 200, status: 'accepted',
    beforeOid: 'b', afterOid: 'a', beforeRef: 'rb', afterRef: 'ra',
    beforeReady: true, afterReady: true, beforeQuality: 'guaranteed', afterQuality: 'hook',
    beforeRawFilterBypassed: false, beforeFilteredPaths: null,
    beforePrunedAt: null, afterPrunedAt: null,
    touched: [{ path: 'src/a.ts', op: 'write' }], diffStats: null, compactDiff: null,
    compactDiffProvenance: null, failureReason: null,
    ...overrides,
  };
}

function heartbeat(overrides: Partial<ActivityHeartbeatSnapshot> = {}): ActivityHeartbeatSnapshot {
  return {
    serverState: 'idle-but-healthy', serverNow: 1_000, engine: 'present', engineChangedAt: 1,
    capabilityOk: true, capabilityProbedAt: 900, lastSubsystemBeatAt: 800,
    attempts: { oldestPendingAt: null, pendingCount: 0, overduePendingCount: 0,
      openedCount: 0, orphanedOpenedCount: 0, latestOutcome: null },
    activeTurns: { openTurnCount: 0, verifiedBeforeCount: 0, awaitingVerificationCount: 0,
      failedBeforeCount: 0, oldestAwaitingSince: null },
    latestClosedAfterVerification: null, reason: null, ...overrides,
  };
}

function preview(turnId: string, overrides: Partial<CheckpointPreviewResult> = {}): CheckpointPreviewResult {
  return {
    available: true, reason: null, turnId, witnessedSet: ['src/a.ts'], tokens: {},
    validatedPaths: ['src/a.ts'], rejectedPaths: [], contention: [], ...overrides,
  };
}

function sourcePage<T>(rows: T[], before: number | null, exhausted = true): ActivitySourcePage<T> {
  return { rows, before, exhausted, scanned: rows.length };
}

function makeRoutes(overrides: ActivityRouteDeps = {}): ActivityRoutes {
  return registerActivityRoutes({
    now: () => 1_000,
    snapshot: () => ({ throughTurnSeq: 7, throughFileActivityId: 0, capturedAt: 1_000 }),
    listTurns: () => sourcePage([turn()], 7),
    listFileActivities: () => sourcePage<ActivityFileActivity>([], null),
    getViewed: () => ({ turnSeq: 0, fileActivityId: 0, viewedAt: null }),
    markViewed: (workspaceId, snapshot, viewedAt) => ({
      turnSeq: snapshot.throughTurnSeq,
      fileActivityId: snapshot.throughFileActivityId,
      viewedAt: viewedAt ?? null,
    }),
    heartbeat: () => heartbeat(),
    resolveWorkspace: () => ({ repoRoot: '/repo', workspacePrefix: '' }),
    ...overrides,
  });
}

test('B2 digest reads the durable pre-view watermark so a revisit with no new work has zero return counts', async () => {
  const routes = makeRoutes({
    getViewed: () => ({ turnSeq: 7, fileActivityId: 0, viewedAt: 900 }),
  });
  const digest = await routes.digest({ workspaceId: 'ws' });
  assert.equal(digest.page.pageCounts.turnCount, 1, 'the historical page still contains the turn');
  assert.equal(digest.sinceCounts.turnCount, 0, 'the historical page must not be relabeled as new');
  assert.equal(digest.sinceCounts.fileCount, 0);
});

function flatTurns(page: ActivityPage) {
  return page.items.flatMap((item) => item.kind === 'turn' ? [item]
    : item.kind === 'plan-group' ? item.members : []);
}

test('P6 snapshot is captured before either source query and markViewed persists its exact bounds', async () => {
  const order: string[] = [];
  let marked: unknown;
  const routes = makeRoutes({
    snapshot: () => { order.push('snapshot'); return { throughTurnSeq: 9, throughFileActivityId: 12, capturedAt: 500 }; },
    listTurns: (_ws, opts) => { order.push(`turns:${opts.throughTurnSeq}`); return sourcePage([turn({ turnSeq: 9 })], 9); },
    listFileActivities: (_ws, opts) => { order.push(`fas:${opts.throughFileActivityId}`); return sourcePage([], null); },
    markViewed: (_ws, snapshot, viewedAt) => { marked = { snapshot, viewedAt }; return { turnSeq: 9, fileActivityId: 12, viewedAt: viewedAt ?? null }; },
  });
  const page = await routes.list({ workspaceId: 'ws', preview: 'none' });
  assert.deepEqual(order, ['snapshot', 'turns:9', 'fas:12']);
  routes.markViewed({ workspaceId: 'ws', snapshot: page.cursor.snapshot });
  assert.deepEqual(marked, {
    snapshot: { throughTurnSeq: 9, throughFileActivityId: 12 },
    viewedAt: 1_000,
  });
});

test('T7/T17 preview:none returns checking then pushes preview-derived undo and final counts', async () => {
  const events: ActivityPushEvent[] = [];
  const routes = makeRoutes({
    previewRestore: async (_ws, turnId) => preview(turnId, {
      available: false,
      reason: 'active-turn-witnesses-path',
      contention: [{ path: 'src/a.ts', turnId: 'open-2' }],
    }),
  });
  const page = await routes.list({ workspaceId: 'ws', preview: 'none' }, (event) => events.push(event));
  assert.equal(flatTurns(page)[0].undo.state, 'checking');
  assert.equal(page.pageCounts.blockedOverlapCount.status, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const update = events.find((event) => event.channel === 'activity:undo-updated');
  assert.ok(update && update.channel === 'activity:undo-updated', 'activity:undo-updated must follow the checking row');
  assert.equal(update.payload.undo.state, 'blocked-overlap');
  assert.deepEqual(update.payload.undo.contention, [{ path: 'src/a.ts', turnId: 'open-2' }]);
  assert.ok(events.some((event) => event.channel === 'activity:page-counts'));
});

test('P5 generation guard drops a late preview result after unsubscribe', async () => {
  let resolvePreview!: (value: CheckpointPreviewResult) => void;
  const pending = new Promise<CheckpointPreviewResult>((resolve) => { resolvePreview = resolve; });
  const events: ActivityPushEvent[] = [];
  const routes = makeRoutes({ previewRestore: async () => pending });
  await routes.list({ workspaceId: 'ws', preview: 'none' }, (event) => events.push(event));
  routes.cancel('ws');
  resolvePreview(preview('turn-1'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, [], 'a stale walker generation must emit neither undo nor page counts');
});

test('P5 preview:sync is bounded/concurrent and digest differs from preview:none only by completion envelope', async () => {
  let active = 0;
  let peak = 0;
  const rows = Array.from({ length: 8 }, (_, i) => turn({ id: `t${i}`, turnSeq: 8 - i }));
  const routes = makeRoutes({
    listTurns: () => sourcePage(rows, 1),
    previewRestore: async (_ws, turnId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return preview(turnId);
    },
  });
  const page = await routes.list({ workspaceId: 'ws', preview: 'none' });
  const digest = await routes.digest({ workspaceId: 'ws' });
  assert.ok(peak <= PREVIEW_CONCURRENCY);
  assert.deepEqual(flatTurns(page).map((row) => row.turnId), flatTurns(digest.page).map((row) => row.turnId));
  assert.equal(flatTurns(page)[0].undo.state, 'checking');
  assert.equal(flatTurns(digest.page)[0].undo.state, 'restorable');
  assert.equal(digest.heartbeat.serverState, 'idle-but-healthy');
  assert.ok(!('heartbeat' in page), 'ActivityPage never carries heartbeat');
});

test('T11 since watermarks are applied independently and pending counts remain honest', async () => {
  const rows = [turn({ id: 'new', turnSeq: 8 }), turn({ id: 'old', turnSeq: 4 })];
  const fas: ActivityFileActivity[] = [
    { id: 10, agentId: 'a1', filePath: '/repo/fa.ts', operation: 'write', timestamp: new Date(900).toISOString(), generation: 0, sessionId: null, enclosed: false },
    { id: 2, agentId: 'a1', filePath: '/repo/old.ts', operation: 'write', timestamp: new Date(800).toISOString(), generation: 0, sessionId: null, enclosed: false },
  ];
  const routes = makeRoutes({
    snapshot: () => ({ throughTurnSeq: 8, throughFileActivityId: 10, capturedAt: 1_000 }),
    listTurns: () => sourcePage(rows, 4),
    listFileActivities: () => sourcePage(fas, 2),
  });
  const pendingPage = await routes.list({ workspaceId: 'ws', preview: 'none' });
  assert.equal(pendingPage.pageCounts.blockedOverlapCount.status, 'pending');
  const digest = await routes.digest({ workspaceId: 'ws', since: { turnSeq: 5, fileActivityId: 5 } });
  assert.equal(digest.sinceCounts.turnCount, 1);
  assert.equal(digest.sinceCounts.fileCount, 2, 'one turn path plus the independently-new FA path');
  assert.equal(digest.sinceCounts.blockedOverlapCount.status, 'complete');
});

test('T13 no-engine list stays available while heartbeat remains a separate read-only endpoint', async () => {
  let heartbeatReads = 0;
  const snapshot = heartbeat({ lastSubsystemBeatAt: 321 });
  const routes = makeRoutes({ heartbeat: () => { heartbeatReads += 1; return snapshot; } });
  const page = await routes.list({ workspaceId: 'ws', preview: 'none' });
  assert.equal(flatTurns(page)[0].undo.state, 'checking');
  assert.equal(routes.heartbeat('ws').lastSubsystemBeatAt, 321);
  assert.equal(routes.heartbeat('ws').lastSubsystemBeatAt, 321, 'handler must never advance the manager beat');
  assert.equal(heartbeatReads, 2);
});

test('T17 binary window-path dependency is executed by the route projection', async () => {
  let calls = 0;
  const routes = makeRoutes({
    listWindowPaths: async (_ws, turnId, repoRoot) => {
      calls += 1;
      assert.equal(turnId, 'turn-1');
      assert.equal(repoRoot, '/repo');
      return { available: true, reason: 'ok', paths: ['src/a.ts', 'src/external.ts'],
        omittedPathCount: 0, hasOmittedPaths: false, truncated: false };
    },
  });
  const page = await routes.list({ workspaceId: 'ws', preview: 'none' });
  assert.equal(calls, 1);
  assert.ok(page.items.some((item) => item.kind === 'window-unattributed'
    && item.paths[0]?.repoPath === 'src/external.ts'));
});

test('production checkpoint IPC registrar installs every Activity request channel and names both push events', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerCheckpointIpc({
    handle: (channel, listener) => { handlers.set(channel, listener); },
  }, () => null);
  for (const channel of [
    ACTIVITY_CHANNELS.list,
    ACTIVITY_CHANNELS.digest,
    ACTIVITY_CHANNELS.heartbeat,
    ACTIVITY_CHANNELS.markViewed,
  ]) {
    assert.ok(handlers.has(channel), `${channel} must be registered by the production IPC registrar`);
  }
  assert.equal(ACTIVITY_CHANNELS.undoUpdated, 'activity:undo-updated');
  assert.equal(ACTIVITY_CHANNELS.pageCounts, 'activity:page-counts');
});

interface HttpResult { status: number; body: string; }
function request(port: number, path: string, authorization: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { Authorization: authorization }, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function checkpointRoutes(onList?: (opts: unknown) => void): CheckpointRoutes {
  return {
    list: (_workspaceId, opts) => { onList?.(opts); return []; },
    fileHistory: async () => [],
    diff: async () => ({ witnessed: { available: false, reason: null, label: '', text: null }, window: { available: false, reason: null, label: '', text: null } }),
    preview: async (turnId) => preview(turnId),
    restorePaths: async () => { throw new Error('unused'); },
    revertTurn: async () => { throw new Error('unused'); },
  };
}

test('production ApiServer registration enters GET /api/activity and checkpoint parser forwards P1 filters', async () => {
  const supervisor = { getContextStats: () => null, isInputInFlight: () => false } as unknown as AgentSupervisor;
  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  server.setActivityRoutes(makeRoutes());
  let checkpointOpts: unknown;
  server.setCheckpointRoutes(checkpointRoutes((opts) => { checkpointOpts = opts; }));
  const port = await server.start();
  const token = agentCapabilities.mint({ agentId: 'sup', workspaceId: 'ws', privilegeLane: 'supervisor' });
  try {
    const activity = await request(port, '/api/activity', `Bearer ${token}`);
    assert.equal(activity.status, 200, 'REACHABILITY:activity-routes-registered');
    assert.equal(JSON.parse(activity.body).workspaceId, 'ws');
    const checkpoints = await request(
      port,
      '/api/checkpoints?until=12&planId=p&planItemId=wp&eligibleOnly=false',
      `Bearer ${token}`,
    );
    assert.equal(checkpoints.status, 200);
    assert.deepEqual(checkpointOpts, {
      until: 12, planId: 'p', planItemId: 'wp', eligibleOnly: false,
    });
  } finally {
    server.stop();
    agentCapabilities.clear();
  }
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✗ ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) process.exitCode = 1;
  else console.log(`activity-routes: ${tests.length} tests passed`);
})();
