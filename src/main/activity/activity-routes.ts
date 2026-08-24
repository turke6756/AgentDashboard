import * as path from 'node:path';

import {
  getWorkspace,
  getWorkspaceActivityView,
  listActivityTurnRecordsThrough,
  listCommitLinksForTurns,
  listWorkspaceWriteActivitiesThrough,
  markWorkspaceActivityViewed,
  snapshotActivityBounds,
  type ActivityFileActivity,
  type ActivitySnapshot as DatabaseActivitySnapshot,
  type ActivitySourcePage,
  type TurnRecord,
} from '../database';
import type { WindowPathList } from '../git-checkpoints/checkpoint-service';
import {
  projectTurnActivity,
  type TurnPreviewAttachment,
} from './turn-projection';
import { captureHealthManager } from './capture-health';
import type {
  ActivityBefore,
  ActivityDigest,
  ActivityHeartbeatSnapshot,
  ActivityListRequest,
  ActivityMarkViewedRequest,
  ActivityPage,
  ActivityPageCountsEvent,
  ActivitySnapshot,
  ActivityUndoSafety,
  ActivityUndoUpdatedEvent,
  ActivityViewedResult,
  CheckpointPreviewResult,
} from '../../shared/types';

export const PREVIEW_CONCURRENCY = 4;
export const PREVIEW_BUDGET_MS = 1_500;
export const PREVIEW_IPC_BUDGET_MS = 8_000;
export const ACTIVITY_TURN_LIMIT_DEFAULT = 50;
export const ACTIVITY_FILE_LIMIT_DEFAULT = 200;

export type ActivityPushEvent =
  | { channel: 'activity:undo-updated'; payload: ActivityUndoUpdatedEvent }
  | { channel: 'activity:page-counts'; payload: ActivityPageCountsEvent };

export interface ActivityWorkspaceContext {
  repoRoot: string;
  workspacePrefix: string;
  repositoryKey?: string;
}

export interface ActivityRouteDeps {
  now?: () => number;
  snapshot?: (workspaceId: string, now?: () => number) => DatabaseActivitySnapshot;
  listTurns?: (
    workspaceId: string,
    opts: Parameters<typeof listActivityTurnRecordsThrough>[1],
  ) => ActivitySourcePage<TurnRecord>;
  listFileActivities?: (
    workspaceId: string,
    opts: Parameters<typeof listWorkspaceWriteActivitiesThrough>[1],
  ) => ActivitySourcePage<ActivityFileActivity>;
  markViewed?: typeof markWorkspaceActivityViewed;
  getViewed?: typeof getWorkspaceActivityView;
  heartbeat?: (workspaceId: string) => ActivityHeartbeatSnapshot;
  resolveWorkspace?: (workspaceId: string) => ActivityWorkspaceContext | null;
  previewRestore?: (workspaceId: string, turnId: string) => Promise<CheckpointPreviewResult>;
  listWindowPaths?: (
    workspaceId: string,
    turnId: string,
    repoRoot: string,
  ) => Promise<WindowPathList>;
  listCommitLinks?: typeof listCommitLinksForTurns;
  resolvePlanTitles?: (planIds: string[]) => ReadonlyMap<string, string | null>;
  resolveAgentTitles?: (agentIds: string[]) => ReadonlyMap<string, string | null>;
}

function distinctIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function unavailablePreview(reason: string): TurnPreviewAttachment {
  return { unavailable: true, reason };
}

function turnRows(page: ActivityPage): Array<{ turnId: string; undo: ActivityUndoSafety }> {
  const rows: Array<{ turnId: string; undo: ActivityUndoSafety }> = [];
  for (const item of page.items) {
    if (item.kind === 'turn') rows.push(item);
    if (item.kind === 'plan-group') rows.push(...item.members);
    if (item.kind === 'day-group') rows.push(...item.members);
    if (item.kind === 'file-group') rows.push(...item.members);
  }
  return rows;
}

function canonicalRepoPath(value: string): string | null {
  if (path.win32.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/')).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')
      || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function previewFromUndo(turnId: string, undo: ActivityUndoSafety): TurnPreviewAttachment | undefined {
  if (undo.basis !== 'preview') return undefined;
  if (undo.state === 'unavailable') return unavailablePreview(undo.reason ?? 'preview-unavailable');
  return {
    available: undo.state === 'restorable',
    reason: undo.reason,
    turnId,
    witnessedSet: [],
    tokens: {},
    validatedPaths: [],
    rejectedPaths: [],
    contention: undo.contention,
    ...(undo.overlap === undefined ? {} : { overlap: undo.overlap }),
  };
}

function normalizedBefore(before: ActivityBefore | undefined): ActivityBefore {
  return before ?? {
    turns: { before: null, exhausted: false },
    fileActivities: { before: null, exhausted: false },
  };
}

function requirePositiveLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Object.assign(new Error(`limit must be an integer in [1,${max}]`), {
      statusCode: 400,
      code: 'activity-bad-request',
    });
  }
  return value;
}

