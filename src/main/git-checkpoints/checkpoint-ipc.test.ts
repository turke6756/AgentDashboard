// WP-G2.2 (plans/git-native-implementation-v2.md — "IPC for the human renderer") —
// the human checkpoint IPC registrar + the Open #4 force gate.
//
// Load-bearing properties, exercised against the REAL registrar over a fake
// ipcMain + a fake HumanCheckpointRoutes:
//   - the five channels are registered and delegate workspace-scoped;
//   - a human `force` is REFUSED while an active turn witnesses a requested path
//     (contention non-empty) — no mutation reaches the engine;
//   - a `force` is ACCEPTED once the turn is closed (contention empty) and is the
//     ONLY thing that overrides a stale preview-token conflict (a non-force restore
//     against a stale token fails);
//   - inputs are validated (missing workspace/turn/paths), and an unwired engine
//     answers an honest "unavailable" instead of a silent empty result.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/checkpoint-ipc.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  registerCheckpointIpc,
  createCheckpointRecoverySurface,
  FORCE_REFUSED_ACTIVE_TURN,
  type HumanCheckpointRoutes,
  type IpcLike,
} from './checkpoint-ipc';
import {
  CheckpointService,
  MERGE_UNDO_PREVIEW_TTL_MS,
  MergeUndoPreviewRegistry,
  type MergeUndoPreviewIdentity,
} from './checkpoint-service';
import { CheckpointQueue } from './checkpoint-queue';
import { createCheckpointInvokeApi } from '../../preload/index';
import { CHECKPOINT_CHANNELS } from '../../shared/types';
import type {
  CheckpointPreviewResult,
  CheckpointRestoreResult,
  GitInitResult,
} from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── a fake ipcMain that records handlers and can invoke them ─────────────────────

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h({}, ...args);
  }
}

// ── a recording fake HumanCheckpointRoutes ──────────────────────────────────────

interface FakeCfg {
  /** contention `preview` reports for the requested paths (the active-turn witness). */
  contention?: { path: string; turnId: string }[];
  /** when true, a restore/revert WITHOUT force but WITH tokens fails as a stale
   *  preview; force flips it to completed (models the service's token bypass). */
  staleTokens?: boolean;
  /** CONTENT-semantics diagnostic surfaced on the list summary. Left undefined to
   *  model the absent case; set true/false to model the wired flag. */
  rawFilterBypassed?: boolean;
  /** WP-G3.4 — the GitInitResult the fake `initRepo` returns (default: initialized). */
  initResult?: GitInitResult;
}

interface FakeState {
  calls: { method: string; args: unknown[] }[];
}

