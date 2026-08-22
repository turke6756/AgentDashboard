// While-you-were-away WP-P3 — pure Activity row projection.
//
//   npm run build:main
//   node dist/main/main/activity/turn-projection.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ActivityCounts, CheckpointPreviewResult } from '../../shared/types';
import type { ActivityFileActivity, TurnRecord } from '../database';
import type { WindowPathList } from '../git-checkpoints/checkpoint-service';
import {
  projectTurnActivity,
  SESSION_GAP_MS,
  TOOL_UNJOINED_GAP_MS,
  type TurnPreviewAttachment,
} from './turn-projection';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: () => void | Promise<void>): void { tests.push({ name, run }); }

function turn(seq: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: `turn-${seq}`,
    workspaceId: 'workspace-1',
    turnSeq: seq,
    agentId: 'agent-1',
    agentTitle: 'Agent One',
    ownerAgentId: null,
    ownerBrickGeneration: null,
    planId: null,
    planItemId: null,
    planStampSource: 'legacy-unstamped',
    intentId: null,
    intentStampSource: null,
    sessionId: 'session-1',
    taskLabel: null,
    startedAt: seq * 1_000,
    endedAt: seq * 1_000 + 500,
    status: 'accepted',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: true,
    afterReady: true,
    beforeQuality: 'ready',
    afterQuality: 'ready',
    beforeRawFilterBypassed: false,
    beforeFilteredPaths: null,
    beforePrunedAt: null,
    afterPrunedAt: null,
    touched: [{ path: 'packages/app/src/a.ts', op: 'write' }],
    diffStats: null,
    compactDiff: null,
    compactDiffProvenance: null,
    failureReason: null,
    ...overrides,
  };
}

function preview(
  turnId: string,
  overrides: Partial<CheckpointPreviewResult> = {},
): CheckpointPreviewResult {
  return {
    available: true,
    reason: null,
    turnId,
    witnessedSet: [],
    tokens: {},
    validatedPaths: [],
    rejectedPaths: [],
    contention: [],
    ...overrides,
  };
}

function completeCounts(turnCount: number): ActivityCounts {
  const complete = (value: number) => ({ value, status: 'complete' as const });
  return {
    turnCount,
    agentCount: 1,
    fileCount: 1,
    planCount: 1,
    commitCount: 0,
    noCheckpointCount: 0,
    blockedOverlapCount: complete(0),
    unavailableCount: complete(0),
    checkingCount: complete(0),
  };
}

const baseInput = { repoRoot: path.parse(process.cwd()).root, workspacePrefix: 'packages/app' };

test('T1: stored task labels are copied verbatim, including null', () => {
  const result = projectTurnActivity({
    ...baseInput,
    turns: [
      turn(3, { taskLabel: null }),
      turn(2, { taskLabel: 'Brief supplied by caller' }),
      turn(1, { taskLabel: 'Derived and stored first line' }),
    ],
  });
  const rows = result.items.filter((item) => item.kind === 'turn');
  assert.deepEqual(rows.map((row) => row.taskLabel), [null, 'Brief supplied by caller', 'Derived and stored first line']);
});

test('T2: repeated task labels never create plan groups', () => {
  const turns = Array.from({ length: 10 }, (_, index) => turn(10 - index, {
    taskLabel: 'Reviewer Feedback:',
  }));
  const result = projectTurnActivity({ ...baseInput, turns });
  assert.equal(result.items.filter((item) => item.kind === 'turn').length, 10);
  assert.equal(result.items.filter((item) => item.kind === 'plan-group').length, 0);
});

