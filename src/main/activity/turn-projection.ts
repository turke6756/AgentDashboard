import * as path from 'node:path';

import type {
  ActivityAncillary,
  ActivityCountScope,
  ActivityCounts,
  ActivityItem,
  ActivityPath,
  ActivityUndoSafety,
  CheckpointPreviewResult,
  DayGroupRow,
  FileGroupRow,
  PlanGroupRow,
  ToolUnjoinedRow,
  TurnActivityRow,
  WindowUnattributedRow,
} from '../../shared/types';
import type {
  ActivityFileActivity,
  CommitTurnLink,
  TurnRecord,
} from '../database';
import type { WindowPathList } from '../git-checkpoints/checkpoint-service';
import { normalizeWitnessPath } from '../git-checkpoints/witness-recorder';
import { classifyTurnPlanStamp } from '../plans/stamped-evidence-projection';

export const TOOL_UNJOINED_GAP_MS = 300_000;
export const SESSION_GAP_MS = 1_800_000;

export type TurnPreviewAttachment =
  | CheckpointPreviewResult
  | { unavailable: true; reason?: string | null };

export interface TurnProjectionInput {
  turns: readonly TurnRecord[];
  fileActivities?: readonly ActivityFileActivity[];
  repoRoot: string;
  workspacePrefix?: string;
  previews?: ReadonlyMap<string, TurnPreviewAttachment>;
  windowPaths?: ReadonlyMap<string, WindowPathList>;
  commitLinks?: readonly CommitTurnLink[];
  agentTitles?: ReadonlyMap<string, string | null>;
  planTitles?: ReadonlyMap<string, string | null>;
  /**
   * Values here must come from an exact, unbounded aggregate whose population
   * ALREADY reflects every source-level filter in force for this request
   * (agentId, planId, planItemId, effective eligibleOnly). The only effective
   * filter it cannot reflect is the post-projection pathPrefix; therefore an
   * exact aggregate is attached only when input.pathPrefix === undefined.
   */
  exactPlanCounts?: ReadonlyMap<string, ActivityCounts>;
  turnScanExhausted?: boolean;
  turnsComplete?: boolean;
  filesComplete?: boolean;
  /** @deprecated Transitional WP-9 call-site compatibility; projection never reads it. */
  turnsExhausted?: boolean;
  nextOlderTurnSeq?: number | null;
  grouping?: 'plan' | 'time' | 'file' | 'none';
  pathPrefix?: string;
  timeZone?: string;
  agentId?: string;
  planId?: string;
  planItemId?: string;
  eligibleOnly?: boolean;
}

export interface ActivityFileScanProjection {
  scanned: number;
  emitted: number;
  outsideWorkspaceCount: number;
}

export interface TurnProjectionResult {
  items: ActivityItem[];
  pageCounts: ActivityCounts;
  fileActivityStats: ActivityFileScanProjection;
  scope: ActivityCountScope;
  ancillary?: ActivityAncillary;
}

function canonicalRepoPath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function normalizedPrefix(value: string | undefined): string {
  if (!value) return '';
  const normalized = canonicalRepoPath(value);
  return normalized ?? '';
}

function toActivityPath(repoPath: string, workspacePrefix: string): ActivityPath | null {
  const canonical = canonicalRepoPath(repoPath);
  if (canonical === null) return null;
  if (!workspacePrefix) return { repoPath: canonical, displayPath: canonical };
  if (!canonical.startsWith(`${workspacePrefix}/`)) return null;
  const displayPath = canonical.slice(workspacePrefix.length + 1);
  return displayPath ? { repoPath: canonical, displayPath } : null;
}