function makeRoutes(cfg: FakeCfg = {}): HumanCheckpointRoutes & { state: FakeState } {
  const state: FakeState = { calls: [] };
  const rec = (method: string, args: unknown[]): void => { state.calls.push({ method, args }); };
  const contention = cfg.contention ?? [];

  const previewOf = (turnId: string): CheckpointPreviewResult => ({
    available: true,
    reason: null,
    turnId,
    witnessedSet: ['a.txt'],
    tokens: { 'a.txt': 'oid-at-preview' },
    validatedPaths: ['a.txt'],
    rejectedPaths: [],
    contention,
  });

  const outcome = (
    kind: 'restore_paths' | 'revert_turn',
    paths: string[],
    force: boolean | undefined,
  ): CheckpointRestoreResult => {
    // Stale token + NOT force → the service would abort on the mismatch.
    const staleFail = cfg.staleTokens === true && force !== true;
    return staleFail
      ? {
          status: 'failed', operationId: '', kind, preRef: null, preOid: null,
          requestedPaths: paths, completedPaths: [], rejectedPaths: [], failures: [],
          contention: [], failureReason: 'preview-token-mismatch',
        }
      : {
          status: 'completed', operationId: 'op1', kind, preRef: 'r', preOid: 'o',
          requestedPaths: paths, completedPaths: paths, rejectedPaths: [], failures: [],
          contention: [], failureReason: null,
        };
  };

  const routes: HumanCheckpointRoutes = {
    list: async (workspaceId, opts) => {
      rec('list', [workspaceId, opts]);
      return {
        workspaceId,
        turns: [{
          turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
          status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
          beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['a.txt'], failureReason: null,
          ...(cfg.rawFilterBypassed === undefined ? {} : { beforeRawFilterBypassed: cfg.rawFilterBypassed }),
        }],
      };
    },
    fileHistory: async (workspaceId, filePath, opts) => {
      rec('fileHistory', [workspaceId, filePath, opts]);
      return {
        workspaceId, path: filePath,
        versions: [{
          turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'A', taskLabel: 'task',
          status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
          beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPath: filePath, op: 'write' as const,
          afterVerified: true, beforeRawFilterBypassed: false,
        }],
      };
    },
    diff: async (workspaceId, turnId) => {
      rec('diff', [workspaceId, turnId]);
      return {
        workspaceId, turnId,
        witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'W', provenance: 'witnessed' },
        window: { available: true, reason: null, label: 'unattributed changes in this window', text: 'R', provenance: 'raw-window' },
      };
    },
    preview: async (workspaceId, turnId, paths, strategy) => {
      rec('preview', [workspaceId, turnId, paths, strategy]);
      return { ...previewOf(turnId), strategy: strategy ?? 'exact' };
    },
    restore: async (args) => {
      rec('restore', [args]);
      return outcome('restore_paths', args.paths, args.force);
    },
    revert: async (args) => {
      rec('revert', [args]);
      return outcome('revert_turn', ['a.txt'], args.force);
    },
    initRepo: async (workspaceId) => {
      rec('initRepo', [workspaceId]);
      return cfg.initResult ?? {
        ok: true,
        status: 'initialized',
        message: 'Created a Git repository at the workspace root.',
      };
    },
    prune: async (workspaceId) => {
      rec('prune', [workspaceId]);
      return { workspaceId, deletedRefs: 7 };
    },
    repoWidePurgePlan: async (workspaceId) => {
      rec('repoWidePurgePlan', [workspaceId]);
      return {
        repoRoot: '/repo', totalRefs: 10,
        affectedWorkspaces: [
          { workspaceId, workspaceTitle: 'Mine', workspacePath: '/repo/mine', known: true, refCount: 6 },
          { workspaceId: 'ws-other', workspaceTitle: 'Other', workspacePath: '/repo/other', known: true, refCount: 4 },
        ],
        undecodableRefCount: 0, executed: false, deletedRefs: 0,
      };
    },
    repoWidePurge: async ({ workspaceId, confirm }) => {
      rec('repoWidePurge', [{ workspaceId, confirm }]);
      const plan = {
        repoRoot: '/repo', totalRefs: 10,
        affectedWorkspaces: [
          { workspaceId, workspaceTitle: 'Mine', workspacePath: '/repo/mine', known: true, refCount: 6 },
          { workspaceId: 'ws-other', workspaceTitle: 'Other', workspacePath: '/repo/other', known: true, refCount: 4 },
        ],
        undecodableRefCount: 0, executed: false, deletedRefs: 0,
      };
      return confirm ? { ...plan, executed: true, deletedRefs: 10 } : plan;
    },
  };
  return Object.assign(routes, { state });
}

function wire(cfg: FakeCfg = {}): { ipc: FakeIpc; routes: ReturnType<typeof makeRoutes> } {
  const routes = makeRoutes(cfg);
  const ipc = new FakeIpc();
  registerCheckpointIpc(ipc, () => routes);
  return { ipc, routes };
}

// ── 1. Registration + workspace-scoped delegation ───────────────────────────────

test('registers every checkpoint channel', () => {
  const { ipc } = wire();
  for (const ch of Object.values(CHECKPOINT_CHANNELS)) {
    assert.ok(ipc.handlers.has(ch), `missing handler for ${ch}`);
  }
});