test('T3: only verified plan ids group, page membership stays local, and totals are honest', () => {
  const verified = [9, 8, 7, 6].map((seq) => turn(seq, {
    planId: 'plan-P',
    planItemId: 'WP-P3',
    planStampSource: 'explicit',
  }));
  const result = projectTurnActivity({
    ...baseInput,
    turns: [...verified, turn(5), turn(4)],
    turnScanExhausted: false, // An older plan-P turn exists below this page cursor.
    turnsComplete: false,
    nextOlderTurnSeq: 4,
  });
  const groups = result.items.filter((item) => item.kind === 'plan-group');
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((member) => member.turnSeq), [9, 8, 7, 6]);
  assert.equal(groups[0].countsComplete, false);
  assert.equal(groups[0].totalCounts, undefined);
  assert.deepEqual(groups[0].nextOlderCursor, { turnSeq: 4 });
  assert.deepEqual(
    result.items.filter((item) => item.kind === 'turn').map((item) => item.turnSeq),
    [5, 4],
  );

  const exact = completeCounts(5);
  const withExactTotal = projectTurnActivity({
    ...baseInput,
    turns: verified,
    turnScanExhausted: false,
    turnsComplete: false,
    exactPlanCounts: new Map([['plan-P', exact]]),
  });
  const exactGroup = withExactTotal.items.find((item) => item.kind === 'plan-group');
  assert.ok(exactGroup);
  assert.equal(exactGroup.countsComplete, true);
  assert.equal(exactGroup.totalCounts, exact);
});