export class ActivityRoutes {
  private readonly deps: Required<Pick<ActivityRouteDeps,
    'now' | 'snapshot' | 'listTurns' | 'listFileActivities' | 'markViewed' | 'getViewed' | 'heartbeat'
    | 'resolveWorkspace' | 'listCommitLinks'>> & ActivityRouteDeps;
  private generations = new Map<string, number>();

  constructor(deps: ActivityRouteDeps = {}) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      snapshot: deps.snapshot ?? snapshotActivityBounds,
      listTurns: deps.listTurns ?? listActivityTurnRecordsThrough,
      listFileActivities: deps.listFileActivities ?? listWorkspaceWriteActivitiesThrough,
      markViewed: deps.markViewed ?? markWorkspaceActivityViewed,
      getViewed: deps.getViewed ?? getWorkspaceActivityView,
      heartbeat: deps.heartbeat ?? ((workspaceId) => captureHealthManager.snapshot(workspaceId)),
      resolveWorkspace: deps.resolveWorkspace ?? ((workspaceId) => {
        const workspace = getWorkspace(workspaceId);
        if (!workspace) return null;
        const cap = captureHealthManager.capabilityObservation(workspaceId)?.cap;
        return {
          repoRoot: cap?.repoRoot ?? workspace.path,
          workspacePrefix: cap?.workspacePrefix ?? '',
        };
      }),
      listCommitLinks: deps.listCommitLinks ?? listCommitLinksForTurns,
    };
  }

  cancel(workspaceId: string): void {
    this.generations.set(workspaceId, (this.generations.get(workspaceId) ?? 0) + 1);
  }

  heartbeat(workspaceId: string): ActivityHeartbeatSnapshot {
    // Deliberately read-only: the manager-owned beat is advanced only by its timer.
    return this.deps.heartbeat(workspaceId);
  }

  markViewed(request: ActivityMarkViewedRequest): ActivityViewedResult {
    const snapshot = request.snapshot;
    if (!snapshot || !Number.isSafeInteger(snapshot.throughTurnSeq)
        || !Number.isSafeInteger(snapshot.throughFileActivityId)
        || !Number.isSafeInteger(snapshot.capturedAt)
        || snapshot.throughTurnSeq < 0 || snapshot.throughFileActivityId < 0
        || snapshot.capturedAt < 0) {
      throw Object.assign(new Error('a valid activity snapshot is required'), {
        statusCode: 400,
        code: 'activity-bad-request',
      });
    }
    const row = this.deps.markViewed(request.workspaceId, {
      throughTurnSeq: snapshot.throughTurnSeq,
      throughFileActivityId: snapshot.throughFileActivityId,
    }, this.deps.now());
    if (!row) {
      throw Object.assign(new Error(`workspace '${request.workspaceId}' was not found`), {
        statusCode: 404,
        code: 'activity-workspace-not-found',
      });
    }
    return { workspaceId: request.workspaceId, ...row };
  }

  async list(
    request: ActivityListRequest,
    emit?: (event: ActivityPushEvent) => void,
  ): Promise<ActivityPage> {
    return this.buildPage(request, emit);
  }

  async digest(request: ActivityListRequest): Promise<ActivityDigest> {
    // Digest is a stable watermark summary, not an interactive lens. Keep the
    // sibling list-only projection controls out of both its page and since-counts.
    const { grouping: _grouping, pathPrefix: _pathPrefix, timeZone: _timeZone, ...digestRequest } = request;
    const page = await this.buildPage({ ...digestRequest, preview: 'sync' });
    const viewed = request.since ? null : this.deps.getViewed(request.workspaceId);
    const since = request.since ?? (viewed ? {
      turnSeq: viewed.turnSeq,
      fileActivityId: viewed.fileActivityId,
    } : undefined);
    let sinceCounts = page.pageCounts;
    if (since) {
      const context = this.requireWorkspaceContext(request.workspaceId);
      const source = await this.readSources({
        ...request,
        preview: 'none',
        before: undefined,
        snapshot: page.cursor.snapshot,
      });
      const completedPreviews = new Map<string, TurnPreviewAttachment>();
      for (const row of turnRows(page)) {
        const attachment = previewFromUndo(row.turnId, row.undo);
        if (attachment) completedPreviews.set(row.turnId, attachment);
      }
      const projection = projectTurnActivity({
        turns: source.turns.rows.filter((row) => row.turnSeq > since.turnSeq),
        fileActivities: source.fileActivities.rows.filter((row) => row.id > since.fileActivityId),
        repoRoot: context.repoRoot,
        workspacePrefix: context.workspacePrefix,
        previews: completedPreviews,
        planTitles: this.deps.resolvePlanTitles?.(distinctIds(
          source.turns.rows.filter((row) => row.turnSeq > since.turnSeq).map((row) => row.planId),
        )),
        agentTitles: this.deps.resolveAgentTitles?.(distinctIds([
          ...source.turns.rows.filter((row) => row.turnSeq > since.turnSeq).map((row) => row.agentId),
          ...source.fileActivities.rows.filter((row) => row.id > since.fileActivityId).map((row) => row.agentId),
        ])),
      });
      sinceCounts = projection.pageCounts;
    }
    return { page, sinceCounts, heartbeat: this.heartbeat(request.workspaceId) };
  }

  private requireWorkspaceContext(workspaceId: string): ActivityWorkspaceContext {
    const context = this.deps.resolveWorkspace(workspaceId);
    if (!context) {
      throw Object.assign(new Error(`workspace '${workspaceId}' was not found`), {
        statusCode: 404,
        code: 'activity-workspace-not-found',
      });
    }
    return context;
  }

  private async readSources(request: ActivityListRequest): Promise<{
    snapshot: ActivitySnapshot;
    turns: ActivitySourcePage<TurnRecord>;
    fileActivities: ActivitySourcePage<ActivityFileActivity>;
    turnLimit: number;
    fileLimit: number;
  }> {
    const turnLimit = requirePositiveLimit(request.limit, ACTIVITY_TURN_LIMIT_DEFAULT, 200);
    const fileLimit = requirePositiveLimit(request.fileActivityLimit, ACTIVITY_FILE_LIMIT_DEFAULT, 10_000);
    // Initial requests capture both ceilings before either source is selected.
    const snapshot = request.snapshot ?? this.deps.snapshot(request.workspaceId, this.deps.now);
    const before = normalizedBefore(request.before);
    const turns = this.deps.listTurns(request.workspaceId, {
      throughTurnSeq: snapshot.throughTurnSeq,
      before: before.turns.before,
      exhausted: before.turns.exhausted,
      limit: turnLimit,
      agentId: request.agentId,
      planId: request.planId,
      planItemId: request.planItemId,
      eligibleOnly: request.eligibleOnly ?? true,
    });
    const fileActivities = this.deps.listFileActivities(request.workspaceId, {
      throughFileActivityId: snapshot.throughFileActivityId,
      throughTurnSeq: snapshot.throughTurnSeq,
      snapshotCapturedAt: snapshot.capturedAt,
      before: before.fileActivities.before,
      exhausted: before.fileActivities.exhausted,
      limit: fileLimit,
    });
    return { snapshot, turns, fileActivities, turnLimit, fileLimit };
  }

  private async buildPage(
    request: ActivityListRequest,
    emit?: (event: ActivityPushEvent) => void,
  ): Promise<ActivityPage> {
    if (!request.workspaceId) {
      throw Object.assign(new Error('a non-empty workspaceId is required'), {
        statusCode: 400,
        code: 'activity-bad-request',
      });
    }
    let canonicalPrefix: string | undefined;
    if (request.pathPrefix !== undefined) {
      const candidate = canonicalRepoPath(request.pathPrefix);
      if (candidate === null) {
        throw Object.assign(new Error('pathPrefix must be a workspace-relative path'), {
          statusCode: 400,
          code: 'activity-bad-request',
        });
      }
      canonicalPrefix = candidate;
    }
    const context = this.requireWorkspaceContext(request.workspaceId);
    const source = await this.readSources(request);
    const turnsFirstPage = (request.before?.turns?.before ?? null) === null;
    const filesFirstPage = (request.before?.fileActivities?.before ?? null) === null;
    const turnsComplete = turnsFirstPage && source.turns.exhausted;
    const filesComplete = filesFirstPage && source.fileActivities.exhausted;
    const generation = (this.generations.get(request.workspaceId) ?? 0) + 1;
    this.generations.set(request.workspaceId, generation);

    const turnIds = source.turns.rows.map((row) => row.id);
    const commitLinks = context.repositoryKey && turnIds.length > 0
      ? this.deps.listCommitLinks(context.repositoryKey, turnIds)
      : [];
    const windowPaths = new Map<string, WindowPathList>();
    if (this.deps.listWindowPaths) {
      await Promise.all(source.turns.rows.map(async (row) => {
        try {
          windowPaths.set(row.id, await this.deps.listWindowPaths!(
            request.workspaceId,
            row.id,
            context.repoRoot,
          ));
        } catch { /* omission remains honest: no window row is fabricated */ }
      }));
    }

    const previews = new Map<string, TurnPreviewAttachment>();
    const previewMode = request.preview ?? 'none';
    const candidates = source.turns.rows.filter((row) => row.status === 'open' || (
      row.beforeReady && row.afterReady && row.beforePrunedAt === null && row.afterPrunedAt === null
    ));
    if (previewMode === 'sync') {
      await this.walkPreviews(
        request.workspaceId,
        generation,
        candidates,
        PREVIEW_BUDGET_MS,
        previews,
      );
    }

    const render = (): ActivityPage => {
      const planTitles = this.deps.resolvePlanTitles?.(distinctIds(source.turns.rows.map((row) => row.planId)));
      const agentTitles = this.deps.resolveAgentTitles?.(distinctIds([
        ...source.turns.rows.map((row) => row.agentId),
        ...source.fileActivities.rows.map((row) => row.agentId),
      ]));
      const projection = projectTurnActivity({
        turns: source.turns.rows,
        fileActivities: source.fileActivities.rows,
        repoRoot: context.repoRoot,
        workspacePrefix: context.workspacePrefix,
        previews,
        windowPaths,
        commitLinks,
        planTitles,
        agentTitles,
        turnScanExhausted: source.turns.exhausted,
        turnsComplete,
        filesComplete,
        nextOlderTurnSeq: source.turns.before,
        grouping: request.grouping,
        pathPrefix: canonicalPrefix,
        timeZone: request.timeZone,
        agentId: request.agentId,
        planId: request.planId,
        planItemId: request.planItemId,
        eligibleOnly: request.eligibleOnly ?? true,
      });
      const nextOlder = source.turns.exhausted && source.fileActivities.exhausted
        ? null
        : {
            turns: { before: source.turns.before, exhausted: source.turns.exhausted },
            fileActivities: {
              before: source.fileActivities.before,
              exhausted: source.fileActivities.exhausted,
            },
          };
      return {
        workspaceId: request.workspaceId,
        items: projection.items,
        cursor: { snapshot: source.snapshot, nextOlder },
        pageCounts: projection.pageCounts,
        scope: projection.scope,
        ...(projection.ancillary === undefined ? {} : { ancillary: projection.ancillary }),
        scans: {
          turns: {
            scanned: source.turns.scanned,
            emitted: source.turns.rows.length,
            exhausted: source.turns.exhausted,
            limit: source.turnLimit,
          },
          fileActivities: {
            scanned: source.fileActivities.scanned,
            emitted: projection.fileActivityStats.emitted,
            exhausted: source.fileActivities.exhausted,
            limit: source.fileLimit,
            outsideWorkspaceCount: projection.fileActivityStats.outsideWorkspaceCount,
          },
        },
      };
    };

    const page = render();
    if (previewMode === 'none' && candidates.length > 0 && emit) {
      void this.walkPreviews(
        request.workspaceId,
        generation,
        candidates,
        PREVIEW_IPC_BUDGET_MS,
        previews,
        (turnId) => {
          const current = render();
          const undo = turnRows(current).find((row) => row.turnId === turnId)?.undo;
          if (undo) emit({
            channel: 'activity:undo-updated',
            payload: { workspaceId: request.workspaceId, turnId, undo },
          });
        },
      ).then(() => {
        if (this.generations.get(request.workspaceId) !== generation) return;
        emit({
          channel: 'activity:page-counts',
          payload: {
            workspaceId: request.workspaceId,
            snapshot: source.snapshot,
            pageCounts: render().pageCounts,
          },
        });
      });
    }
    return page;
  }

  private async walkPreviews(
    workspaceId: string,
    generation: number,
    turns: readonly TurnRecord[],
    budgetMs: number,
    out: Map<string, TurnPreviewAttachment>,
    onResult?: (turnId: string) => void,
  ): Promise<void> {
    const deadline = this.deps.now() + budgetMs;
    let cursor = 0;
    let accepting = true;
    const worker = async (): Promise<void> => {
      while (accepting && cursor < turns.length) {
        if (this.deps.now() >= deadline) return;
        const row = turns[cursor++];
        let preview: TurnPreviewAttachment;
        try {
          preview = this.deps.previewRestore
            ? await this.deps.previewRestore(workspaceId, row.id)
            : unavailablePreview('checkpoint-engine-unavailable');
        } catch (err) {
          preview = unavailablePreview(err instanceof Error ? err.message : 'preview-failed');
        }
        if (!accepting || this.deps.now() > deadline
            || this.generations.get(workspaceId) !== generation) continue;
        out.set(row.id, preview);
        onResult?.(row.id);
      }
    };
    const workers = Array.from(
      { length: Math.min(PREVIEW_CONCURRENCY, turns.length) },
      () => worker(),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(workers),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
    accepting = false;
    if (timer) clearTimeout(timer);
  }
}

/** Production registration factory used by both HTTP and renderer IPC seams. */
export function registerActivityRoutes(deps: ActivityRouteDeps = {}): ActivityRoutes {
  return new ActivityRoutes(deps);
}