test('list/diff/preview delegate with the workspace + turn, scoped', async () => {
  const { ipc, routes } = wire();
  const list = await ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1', { agentId: 'a1' }) as { workspaceId: string; turns: unknown[] };
  assert.equal(list.workspaceId, 'ws-1');
  assert.equal(list.turns.length, 1);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'list', args: ['ws-1', { agentId: 'a1' }] });

  await ipc.invoke(CHECKPOINT_CHANNELS.diff, 'ws-1', 't1');
  assert.deepEqual(routes.state.calls.at(-1), { method: 'diff', args: ['ws-1', 't1'] });

  await ipc.invoke(CHECKPOINT_CHANNELS.preview, 'ws-1', 't1', ['a.txt']);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'preview', args: ['ws-1', 't1', ['a.txt'], 'exact'] });
});

test('file-history delegates workspace-scoped with the canonical path + optional agent filter', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.fileHistory, 'ws-1', 'src/a.txt', { agentId: 'a1' }) as {
    workspaceId: string; path: string; versions: unknown[];
  };
  assert.equal(res.workspaceId, 'ws-1');
  assert.equal(res.path, 'src/a.txt');
  assert.equal(res.versions.length, 1);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'fileHistory', args: ['ws-1', 'src/a.txt', { agentId: 'a1' }] });

  // A missing path is rejected before any engine call.
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.fileHistory, 'ws-1', ''), /path/);
});

// ── 1b. beforeRawFilterBypassed rides the list summary to the renderer ───────────
// The CONTENT-semantics diagnostic must survive the IPC list contract so
// RestoreDialog can warn on filter-managed (LFS/git-crypt) paths.

test('list summary carries beforeRawFilterBypassed=true through the IPC contract', async () => {
  const { ipc } = wire({ rawFilterBypassed: true });
  const list = await ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(list.turns[0].beforeRawFilterBypassed, true);
});

test('list summary carries beforeRawFilterBypassed=false / absent through the IPC contract', async () => {
  const falseCase = await wire({ rawFilterBypassed: false }).ipc
    .invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(falseCase.turns[0].beforeRawFilterBypassed, false);

  const absentCase = await wire().ipc
    .invoke(CHECKPOINT_CHANNELS.list, 'ws-1') as { turns: { beforeRawFilterBypassed?: boolean }[] };
  assert.equal(absentCase.turns[0].beforeRawFilterBypassed, undefined);
});

// ── 2. Input validation ─────────────────────────────────────────────────────────

test('missing workspaceId / turnId / paths are rejected before any engine call', async () => {
  const { ipc, routes } = wire();
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.list, ''), /workspaceId/);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.diff, 'ws-1', ''), /turnId/);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.restore, { workspaceId: 'ws-1', turnId: 't1', paths: [] }), /paths/);
  // None of those reached the engine.
  assert.equal(routes.state.calls.length, 0);
});

test('an unwired engine answers "unavailable", never a silent empty result', async () => {
  const ipc = new FakeIpc();
  registerCheckpointIpc(ipc, () => null);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.list, 'ws-1'), /unavailable|bootstrapping/i);
});

// ── 2b. WP-G3.4: the `git init` consent channel (human IPC only) ─────────────────

test('gitInit delegates the workspace to initRepo and returns the result verbatim', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.gitInit, 'ws-1') as GitInitResult;
  assert.equal(res.ok, true);
  assert.equal(res.status, 'initialized');
  assert.deepEqual(routes.state.calls.at(-1), { method: 'initRepo', args: ['ws-1'] });
});

test('gitInit surfaces an already-repo refusal honestly (no ok)', async () => {
  const { ipc } = wire({
    initResult: { ok: false, status: 'already-repo', message: 'already a Git repository' },
  });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.gitInit, 'ws-1') as GitInitResult;
  assert.equal(res.ok, false);
  assert.equal(res.status, 'already-repo');
});

test('gitInit rejects a missing workspaceId before any engine call', async () => {
  const { ipc, routes } = wire();
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.gitInit, ''), /workspaceId/);
  assert.equal(routes.state.calls.length, 0);
});

test('gitInit on an unwired engine answers "unavailable" (no usable git ⇒ cannot init)', async () => {
  const ipc = new FakeIpc();
  registerCheckpointIpc(ipc, () => null);
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.gitInit, 'ws-1'), /unavailable|bootstrapping/i);
});

// ── 2c. WP-G3.5: prune + the human-only repo-wide purge ──────────────────────────

