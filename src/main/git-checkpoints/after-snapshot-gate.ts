import type { LstatInfo } from './checkpoint-gating';
import type { CheckpointTurnStore } from './checkpoint-service';
import { encodeGitPath } from '../commit-candidates/dirty-inventory';
import {
  resolveCheckpointPathEntry,
  type ConcurrencyRunGit,
} from './concurrency-policy';

export type AfterSnapshotEntry =
  | { kind: 'absent' }
  | { kind: 'regular'; oid: string }
  | { kind: 'symlink'; oid: string };

export type CurrentWorktreeEntry =
  | AfterSnapshotEntry
  | { kind: 'directory' };

export type AfterSnapshotBlocker =
  | {
      kind: 'later-turn';
      turnId: string;
      turnSeq: number;
      agentId: string | null;
      agentTitle: string | null;
      taskLabel: string | null;
      status: string;
      endedAt: number | null;
    }
  | { kind: 'external' };

export interface AfterSnapshotOverlap {
  reason: 'after-snapshot-overlap' | 'after-edge-unusable';
  files: Array<{ path: string; blockers: AfterSnapshotBlocker[] }>;
}

export type AfterSnapshotGateResult =
  | { ok: true }
  | {
      ok: false;
      failureReason: 'after-snapshot-overlap';
      overlap: AfterSnapshotOverlap & { reason: 'after-snapshot-overlap' };
    }
  | {
      ok: false;
      failureReason: 'after-edge-unusable';
      overlap: AfterSnapshotOverlap & { reason: 'after-edge-unusable'; files: [] };
    }
  | { ok: false; failureReason: 'current-hash-failed' };

export type AfterSnapshotTurnStore = Pick<
  CheckpointTurnStore,
  'listLaterTurnsWitnessingPath'
>;

export interface CheckAfterSnapshotInput {
  repoRoot: string;
  gitExe: string;
  workspaceId: string;
  turnId: string;
  turnSeq: number;
  afterOid: string | null;
  afterEdgeUsable: boolean;
  paths: readonly string[];
  store: AfterSnapshotTurnStore;
  runGit: ConcurrencyRunGit;
  /** Reads a validated repo-relative path from the current worktree. */
  lstatPath(path: string): LstatInfo | null;
  /** Raw-hashes present regular files and symlinks, keyed by repo-relative path. */
  hashPaths(paths: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export function afterSnapshotEntriesMatch(
  after: AfterSnapshotEntry,
  current: CurrentWorktreeEntry,
): boolean {
  if (after.kind === 'absent' || current.kind === 'absent') {
    return after.kind === 'absent' && current.kind === 'absent';
  }
  if (current.kind === 'directory') return false;
  return after.kind === current.kind && after.oid === current.oid;
}

function afterEdgeUnusable(): AfterSnapshotGateResult {
  return {
    ok: false,
    failureReason: 'after-edge-unusable',
    overlap: { reason: 'after-edge-unusable', files: [] },
  };
}

/** Compare every validated restore path with the target turn's after-image.
 * The helper is read-only apart from `hash-object -w`, matching the existing
 * preview/PRE hashing seam. Later-turn rows are attribution only: equality is
 * decided exclusively by current versus after kind + OID. */
export async function checkAfterSnapshot(
  input: CheckAfterSnapshotInput,
): Promise<AfterSnapshotGateResult> {
  if (!input.afterEdgeUsable || !input.afterOid) return afterEdgeUnusable();

  const paths = [...new Set(input.paths)];
  const afterByPath = new Map<string, AfterSnapshotEntry>();
  try {
    for (const path of paths) {
      const encoded = encodeGitPath(Buffer.from(path, 'utf8'));
      if (!encoded.utf8Clean) return afterEdgeUnusable();
      const resolved = await resolveCheckpointPathEntry({
        repoRoot: input.repoRoot,
        gitExe: input.gitExe,
        commitOid: input.afterOid,
        path: encoded,
        runGit: input.runGit,
      });
      if (resolved.kind === 'unusable') return afterEdgeUnusable();
      if (resolved.kind === 'absent') {
        afterByPath.set(path, { kind: 'absent' });
      } else if (resolved.mode === '100644' || resolved.mode === '100755') {
        afterByPath.set(path, { kind: 'regular', oid: resolved.oid });
      } else if (resolved.mode === '120000') {
        afterByPath.set(path, { kind: 'symlink', oid: resolved.oid });
      } else {
        return afterEdgeUnusable();
      }
    }
  } catch {
    return afterEdgeUnusable();
  }

  const currentByPath = new Map<string, CurrentWorktreeEntry>();
  const statByPath = new Map<string, LstatInfo>();
  const present: string[] = [];
  try {
    for (const path of paths) {
      const stat = input.lstatPath(path);
      if (stat === null) currentByPath.set(path, { kind: 'absent' });
      else if (stat.isDirectory) currentByPath.set(path, { kind: 'directory' });
      else if (stat.isSymbolicLink || stat.isFile) {
        statByPath.set(path, stat);
        present.push(path);
      }
      else return { ok: false, failureReason: 'current-hash-failed' };
    }

    const oidByPath = await input.hashPaths(present);
    for (const path of present) {
      const oid = oidByPath.get(path);
      if (!oid) return { ok: false, failureReason: 'current-hash-failed' };
      const stat = statByPath.get(path)!;
      currentByPath.set(path, {
        kind: stat.isSymbolicLink ? 'symlink' : 'regular',
        oid,
      });
    }
  } catch {
    return { ok: false, failureReason: 'current-hash-failed' };
  }

  const files: Array<{ path: string; blockers: AfterSnapshotBlocker[] }> = [];
  for (const path of paths) {
    const after = afterByPath.get(path);
    const current = currentByPath.get(path);
    if (!after || !current) return { ok: false, failureReason: 'current-hash-failed' };
    if (afterSnapshotEntriesMatch(after, current)) continue;

    const seen = new Set<string>();
    const blockers: AfterSnapshotBlocker[] = [];
    for (const turn of input.store.listLaterTurnsWitnessingPath(
      input.workspaceId,
      input.turnSeq,
      path,
    )) {
      if (turn.id === input.turnId || seen.has(turn.id)) continue;
      seen.add(turn.id);
      blockers.push({
        kind: 'later-turn',
        turnId: turn.id,
        turnSeq: turn.turnSeq,
        agentId: turn.agentId,
        agentTitle: turn.agentTitle,
        taskLabel: turn.taskLabel,
        status: turn.status,
        endedAt: turn.endedAt,
      });
    }
    files.push({ path, blockers: blockers.length > 0 ? blockers : [{ kind: 'external' }] });
  }

  if (files.length === 0) return { ok: true };
  return {
    ok: false,
    failureReason: 'after-snapshot-overlap',
    overlap: { reason: 'after-snapshot-overlap', files },
  };
}