function uniquePaths(paths: readonly ActivityPath[]): ActivityPath[] {
  const byRepoPath = new Map<string, ActivityPath>();
  for (const activityPath of paths) byRepoPath.set(activityPath.repoPath, activityPath);
  return [...byRepoPath.values()].sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

function matchesPathPrefix(repoPath: string, pathPrefix: string): boolean {
  return repoPath === pathPrefix || repoPath.startsWith(`${pathPrefix}/`);
}

function makeDayKeyFn(timeZone: string | undefined): {
  timeZone: string;
  dayKey: (timestamp: number) => string;
} {
  let effectiveTimeZone = timeZone ?? 'UTC';
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // Some runtimes canonicalize aliases; report the actual formatter zone.
    effectiveTimeZone = formatter.resolvedOptions().timeZone;
  } catch {
    effectiveTimeZone = 'UTC';
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: effectiveTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  return {
    timeZone: effectiveTimeZone,
    dayKey: (timestamp) => {
      const parts = formatter.formatToParts(timestamp);
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
      return `${part('year')}-${part('month')}-${part('day')}`;
    },
  };
}

function storedHintUndo(turn: TurnRecord): ActivityUndoSafety {
  const lacksCheckpoint = turn.status !== 'open' && (
    !turn.beforeReady || !turn.afterReady
    || turn.beforePrunedAt !== null || turn.afterPrunedAt !== null
  );
  return {
    state: lacksCheckpoint ? 'no-checkpoint' : 'checking',
    basis: 'stored-hints',
    reason: null,
    contention: [],
  };
}

function previewUndo(preview: TurnPreviewAttachment): ActivityUndoSafety {
  if ('unavailable' in preview) {
    return {
      state: 'unavailable',
      basis: 'preview',
      reason: preview.reason ?? null,
      contention: [],
    };
  }
  if (preview.available) {
    return {
      state: 'restorable',
      basis: 'preview',
      reason: preview.reason,
      contention: [],
    };
  }
  if (preview.reason === 'after-snapshot-overlap') {
    return {
      state: 'blocked-overlap',
      basis: 'preview',
      reason: preview.reason,
      overlap: preview.overlap,
      contention: preview.contention,
    };
  }
  if (preview.reason === 'active-turn-witnesses-path') {
    return {
      state: 'blocked-overlap',
      basis: 'preview',
      reason: preview.reason,
      contention: preview.contention,
    };
  }
  if (preview.reason === 'before-edge-unusable' || preview.reason === 'after-edge-unusable') {
    return {
      state: 'no-checkpoint',
      basis: 'preview',
      reason: preview.reason,
      overlap: preview.reason === 'after-edge-unusable' ? preview.overlap : undefined,
      contention: preview.contention,
    };
  }
  return {
    state: 'unavailable',
    basis: 'preview',
    reason: preview.reason,
    contention: preview.contention,
  };
}

function countTurns(turns: readonly TurnActivityRow[], extraPaths: readonly ActivityPath[] = []): ActivityCounts {
  const agentIds = new Set<string>();
  const repoPaths = new Set(extraPaths.map((entry) => entry.repoPath));
  const planIds = new Set<string>();
  const commitOids = new Set<string>();
  let noCheckpointCount = 0;
  let blockedOverlapCount = 0;
  let unavailableCount = 0;
  let checkingCount = 0;
  for (const turn of turns) {
    if (turn.agentId !== null) agentIds.add(turn.agentId);
    if (turn.planId !== null) planIds.add(turn.planId);
    for (const activityPath of turn.witnessedPaths) repoPaths.add(activityPath.repoPath);
    for (const oid of turn.commitOids) commitOids.add(oid);
    if (turn.undo.state === 'no-checkpoint') noCheckpointCount += 1;
    if (turn.undo.state === 'blocked-overlap') blockedOverlapCount += 1;
    if (turn.undo.state === 'unavailable') unavailableCount += 1;
    if (turn.undo.state === 'checking') checkingCount += 1;
  }
  const previewsComplete = checkingCount === 0;
  return {
    turnCount: turns.length,
    agentCount: agentIds.size,
    fileCount: repoPaths.size,
    planCount: planIds.size,
    commitCount: commitOids.size,
    noCheckpointCount,
    blockedOverlapCount: previewsComplete
      ? { value: blockedOverlapCount, status: 'complete' }
      : { value: null, status: 'pending' },
    unavailableCount: previewsComplete
      ? { value: unavailableCount, status: 'complete' }
      : { value: null, status: 'pending' },
    checkingCount: previewsComplete
      ? { value: 0, status: 'complete' }
      : { value: null, status: 'pending' },
  };
}

function withFileCount(counts: ActivityCounts, fileCount: number): ActivityCounts {
  return { ...counts, fileCount };
}

function projectTurn(
  turn: TurnRecord,
  workspacePrefix: string,
  previews: ReadonlyMap<string, TurnPreviewAttachment> | undefined,
  commitOids: readonly string[],
): TurnActivityRow {
  const stamp = classifyTurnPlanStamp(turn);
  const witnessedPaths = uniquePaths((turn.touched ?? [])
    .filter((entry) => entry.op === 'write' || entry.op === 'create')
    .map((entry) => toActivityPath(entry.path, workspacePrefix))
    .filter((entry): entry is ActivityPath => entry !== null));
  const preview = previews?.get(turn.id);
  return {
    kind: 'turn',
    turnId: turn.id,
    turnSeq: turn.turnSeq,
    agentId: turn.agentId,
    agentTitle: turn.agentTitle,
    taskLabel: turn.taskLabel,
    planId: stamp.planStampStatus === 'verified' ? stamp.planId : null,
    planItemId: stamp.planStampStatus === 'verified' ? stamp.planItemId : null,
    planStampStatus: stamp.planStampStatus,
    status: turn.status,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    witnessedPaths,
    writeCount: witnessedPaths.length,
    undo: preview === undefined ? storedHintUndo(turn) : previewUndo(preview),
    beforeReady: turn.beforeReady,
    afterReady: turn.afterReady,
    beforeQuality: turn.beforeQuality,
    afterQuality: turn.afterQuality,
    failureReason: turn.failureReason,
    beforePrunedAt: turn.beforePrunedAt,
    afterPrunedAt: turn.afterPrunedAt,
    commitOids: [...new Set(commitOids)].sort(),
  };
}

function projectToolRows(
  fileActivities: readonly ActivityFileActivity[],
  repoRoot: string,
  workspacePrefix: string,
  agentTitles: ReadonlyMap<string, string | null> | undefined,
): { rows: ToolUnjoinedRow[]; outsideWorkspaceCount: number; emitted: number } {
  let outsideWorkspaceCount = 0;
  const usable = fileActivities
    .map((activity) => {
      const repoPath = normalizeWitnessPath(
        { turnId: `activity:${activity.id}`, repoRoot, workspacePrefix },
        activity.filePath,
      );
      const activityPath = repoPath === null ? null : toActivityPath(repoPath, workspacePrefix);
      if (activityPath === null) outsideWorkspaceCount += 1;
      return { activity, activityPath };
    })
    .filter((entry) => !entry.activity.enclosed && entry.activityPath !== null)
    .sort((a, b) => a.activity.id - b.activity.id) as Array<{
      activity: ActivityFileActivity;
      activityPath: ActivityPath;
    }>;

  const clusters: typeof usable[] = [];
  for (const entry of usable) {
    const cluster = clusters.at(-1);
    const previous = cluster?.at(-1);
    const timestamp = Date.parse(entry.activity.timestamp);
    const previousTimestamp = previous ? Date.parse(previous.activity.timestamp) : timestamp;
    if (!cluster || previous?.activity.agentId !== entry.activity.agentId
        || timestamp - previousTimestamp > TOOL_UNJOINED_GAP_MS) {
      clusters.push([entry]);
    } else {
      cluster.push(entry);
    }
  }

  const rows = clusters.map((cluster): ToolUnjoinedRow => {
    const first = cluster[0];
    const last = cluster[cluster.length - 1];
    const startedAt = Date.parse(first.activity.timestamp);
    const endedAt = Date.parse(last.activity.timestamp);
    return {
      kind: 'tool-unjoined',
      id: `tool:${first.activity.agentId}:${first.activity.id}:${last.activity.id}`,
      agentId: first.activity.agentId,
      agentTitle: agentTitles?.get(first.activity.agentId) ?? null,
      fileActivityIds: cluster.map((entry) => entry.activity.id),
      paths: uniquePaths(cluster.map((entry) => entry.activityPath)),
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      endedAt: Number.isFinite(endedAt) ? endedAt : 0,
    };
  });
  return { rows, outsideWorkspaceCount, emitted: usable.length };
}

export function projectTurnActivity(input: TurnProjectionInput): TurnProjectionResult {
  const workspacePrefix = normalizedPrefix(input.workspacePrefix);
  const grouping = input.grouping ?? 'plan';
  const pathPrefix = input.pathPrefix === undefined ? undefined : normalizedPrefix(input.pathPrefix);
  const commitOidsByTurn = new Map<string, string[]>();
  for (const link of input.commitLinks ?? []) {
    const existing = commitOidsByTurn.get(link.turnId) ?? [];
    existing.push(link.commitOid);
    commitOidsByTurn.set(link.turnId, existing);
  }
  const loadedTurns = [...input.turns]
    .sort((a, b) => b.turnSeq - a.turnSeq)
    .map((turn) => projectTurn(
      turn,
      workspacePrefix,
      input.previews,
      commitOidsByTurn.get(turn.id) ?? [],
    ));
  const turns = pathPrefix === undefined
    ? loadedTurns
    : loadedTurns.filter((turn) => turn.witnessedPaths.some((entry) => matchesPathPrefix(entry.repoPath, pathPrefix)));

  const windowRows: WindowUnattributedRow[] = [];
  for (const turn of loadedTurns) {
    const window = input.windowPaths?.get(turn.turnId);
    if (window === undefined) continue;
    // Window provenance is host-turn-local and ancillary is deliberately outside pathPrefix scope.
    const witnessed = new Set(turn.witnessedPaths.map((entry) => entry.repoPath));
    const paths = uniquePaths(window.paths
      .filter((repoPath) => !witnessed.has(repoPath))
      .map((repoPath) => toActivityPath(repoPath, workspacePrefix))
      .filter((entry): entry is ActivityPath => entry !== null));
    if (paths.length === 0 && !window.hasOmittedPaths) continue;
    windowRows.push({
      kind: 'window-unattributed',
      id: `win:${turn.turnId}`,
      hostTurnId: turn.turnId,
      hostTurnSeq: turn.turnSeq,
      paths,
      omittedPathCount: window.omittedPathCount,
      hasOmittedPaths: window.hasOmittedPaths,
    });
  }

  const tools = projectToolRows(
    input.fileActivities ?? [],
    input.repoRoot,
    workspacePrefix,
    input.agentTitles,
  );
  const ancillaryPaths = uniquePaths([
    ...tools.rows.flatMap((row) => row.paths),
    ...windowRows.flatMap((row) => row.paths),
  ]);
  const ancillary: ActivityAncillary = {
    toolUnjoined: tools.rows,
    windowUnattributed: windowRows,
    counts: {
      toolUnjoinedCount: tools.rows.length,
      windowUnattributedCount: windowRows.length,
      pathCount: ancillaryPaths.length,
    },
    scopedByPathPrefix: false,
  };

  const turnsComplete = input.turnsComplete === true;
  const filesComplete = input.filesComplete === true;
  const ancillaryPathsComplete = turnsComplete && filesComplete
    && windowRows.every((row) => !row.hasOmittedPaths);
  const completeness = {
    turns: turnsComplete,
    agents: grouping === 'plan' ? turnsComplete && filesComplete : turnsComplete,
    plans: turnsComplete,
    commits: turnsComplete,
    files: grouping === 'plan' ? turnsComplete && filesComplete : turnsComplete,
    ...(grouping === 'plan' ? {} : { ancillaryPaths: ancillaryPathsComplete }),
  };
  const baseScope = {
    grouping,
    filters: {
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(input.planItemId === undefined ? {} : { planItemId: input.planItemId }),
      eligibleOnly: input.eligibleOnly ?? true,
      ...(input.pathPrefix === undefined ? {} : { pathPrefix }),
    },
    completeness,
  };

  let items: ActivityItem[];
  let pageCounts: ActivityCounts;
  let scope: ActivityCountScope;

  if (grouping === 'plan') {
    const planMembers = new Map<string, TurnActivityRow[]>();
    for (const turn of turns) {
      if (turn.planId === null) continue;
      const members = planMembers.get(turn.planId) ?? [];
      members.push(turn);
      planMembers.set(turn.planId, members);
    }
    const emittedPlans = new Set<string>();
    items = [];
    for (const turn of turns) {
      if (turn.planId === null) {
        items.push(turn);
        continue;
      }
      if (emittedPlans.has(turn.planId)) continue;
      emittedPlans.add(turn.planId);
      const members = planMembers.get(turn.planId) ?? [turn];
      const exactCounts = input.pathPrefix === undefined
        ? input.exactPlanCounts?.get(turn.planId)
        : undefined;
      const group: PlanGroupRow = {
        kind: 'plan-group',
        planId: turn.planId,
        planTitle: input.planTitles?.get(turn.planId) ?? null,
        latestTurnSeq: members[0].turnSeq,
        latestStartedAt: members[0].startedAt,
        members,
        pageCounts: countTurns(members),
        countsComplete: exactCounts !== undefined || turnsComplete,
        // This cursor is older-direction paging only; it does not imply count completeness.
        nextOlderCursor: {
          turnSeq: input.turnScanExhausted === true
            ? null
            : input.nextOlderTurnSeq ?? Math.min(...members.map((member) => member.turnSeq)),
        },
        ...(exactCounts === undefined ? {} : { totalCounts: exactCounts }),
      };
      items.push(group);
    }
    items.push(...windowRows, ...tools.rows);
    const toolPaths = tools.rows.flatMap((row) => row.paths);
    pageCounts = countTurns(turns, toolPaths);
    const allAgentIds = new Set(turns.flatMap((turn) => turn.agentId === null ? [] : [turn.agentId]));
    for (const row of tools.rows) allAgentIds.add(row.agentId);
    pageCounts.agentCount = allAgentIds.size;
    scope = { ...baseScope, turnCountBasis: 'loaded-turns' };
  } else if (grouping === 'time') {
    const { timeZone, dayKey } = makeDayKeyFn(input.timeZone);
    const chronological = [...turns].sort((a, b) => {
      if (a.startedAt === null) return b.startedAt === null ? b.turnId.localeCompare(a.turnId) : 1;
      if (b.startedAt === null) return -1;
      return b.startedAt - a.startedAt || b.turnId.localeCompare(a.turnId);
    });
    const annotated = chronological.map((turn, index): TurnActivityRow => {
      const newer = chronological[index - 1];
      const gapFromNewerMs = newer?.startedAt !== null && newer?.startedAt !== undefined && turn.startedAt !== null
        ? newer.startedAt - turn.startedAt
        : null;
      return { ...turn, gapFromNewerMs, sessionBoundary: gapFromNewerMs !== null && gapFromNewerMs > SESSION_GAP_MS };
    });
    const buckets = new Map<string | null, TurnActivityRow[]>();
    for (const turn of annotated) {
      const key = turn.startedAt === null ? null : dayKey(turn.startedAt);
      const members = buckets.get(key) ?? [];
      members.push(turn);
      buckets.set(key, members);
    }
    const groups = [...buckets.entries()].map(([key, members]): DayGroupRow => ({
      kind: 'day-group',
      dayKey: key,
      timeZone,
      latestStartedAt: members[0].startedAt,
      gapFromNewerGroupMs: null,
      members,
      pageCounts: countTurns(members),
    })).sort((a, b) => {
      if (a.latestStartedAt === null) return b.latestStartedAt === null ? 0 : 1;
      if (b.latestStartedAt === null) return -1;
      return b.latestStartedAt - a.latestStartedAt;
    });
    for (let index = 1; index < groups.length; index += 1) {
      const newer = groups[index - 1];
      const older = groups[index];
      if (older.latestStartedAt === null) continue;
      const newerTimes = newer.members.flatMap((member) => member.startedAt === null ? [] : [member.startedAt]);
      const olderTimes = older.members.flatMap((member) => member.startedAt === null ? [] : [member.startedAt]);
      if (newerTimes.length > 0 && olderTimes.length > 0) {
        older.gapFromNewerGroupMs = Math.min(...newerTimes) - Math.max(...olderTimes);
      }
    }
    items = groups;
    pageCounts = countTurns(turns);
    scope = { ...baseScope, turnCountBasis: 'loaded-turns', timeZone };
  } else if (grouping === 'file') {
    const groupsByPath = new Map<string, { displayPath: string; members: TurnActivityRow[] }>();
    for (const turn of turns) {
      const seen = new Set<string>();
      for (const activityPath of turn.witnessedPaths) {
        if (seen.has(activityPath.repoPath)) continue;
        seen.add(activityPath.repoPath);
        if (pathPrefix !== undefined && !matchesPathPrefix(activityPath.repoPath, pathPrefix)) continue;
        const group = groupsByPath.get(activityPath.repoPath) ?? { displayPath: activityPath.displayPath, members: [] };
        group.members.push(turn);
        groupsByPath.set(activityPath.repoPath, group);
      }
    }
    const groups = [...groupsByPath.entries()].map(([repoPath, group]): FileGroupRow => ({
      kind: 'file-group',
      repoPath,
      displayPath: group.displayPath,
      latestStartedAt: group.members.reduce<number | null>((latest, member) => (
        member.startedAt !== null && (latest === null || member.startedAt > latest) ? member.startedAt : latest
      ), null),
      members: group.members,
      pageCounts: withFileCount(countTurns(group.members), 1),
    })).sort((a, b) => {
      if (a.latestStartedAt === null) return b.latestStartedAt === null ? a.repoPath.localeCompare(b.repoPath) : 1;
      if (b.latestStartedAt === null) return -1;
      return b.latestStartedAt - a.latestStartedAt || a.repoPath.localeCompare(b.repoPath);
    });
    const visibleById = new Map<string, TurnActivityRow>();
    for (const group of groups) for (const member of group.members) visibleById.set(member.turnId, member);
    const visibleTurns = [...visibleById.values()];
    items = groups;
    pageCounts = withFileCount(countTurns(visibleTurns), groups.length);
    scope = {
      ...baseScope,
      turnCountBasis: 'visible-file-group-members',
      loadedTurnsExcludedFromFileGroups: loadedTurns.length - visibleTurns.length,
    };
  } else {
    items = turns;
    pageCounts = countTurns(turns);
    scope = { ...baseScope, turnCountBasis: 'loaded-turns' };
  }

  return {
    items,
    pageCounts,
    fileActivityStats: {
      scanned: input.fileActivities?.length ?? 0,
      emitted: tools.emitted,
      outsideWorkspaceCount: tools.outsideWorkspaceCount,
    },
    scope,
    ...(grouping === 'plan' ? {} : { ancillary }),
  };
}