test('prune delegates the workspace and returns the deleted-ref count', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.prune, 'ws-1') as { workspaceId: string; deletedRefs: number };
  assert.equal(res.workspaceId, 'ws-1');
  assert.equal(res.deletedRefs, 7);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'prune', args: ['ws-1'] });
});

test('prune rejects a missing workspaceId before any engine call', async () => {
  const { ipc, routes } = wire();
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.prune, ''), /workspaceId/);
  assert.equal(routes.state.calls.length, 0);
});

test('repo-wide purge PLAN names every affected workspace and deletes nothing', async () => {
  const { ipc, routes } = wire();
  const plan = await ipc.invoke(CHECKPOINT_CHANNELS.pruneRepoWidePlan, 'ws-1') as {
    affectedWorkspaces: { workspaceId: string; workspaceTitle: string | null }[]; executed: boolean; deletedRefs: number;
  };
  assert.equal(plan.executed, false);
  assert.equal(plan.deletedRefs, 0);
  assert.deepEqual(plan.affectedWorkspaces.map((w) => w.workspaceId), ['ws-1', 'ws-other'],
    'both workspaces in the shared repo are named BEFORE acting');
  assert.deepEqual(routes.state.calls.at(-1), { method: 'repoWidePurgePlan', args: ['ws-1'] });
});

test('repo-wide purge WITHOUT confirm returns the plan unexecuted (no silent purge)', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.pruneRepoWide, { workspaceId: 'ws-1' }) as {
    executed: boolean; deletedRefs: number;
  };
  assert.equal(res.executed, false);
  assert.equal(res.deletedRefs, 0);
  // confirm is normalized to false (absent → false).
  assert.deepEqual(routes.state.calls.at(-1), { method: 'repoWidePurge', args: [{ workspaceId: 'ws-1', confirm: false }] });
});

test('repo-wide purge WITH confirm:true executes and reports the deleted count', async () => {
  const { ipc, routes } = wire();
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.pruneRepoWide, { workspaceId: 'ws-1', confirm: true }) as {
    executed: boolean; deletedRefs: number;
  };
  assert.equal(res.executed, true);
  assert.equal(res.deletedRefs, 10);
  assert.deepEqual(routes.state.calls.at(-1), { method: 'repoWidePurge', args: [{ workspaceId: 'ws-1', confirm: true }] });
});

test('repo-wide purge rejects a missing workspaceId before any engine call', async () => {
  const { ipc, routes } = wire();
  await assert.rejects(() => ipc.invoke(CHECKPOINT_CHANNELS.pruneRepoWide, { confirm: true }), /workspaceId/);
  assert.equal(routes.state.calls.length, 0);
});

// ── 3. Non-force restore skips only the IPC force preflight ──────────────────────

test('a non-force restore skips the IPC force preflight and delegates to the authoritative service gate', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'other' }] });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'oid-at-preview' },
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'completed');
  // No IPC `preview` preflight (that wrapper only runs for force); the service
  // restore entry remains authoritative and is reached exactly once.
  assert.equal(routes.state.calls.filter((c) => c.method === 'preview').length, 0);
  const restore = routes.state.calls.find((c) => c.method === 'restore');
  assert.ok(restore);
  assert.equal((restore!.args[0] as { force?: boolean }).force, false);
});

// ── 4. Open #4 — force REFUSED while an active turn witnesses the path ────────────

test('force restore is refused while an active turn witnesses a requested path', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'live-turn' }], staleTokens: true });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' }, force: true,
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, FORCE_REFUSED_ACTIVE_TURN);
  assert.deepEqual(res.contention, [{ path: 'a.txt', turnId: 'live-turn' }]);
  // The gate consulted the shared preview, and NO mutation reached the engine.
  assert.equal(routes.state.calls.filter((c) => c.method === 'preview').length, 1);
  assert.equal(routes.state.calls.filter((c) => c.method === 'restore').length, 0);
});