test('T4: agent-default without a plan is unstamped and remains flat', () => {
  const result = projectTurnActivity({
    ...baseInput,
    turns: [turn(1, { planId: null, planStampSource: 'agent-default' })],
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'turn');
  if (result.items[0].kind !== 'turn') throw new Error('expected turn');
  assert.equal(result.items[0].planStampStatus, 'unstamped');
  assert.equal(result.items[0].planId, null);
});

test('T6: stored hints never claim restorable or blocked overlap', () => {
  const result = projectTurnActivity({
    ...baseInput,
    turns: [
      turn(3, { failureReason: 'overlapping-active-turn' }),
      turn(2, { beforeReady: false }),
      turn(1, { afterPrunedAt: 123 }),
    ],
  });
  const rows = result.items.filter((item) => item.kind === 'turn');
  assert.deepEqual(rows.map((row) => row.undo.state), ['checking', 'no-checkpoint', 'no-checkpoint']);
  assert.ok(rows.every((row) => row.undo.basis === 'stored-hints'));
  assert.ok(rows.every((row) => row.undo.reason === null && row.undo.contention.length === 0));
  assert.deepEqual(result.pageCounts.blockedOverlapCount, { value: null, status: 'pending' });
  assert.deepEqual(result.pageCounts.unavailableCount, { value: null, status: 'pending' });
  assert.deepEqual(result.pageCounts.checkingCount, { value: null, status: 'pending' });
});

test('P5: live previews map every undo branch without consulting historical failureReason', () => {
  const turns = [1, 2, 3, 4, 5, 6].map((seq) => turn(seq, {
    failureReason: seq === 1 ? 'after-snapshot-overlap' : 'historical-capture-quality',
  }));
  const contention = [{ path: 'packages/app/src/a.ts', turnId: 'open-turn' }];
  const previews = new Map<string, TurnPreviewAttachment>([
    ['turn-1', preview('turn-1')],
    ['turn-2', preview('turn-2', {
      available: false,
      reason: 'after-snapshot-overlap',
      overlap: { reason: 'after-snapshot-overlap', files: [{ path: 'packages/app/src/a.ts', blockers: [] }] },
      contention,
    })],
    ['turn-3', preview('turn-3', { available: false, reason: 'active-turn-witnesses-path', contention })],
    ['turn-4', preview('turn-4', { available: false, reason: 'after-edge-unusable' })],
    ['turn-5', preview('turn-5', { available: false, reason: 'current-hash-failed', contention })],
    ['turn-6', { unavailable: true as const, reason: 'engine-absent' }],
  ]);
  const result = projectTurnActivity({ ...baseInput, turns, previews });
  const byId = new Map(result.items
    .filter((item) => item.kind === 'turn')
    .map((row) => [row.turnId, row]));
  assert.equal(byId.get('turn-1')?.undo.state, 'restorable');
  assert.equal(byId.get('turn-2')?.undo.state, 'blocked-overlap');
  assert.ok(byId.get('turn-2')?.undo.overlap);
  assert.equal(byId.get('turn-3')?.undo.state, 'blocked-overlap');
  assert.equal(byId.get('turn-3')?.undo.overlap, undefined);
  assert.deepEqual(byId.get('turn-3')?.undo.contention, contention);
  assert.equal(byId.get('turn-4')?.undo.state, 'no-checkpoint');
  assert.equal(byId.get('turn-5')?.undo.state, 'unavailable');
  assert.equal(byId.get('turn-6')?.undo.state, 'unavailable');
  assert.deepEqual(result.pageCounts.blockedOverlapCount, { value: 2, status: 'complete' });
  assert.deepEqual(result.pageCounts.unavailableCount, { value: 2, status: 'complete' });
  assert.deepEqual(result.pageCounts.checkingCount, { value: 0, status: 'complete' });
});

test('P2/P7/P8: nested-workspace paths, agent/gap clustering, and outside-workspace honesty', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-projection-'));
  const workspacePrefix = 'packages/app';
  const insideA = path.join(repoRoot, workspacePrefix, 'src', 'a.ts');
  const insideB = path.join(repoRoot, workspacePrefix, 'src', 'b.ts');
  const outside = path.join(repoRoot, 'other', 'outside.ts');
  const timestamp = new Date(1_000_000).toISOString();
  const fa = (
    id: number,
    agentId: string,
    filePath: string,
    at: number,
    enclosed = false,
  ): ActivityFileActivity => ({
    id,
    agentId,
    filePath,
    operation: 'write',
    timestamp: new Date(at).toISOString(),
    generation: 1,
    sessionId: 'session-1',
    enclosed,
  });
  try {
    const result = projectTurnActivity({
      turns: [],
      repoRoot,
      workspacePrefix,
      agentTitles: new Map([['agent-1', 'One'], ['agent-2', 'Two']]),
      fileActivities: [
        fa(1, 'agent-1', insideA, Date.parse(timestamp)),
        fa(2, 'agent-1', insideB, Date.parse(timestamp) + 1_000),
        fa(3, 'agent-2', insideA, Date.parse(timestamp) + 2_000),
        fa(4, 'agent-2', insideB, Date.parse(timestamp) + 2_000 + TOOL_UNJOINED_GAP_MS + 1),
        fa(5, 'agent-1', outside, Date.parse(timestamp) + 3_000),
        fa(6, 'agent-1', insideA, Date.parse(timestamp) + 4_000, true),
      ],
    });
    const rows = result.items.filter((item) => item.kind === 'tool-unjoined');
    assert.deepEqual(rows.map((row) => row.id), [
      'tool:agent-1:1:2',
      'tool:agent-2:3:3',
      'tool:agent-2:4:4',
    ]);
    assert.deepEqual(rows[0].paths, [
      { repoPath: 'packages/app/src/a.ts', displayPath: 'src/a.ts' },
      { repoPath: 'packages/app/src/b.ts', displayPath: 'src/b.ts' },
    ]);
    assert.equal(rows[0].agentId, 'agent-1');
    assert.deepEqual(result.fileActivityStats, { scanned: 6, emitted: 4, outsideWorkspaceCount: 1 });
    assert.equal(result.pageCounts.fileCount, 2);
    assert.equal(result.pageCounts.agentCount, 2);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('P8/P9: window rows subtract witnessed repo paths and preserve omission flags', () => {
  const windows = new Map<string, WindowPathList>([
    ['turn-1', {
      available: false,
      reason: 'non-utf8',
      paths: ['packages/app/src/a.ts', 'packages/app/src/external.ts'],
      omittedPathCount: 2,
      hasOmittedPaths: true,
      truncated: false,
    }],
    ['turn-2', {
      available: false,
      reason: 'cap-exhausted',
      paths: [],
      omittedPathCount: null,
      hasOmittedPaths: true,
      truncated: true,
    }],
  ]);
  const result = projectTurnActivity({
    ...baseInput,
    turns: [turn(2), turn(1)],
    windowPaths: windows,
  });
  const rows = result.items.filter((item) => item.kind === 'window-unattributed');
  assert.deepEqual(rows, [
    {
      kind: 'window-unattributed',
      id: 'win:turn-2',
      hostTurnId: 'turn-2',
      hostTurnSeq: 2,
      paths: [],
      omittedPathCount: null,
      hasOmittedPaths: true,
    },
    {
      kind: 'window-unattributed',
      id: 'win:turn-1',
      hostTurnId: 'turn-1',
      hostTurnSeq: 1,
      paths: [{ repoPath: 'packages/app/src/external.ts', displayPath: 'src/external.ts' }],
      omittedPathCount: 2,
      hasOmittedPaths: true,
    },
  ]);
});

test('WP-3: window attribution is host-turn-local and independent of turn input order', () => {
  const turns = [
    turn(2, {
      agentId: 'agent-a',
      touched: [{ path: 'packages/app/src/shared.ts', op: 'write' }],
    }),
    turn(1, {
      agentId: 'agent-b',
      touched: [{ path: 'packages/app/src/other.ts', op: 'write' }],
    }),
  ];
  const windowPaths = new Map<string, WindowPathList>([
    ['turn-1', {
      available: true,
      reason: 'ok',
      paths: ['packages/app/src/shared.ts'],
      omittedPathCount: 0,
      hasOmittedPaths: false,
      truncated: false,
    }],
  ]);

  const project = (orderedTurns: readonly TurnRecord[]) => projectTurnActivity({
    ...baseInput,
    turns: orderedTurns,
    windowPaths,
  });
  const forward = project(turns);
  const reversed = project([...turns].reverse());
  const row = forward.items.find((item) => item.kind === 'window-unattributed');

  assert.deepEqual(row, {
    kind: 'window-unattributed',
    id: 'win:turn-1',
    hostTurnId: 'turn-1',
    hostTurnSeq: 1,
    paths: [{ repoPath: 'packages/app/src/shared.ts', displayPath: 'src/shared.ts' }],
    omittedPathCount: 0,
    hasOmittedPaths: false,
  });
  assert.deepEqual(reversed, forward);
});

test('WP-8 time: local-midnight buckets honor the requested zone', () => {
  const turns = [
    turn(2, { startedAt: Date.parse('2026-03-08T04:30:00Z') }),
    turn(1, { startedAt: Date.parse('2026-03-08T05:30:00Z') }),
  ];
  const utc = projectTurnActivity({ ...baseInput, turns, grouping: 'time', timeZone: 'UTC' });
  const ny = projectTurnActivity({ ...baseInput, turns, grouping: 'time', timeZone: 'America/New_York' });
  assert.deepEqual(utc.items.filter((row) => row.kind === 'day-group').map((row) => row.dayKey), ['2026-03-08']);
  assert.deepEqual(ny.items.filter((row) => row.kind === 'day-group').map((row) => row.dayKey), ['2026-03-08', '2026-03-07']);
});

test('WP-8 time: spring-forward instants produce one stable local-date bucket', () => {
  const result = projectTurnActivity({
    ...baseInput,
    grouping: 'time',
    timeZone: 'America/New_York',
    turns: [
      turn(2, { startedAt: Date.parse('2026-03-08T06:59:59Z') }),
      turn(1, { startedAt: Date.parse('2026-03-08T07:00:01Z') }),
    ],
  });
  const groups = result.items.filter((row) => row.kind === 'day-group');
  assert.deepEqual(groups.map((row) => row.dayKey), ['2026-03-08']);
  assert.deepEqual(groups[0].members.map((row) => row.startedAt), [
    Date.parse('2026-03-08T07:00:01Z'),
    Date.parse('2026-03-08T06:59:59Z'),
  ]);
});

test('WP-8 time: invalid zones fail open to UTC and null timestamps remain terminal', () => {
  const result = projectTurnActivity({
    ...baseInput,
    grouping: 'time',
    timeZone: 'Not/AZone',
    turns: [turn(2, { startedAt: null }), turn(1, { startedAt: Date.parse('2026-01-02T00:00:00Z') })],
  });
  const groups = result.items.filter((row) => row.kind === 'day-group');
  assert.equal(result.scope.timeZone, 'UTC');
  assert.deepEqual(groups.map((row) => row.dayKey), ['2026-01-02', null]);
  assert.equal(groups[1].gapFromNewerGroupMs, null);
});

test('WP-8 time: cross-midnight gaps are computed globally before day bucketing', () => {
  const newer = Date.parse('2026-01-02T00:20:00Z');
  const older = newer - SESSION_GAP_MS - 1;
  const result = projectTurnActivity({
    ...baseInput,
    grouping: 'time',
    timeZone: 'UTC',
    turns: [turn(1, { startedAt: newer }), turn(2, { startedAt: older })],
  });
  const groups = result.items.filter((row) => row.kind === 'day-group');
  assert.deepEqual(groups.map((row) => row.dayKey), ['2026-01-02', '2026-01-01']);
  assert.equal(groups[1].members[0].gapFromNewerMs, SESSION_GAP_MS + 1);
  assert.equal(groups[1].members[0].sessionBoundary, true);
  assert.equal(groups[1].gapFromNewerGroupMs, SESSION_GAP_MS + 1);
});

test('WP-8 file: fan-out, canonical per-turn dedupe, and distinct page counts', () => {
  const result = projectTurnActivity({
    ...baseInput,
    grouping: 'file',
    turns: [
      turn(2, { touched: [
        { path: 'packages/app/src/a.ts', op: 'write' },
        { path: 'packages/app/src/./a.ts', op: 'create' },
        { path: 'packages/app/src/c.ts', op: 'write' },
        { path: 'packages/app/docs/b.md', op: 'write' },
      ] }),
      turn(1, { touched: [
        { path: 'packages/app/src/a.ts', op: 'write' },
        { path: 'packages/app/src/c.ts', op: 'write' },
      ] }),
    ],
  });
  const groups = result.items.filter((row) => row.kind === 'file-group');
  assert.equal(groups.length, 3);
  assert.equal(groups.find((row) => row.repoPath.endsWith('/src/a.ts'))?.members.length, 2);
  assert.ok(groups.every((row) => row.pageCounts.fileCount === 1));
  assert.equal(result.pageCounts.turnCount, 2);
  assert.equal(result.pageCounts.fileCount, 3);

  const twoKeys = projectTurnActivity({
    ...baseInput,
    grouping: 'file',
    turns: [2, 1].map((seq) => turn(seq, { touched: [
      { path: 'packages/app/src/a.ts', op: 'write' },
      { path: 'packages/app/src/c.ts', op: 'write' },
    ] })),
  });
  const twoGroups = twoKeys.items.filter((row) => row.kind === 'file-group');
  assert.equal(twoKeys.pageCounts.fileCount, 2);
  assert.ok(twoGroups.every((row) => row.pageCounts.fileCount === 1));
});

test('WP-8 file: prefix restricts groups while relational axes retain all paths', () => {
  const mixed = turn(1, { touched: [
    { path: 'packages/app/src/a.ts', op: 'write' },
    { path: 'packages/app/docs/b.md', op: 'write' },
  ] });
  for (const prefix of ['packages/app/src', './packages/app/src/', 'packages\\app\\src']) {
    const file = projectTurnActivity({ ...baseInput, turns: [mixed], grouping: 'file', pathPrefix: prefix });
    const groups = file.items.filter((row) => row.kind === 'file-group');
    assert.deepEqual(groups.map((row) => row.repoPath), ['packages/app/src/a.ts']);
    assert.equal(file.pageCounts.fileCount, 1);
    assert.equal(groups[0].pageCounts.fileCount, 1);
  }
  const caseMismatch = projectTurnActivity({ ...baseInput, turns: [mixed], grouping: 'file', pathPrefix: 'packages/app/SRC' });
  assert.equal(caseMismatch.items.length, 0);
  for (const grouping of ['plan', 'time', 'none'] as const) {
    const result = projectTurnActivity({ ...baseInput, turns: [mixed], grouping, pathPrefix: 'packages/app/src' });
    const rows = result.items.flatMap((row) => row.kind === 'plan-group' || row.kind === 'day-group'
      ? row.members
      : row.kind === 'turn' ? [row] : []);
    assert.deepEqual(rows[0].witnessedPaths.map((entry) => entry.displayPath), ['docs/b.md', 'src/a.ts']);
  }
});

test('WP-8 file: literal paths stay independent and path-less turns are reported', () => {
  const turns = [
    turn(5, { touched: [{ path: 'packages/app/a.ts', op: 'write' }] }),
    turn(4, { touched: [{ path: 'packages/app/b.ts', op: 'write' }] }),
    turn(3, { touched: [{ path: 'packages/app/a.ts', op: 'write' }] }),
    turn(2, { touched: [] }),
    turn(1, { touched: null }),
  ];
  const result = projectTurnActivity({ ...baseInput, turns, grouping: 'file' });
  const groups = result.items.filter((row) => row.kind === 'file-group');
  assert.deepEqual(groups.map((row) => row.repoPath).sort(), ['packages/app/a.ts', 'packages/app/b.ts']);
  assert.equal(result.pageCounts.turnCount, 3);
  assert.equal(result.scope.turnCountBasis, 'visible-file-group-members');
  assert.equal(result.scope.loadedTurnsExcludedFromFileGroups, 2);
});

test('WP-8 ancillary: non-plan axes re-home rows, keep them outside prefix, and count their path union', () => {
  const repoRoot = path.parse(process.cwd()).root;
  const fileActivities: ActivityFileActivity[] = [{
    id: 1,
    agentId: 'tool-agent',
    filePath: path.join(repoRoot, 'packages/app/docs/tool.md'),
    operation: 'write',
    timestamp: new Date(10_000).toISOString(),
    generation: 1,
    sessionId: 'session-1',
    enclosed: false,
  }];
  const windowPaths = new Map<string, WindowPathList>([['turn-1', {
    available: false,
    reason: 'cap-exhausted',
    paths: ['packages/app/docs/tool.md', 'packages/app/docs/window.md'],
    omittedPathCount: 1,
    hasOmittedPaths: true,
    truncated: true,
  }]]);
  const common = { ...baseInput, turns: [turn(1)], fileActivities, windowPaths, pathPrefix: 'packages/app/src', turnsComplete: true, filesComplete: true };
  for (const grouping of ['time', 'file', 'none'] as const) {
    const result = projectTurnActivity({ ...common, grouping });
    assert.ok(result.items.every((row) => row.kind !== 'tool-unjoined' && row.kind !== 'window-unattributed'));
    assert.deepEqual(result.ancillary?.counts, { toolUnjoinedCount: 1, windowUnattributedCount: 1, pathCount: 2 });
    assert.equal(result.ancillary?.scopedByPathPrefix, false);
    assert.equal(result.scope.completeness.ancillaryPaths, false);
    assert.equal(result.pageCounts.fileCount, 1);
  }
  const complete = projectTurnActivity({
    ...common,
    grouping: 'none',
    windowPaths: new Map([['turn-1', { ...windowPaths.get('turn-1')!, omittedPathCount: 0, hasOmittedPaths: false }]]),
  });
  assert.equal(complete.scope.completeness.ancillaryPaths, true);
  const plan = projectTurnActivity({ ...common, grouping: 'plan' });
  assert.ok(plan.items.some((row) => row.kind === 'tool-unjoined'));
  assert.ok(plan.items.some((row) => row.kind === 'window-unattributed'));
  assert.equal(plan.ancillary, undefined);
  assert.equal(plan.pageCounts.fileCount, 2);
  assert.equal(plan.pageCounts.agentCount, 2);
  assert.equal(plan.scope.turnCountBasis, 'loaded-turns');
});

test('WP-8 grouping regression: omitted and explicit plan preserve legacy projection fields exactly', () => {
  const input = {
    ...baseInput,
    turns: [turn(2, { planId: 'plan-P', planItemId: 'WP-8', planStampSource: 'explicit' }), turn(1)],
    turnScanExhausted: false,
    turnsComplete: false,
    nextOlderTurnSeq: 1,
  };
  const omitted = projectTurnActivity(input);
  const explicit = projectTurnActivity({ ...input, grouping: 'plan' });
  const legacyFields = (result: ReturnType<typeof projectTurnActivity>) => ({
    items: result.items,
    pageCounts: result.pageCounts,
    fileActivityStats: result.fileActivityStats,
  });
  assert.deepEqual(legacyFields(omitted), legacyFields(explicit));
  assert.deepEqual(omitted.scope, explicit.scope);
});

test('WP-8 none: items are a reverse-turnSeq turn-only stream', () => {
  const result = projectTurnActivity({ ...baseInput, grouping: 'none', turns: [turn(1), turn(3), turn(2)] });
  assert.deepEqual(result.items.map((row) => row.kind), ['turn', 'turn', 'turn']);
  assert.deepEqual(result.items.flatMap((row) => row.kind === 'turn' ? [row.turnSeq] : []), [3, 2, 1]);
  assert.equal(result.scope.timeZone, undefined);
});

test('WP-8 completeness: paging exhaustion and population completeness remain independent', () => {
  const planned = turn(1, { planId: 'plan-P', planItemId: 'WP-8', planStampSource: 'explicit' });
  const continuation = projectTurnActivity({
    ...baseInput, turns: [planned], turnScanExhausted: true, turnsComplete: false,
  });
  const continuationGroup = continuation.items.find((row) => row.kind === 'plan-group');
  assert.equal(continuation.scope.completeness.turns, false);
  assert.equal(continuationGroup?.countsComplete, false);
  assert.equal(continuationGroup?.nextOlderCursor.turnSeq, null);
  const firstPage = projectTurnActivity({
    ...baseInput, turns: [planned], turnScanExhausted: true, turnsComplete: true, filesComplete: true,
  });
  const firstPageGroup = firstPage.items.find((row) => row.kind === 'plan-group');
  assert.equal(firstPage.scope.completeness.turns, true);
  assert.equal(firstPageGroup?.countsComplete, true);
  assert.equal(firstPageGroup?.nextOlderCursor.turnSeq, null);
  const truncated = projectTurnActivity({
    ...baseInput, turns: [planned], turnScanExhausted: false, turnsComplete: false, nextOlderTurnSeq: 1,
  });
  const truncatedGroup = truncated.items.find((row) => row.kind === 'plan-group');
  assert.equal(truncatedGroup?.countsComplete, false);
  assert.equal(truncatedGroup?.nextOlderCursor.turnSeq, 1);
});

test('WP-8 completeness: prefix, source divergence, and undo resolution are orthogonal', () => {
  const planned = turn(1, { planId: 'plan-P', planItemId: 'WP-8', planStampSource: 'explicit' });
  const plan = projectTurnActivity({
    ...baseInput,
    turns: [planned],
    pathPrefix: 'packages/app/src',
    turnsComplete: true,
    filesComplete: false,
  });
  assert.deepEqual(plan.scope.completeness, { turns: true, agents: false, plans: true, commits: true, files: false });
  const time = projectTurnActivity({
    ...baseInput,
    turns: [planned],
    grouping: 'time',
    pathPrefix: 'packages/app/src',
    turnsComplete: true,
    filesComplete: false,
  });
  assert.deepEqual(time.scope.completeness, {
    turns: true, agents: true, plans: true, commits: true, files: true, ancillaryPaths: false,
  });
  assert.equal(time.pageCounts.checkingCount.status, 'pending');
});

test('WP-8 completeness: exact plan aggregates are suppressed under pathPrefix', () => {
  const planned = turn(1, { planId: 'plan-P', planItemId: 'WP-8', planStampSource: 'explicit' });
  const result = projectTurnActivity({
    ...baseInput,
    turns: [planned],
    pathPrefix: 'packages/app/src',
    turnsComplete: false,
    exactPlanCounts: new Map([['plan-P', completeCounts(99)]]),
  });
  const group = result.items.find((row) => row.kind === 'plan-group');
  assert.equal(group?.totalCounts, undefined);
  assert.equal(group?.countsComplete, false);
});

async function main(): Promise<void> {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`ok - ${entry.name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${entry.name}`);
      console.error(error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