test('force revert is refused while an active turn witnesses the turn set', async () => {
  const { ipc, routes } = wire({ contention: [{ path: 'a.txt', turnId: 'live-turn' }] });
  const res = await ipc.invoke(CHECKPOINT_CHANNELS.revert, {
    workspaceId: 'ws-1', turnId: 't1', force: true,
  }) as CheckpointRestoreResult;
  assert.equal(res.status, 'failed');
  assert.equal(res.failureReason, FORCE_REFUSED_ACTIVE_TURN);
  // preview called with no paths (full witnessed set); no revert mutation.
  const pv = routes.state.calls.find((c) => c.method === 'preview');
  assert.deepEqual(pv!.args, ['ws-1', 't1', undefined, 'exact']);
  assert.equal(routes.state.calls.filter((c) => c.method === 'revert').length, 0);
});

// ── 5. Open #4 — force ACCEPTED once the turn is closed, over a stale preview ─────

test('force restore is accepted once no active turn witnesses the path, overriding a stale preview', async () => {
  // contention empty = the witnessing turn has ended/stopped. staleTokens=true so a
  // plain restore would fail on the mismatch; only force gets through.
  const { ipc, routes } = wire({ contention: [], staleTokens: true });

  // Baseline: WITHOUT force, the stale token aborts the restore (proves force is
  // what overrides, not the gate being a no-op).
  const noForce = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' },
  }) as CheckpointRestoreResult;
  assert.equal(noForce.status, 'failed');
  assert.equal(noForce.failureReason, 'preview-token-mismatch');

  // WITH force + turn closed → the gate passes and force reaches the engine.
  const forced = await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'stale' }, force: true,
  }) as CheckpointRestoreResult;
  assert.equal(forced.status, 'completed');
  const forcedCall = routes.state.calls.filter((c) => c.method === 'restore').at(-1);
  assert.equal((forcedCall!.args[0] as { force?: boolean }).force, true);
});

// ── Run ─────────────────────────────────────────────────────────────────────────

test('omitted strategy remains exact across preview, restore, and revert', async () => {
  const { ipc, routes } = wire();
  const preview = await ipc.invoke(CHECKPOINT_CHANNELS.preview, 'ws-1', 't1', ['a.txt']) as CheckpointPreviewResult;
  assert.equal(preview.strategy, 'exact');
  await ipc.invoke(CHECKPOINT_CHANNELS.restore, {
    workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], previewTokens: { 'a.txt': 'oid-at-preview' },
  });
  assert.equal((routes.state.calls.filter((c) => c.method === 'restore').at(-1)!.args[0] as { strategy?: string }).strategy, 'exact');
  await ipc.invoke(CHECKPOINT_CHANNELS.revert, { workspaceId: 'ws-1', turnId: 't1' });
  assert.equal((routes.state.calls.filter((c) => c.method === 'revert').at(-1)!.args[0] as { strategy?: string }).strategy, 'exact');
});

test('merge force is rejected before preview or restore/revert route dispatch', async () => {
  const { ipc, routes } = wire();
  let rejected = 0;
  for (const [channel, request] of [
    [CHECKPOINT_CHANNELS.restore, { workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], strategy: 'merge-undo', force: true }],
    [CHECKPOINT_CHANNELS.revert, { workspaceId: 'ws-1', turnId: 't1', strategy: 'merge-undo', force: true }],
  ] as const) {
    try {
      await ipc.invoke(channel, request);
    } catch (err) {
      assert.match(String(err), /cannot be forced/);
      rejected++;
    }
  }
  assert.equal(rejected, 2, 'REACHABILITY:checkpoint-ipc-strategy');
  assert.equal(routes.state.calls.length, 0, 'merge force must not dispatch any route');
});

function mergeIdentity(state: MergeUndoPreviewIdentity['paths'][number]['state']): MergeUndoPreviewIdentity {
  return {
    workspaceId: 'ws-1', turnId: 't1', strategy: 'merge-undo',
    beforeCommitOid: 'b', afterCommitOid: 'a', requestedPaths: ['a.txt'],
    renameGroups: [], resultTreeOid: 'tree', mergeExitCode: state === 'conflicted' ? 1 : 0,
    hasUnmergedRecords: state === 'conflicted',
    paths: [{
      path: 'a.txt', state, currentRawOid: 'raw', currentCleanOid: 'clean', currentMode: '100644',
      indexCleanOid: 'clean', indexMode: '100644', normalizationFingerprint: 'norm',
      resultBlobOid: 'result', resultMode: '100644',
    }],
  };
}

test('mixed, conflicted, live-contended, and refused previews mint no token', () => {
  const registry = new MergeUndoPreviewRegistry(() => 10, () => 'opaque');
  for (const state of [
    'conflicted', 'refused-live-contention', 'unsupported-entry', 'ignored', 'index-worktree-diverged',
  ] as const) assert.equal(registry.mint(mergeIdentity(state)), null, `${state} must not mint`);
  const mixed = mergeIdentity('merged');
  mixed.paths.push({ ...mixed.paths[0], path: 'b.txt', state: 'conflicted' });
  assert.equal(registry.mint(mixed), null, 'mixed eligible/conflicted set must not mint');
});

test('eligible token is opaque, mechanical-only, single-use, and expires after five minutes', () => {
  let now = 100;
  let serial = 0;
  const registry = new MergeUndoPreviewRegistry(() => now, () => `opaque-${++serial}`);
  const identity = mergeIdentity('merged');
  Object.assign(identity, { patch: 'rendered-global-text' });
  Object.assign(identity.paths[0], { patch: 'rendered-path-text' });
  const token = registry.mint(identity)!;
  assert.equal(token, 'opaque-1');
  const record = registry.consume(token)!;
  assert.equal(record.resultTreeOid, 'tree');
  assert.equal(JSON.stringify(record).includes('rendered-'), false, 'rendered patch text is never stored');
  assert.equal(registry.consume(token), null, 'token is consumed once');
  const expiring = registry.mint(mergeIdentity('clean'))!;
  now += MERGE_UNDO_PREVIEW_TTL_MS;
  assert.equal(registry.consume(expiring), null, 'five-minute token expires at its boundary');
});

test('recovery-surface factory constructs one engine/service and preserves its one registry', async () => {
  let engineConstructions = 0;
  const registry = new MergeUndoPreviewRegistry(() => 0, () => 'only-token');
  const service = new CheckpointService({ queue: new CheckpointQueue(), gitExe: 'git', mergeUndoPreviewRegistry: registry });
  const routes = makeRoutes();
  const surface = await createCheckpointRecoverySurface({
    createEngine: async () => {
      engineConstructions++;
      return { humanCheckpointRoutes: routes, service };
    },
  });
  assert.equal(engineConstructions, 1);
  assert.equal(surface?.service, service);
  assert.equal(surface?.service.mergeUndoPreviewRegistry, registry);
  assert.notEqual(surface?.humanCheckpointRoutes, routes, 'factory installs the production adapter');
  await surface?.humanCheckpointRoutes.preview('ws-1', 't1', ['a.txt'], 'merge-undo');
  assert.deepEqual(routes.state.calls.at(-1), {
    method: 'preview', args: ['ws-1', 't1', ['a.txt'], 'merge-undo'],
  });
  const bootstrap = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  assert.match(
    bootstrap,
    /createCheckpointRecoverySurface\(\{ createEngine: createCheckpointEngine \}\)/,
    'REACHABILITY:recovery-surface-factory',
  );
});

test('pure preload invoke factory uses the production checkpoint channels and argument shape', async () => {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const api = createCheckpointInvokeApi(async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    calls.push({ channel, args });
    return undefined as T;
  });
  await api.preview('ws-1', 't1', { strategy: 'merge-undo', paths: ['a.txt'] });
  await api.restore({ workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], strategy: 'merge-undo', mergePreviewToken: 'opaque' });
  assert.deepEqual(calls, [
    { channel: CHECKPOINT_CHANNELS.preview, args: ['ws-1', 't1', { strategy: 'merge-undo', paths: ['a.txt'] }] },
    { channel: CHECKPOINT_CHANNELS.restore, args: [{ workspaceId: 'ws-1', turnId: 't1', paths: ['a.txt'], strategy: 'merge-undo', mergePreviewToken: 'opaque' }] },
  ]);
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} checkpoint-ipc tests passed`);
})();
