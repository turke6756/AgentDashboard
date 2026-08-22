// RestoreDialog.tsx — Git-Native WP-G2.4.
//
// The human confirmation surface for a checkpoint restore ("Restore a file…") or a
// whole-turn undo ("Undo this turn"). Three load-bearing rules from the plan shape
// (§2.4 / §2.9) live in this component:
//
//   1. A PREVIEW IS REQUIRED before any restore can be confirmed. The confirm
//      button stays disabled until a fresh preview is fetched — the preview carries
//      the anti-TOCTOU tokens (current worktree OID per path) that the restore
//      echoes back, and surfaces the current open-turn contention.
//   2. The RAW WINDOW diff is shown but CLEARLY LABELED "unattributed changes in
//      this window" — it is NOT attributed to this turn (attribution is witnessed
//      write/create paths only, plan §8.2). Restore never touches those bytes; the
//      section is informational so the human sees what else moved in the window.
//   3. A CONTENT-SEMANTICS WARNING shows when the turn's before-edge captured
//      filter-managed bytes (LFS / git-crypt) as raw on-disk bytes
//      (`beforeRawFilterBypassed`): a restore rewrites those on-disk bytes and does
//      NOT reconstruct the managed form.
//
// The dialog drives the store's checkpoint actions; it invents no IPC of its own.

import React, { useState } from 'react';
import type {
  CheckpointTurnSummary,
  CheckpointPreviewResult,
  CheckpointDiffEntry,
  CheckpointRestoreResult,
  MergeUndoPathPreview,
  RestoreStrategy,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

export interface RestoreDialogProps {
  workspaceId: string;
  /** The agent whose rail opened this dialog — used to refresh after the mutation.
   *  Not `turn.agentId` (which may be null on a late-bound row). */
  agentId: string;
  turn: CheckpointTurnSummary;
  /** 'restore' = a chosen subset of witnessed paths; 'revert' = the whole turn. */
  mode: 'restore' | 'revert';
  /** Candidate paths (a subset of the turn's witnessed set). For 'revert' these are
   *  informational (the whole witnessed set is undone server-side). */
  paths: string[];
  onClose: () => void;
  onDone?: (result: CheckpointRestoreResult) => void;
  /** Activity's exact background preview can open directly into the safer merge flow. */
  initialStrategy?: RestoreStrategy;
}

/** The exact content-semantics warning copy (plan §2.4). */
export const FILTER_BYPASS_WARNING =
  'Restoring writes on-disk bytes; the LFS/git-crypt-managed form is not reconstructed.';

const ELIGIBLE_MERGE_STATES = new Set<MergeUndoPathPreview['state']>(['clean', 'merged']);

function reasonCopy(reason: string | undefined): string {
  switch (reason) {
    case 'merge-undo-conflict': return 'Undo conflicts with later edits.';
    case 'active-turn-witnesses-path': return 'An active turn is editing this path. Wait for it to finish or stop the agent, then preview again.';
    case 'index-worktree-diverged': return 'This path has unstaged or partially staged changes — or is not tracked by git yet. Stage it (git add), or commit or restore its staging state, then preview again.';
    case 'rename-pair-incomplete': return 'Both sides of this rename must be selected together.';
    case 'not-witnessed-for-undo': return 'This path was not witnessed for this turn and cannot be undone.';
    case 'unsupported-content-conversion': return 'This path uses an unsupported content filter or working-tree encoding.';
    case 'unsupported-entry': return 'This Git entry type is not supported for merged undo.';
    case 'unsupported-symlink': return 'Symbolic links are not supported for merged undo.';
    case 'ignored': return 'This path is ignored and cannot be changed by merged undo.';
    default: return reason ? `Merged undo refused: ${reason}.` : 'Merged undo is unavailable for this path.';
  }
}

function patchRanges(patch: string | undefined): string[] {
  if (!patch) return [];
  return Array.from(patch.matchAll(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/gm), (match) => {
    const start = Number(match[1]);
    const count = Number(match[2] ?? '1');
    return count <= 1 ? `line ${start}` : `lines ${start}-${start + count - 1}`;
  });
}

function renamePairs(paths: MergeUndoPathPreview[] | undefined): string[][] {
  const pairs = new Map<string, string[]>();
  for (const item of paths ?? []) {
    const match = item.patch?.match(/^rename from (.+)\r?\nrename to (.+)$/m);
    if (!match) continue;
    const pair = [match[1], match[2]].sort();
    pairs.set(pair.join('\0'), pair);
  }
  return Array.from(pairs.values());
}

export default function RestoreDialog({
  workspaceId,
  agentId,
  turn,
  mode,
  paths,
  onClose,
  onDone,
  initialStrategy = 'exact',
}: RestoreDialogProps) {
  const previewCheckpointRestore = useDashboardStore((s) => s.previewCheckpointRestore);
  const restoreCheckpointPaths = useDashboardStore((s) => s.restoreCheckpointPaths);
  const revertCheckpointTurn = useDashboardStore((s) => s.revertCheckpointTurn);

  // For a path-scoped restore the human can trim the candidate set; a revert always
  // acts on the whole witnessed set, so the checkboxes are display-only there.
  const [strategy, setStrategy] = useState<RestoreStrategy>(initialStrategy);
  const [selected, setSelected] = useState<Set<string>>(new Set(paths));
  const [knownRenamePairs, setKnownRenamePairs] = useState<string[][]>([]);
  const selectable = strategy === 'merge-undo' || mode === 'restore';
  const effectivePaths = selectable ? Array.from(selected).sort() : turn.witnessedPaths;

  const [preview, setPreview] = useState<CheckpointPreviewResult | null>(null);
  const [windowDiff, setWindowDiff] = useState<CheckpointDiffEntry | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckpointRestoreResult | null>(null);

  const contention = preview?.contention ?? [];
  const rejected = preview?.rejectedPaths ?? [];
  // The server owns the safety verdict. The dialog only honors and explains it;
  // runRestore will recheck authoritatively under its lock.
  const exactGateRefused = !!preview && strategy === 'exact' && (
    !!preview.overlap
    || preview.reason === 'after-snapshot-overlap'
    || preview.reason === 'after-edge-unusable'
    || preview.reason === 'current-hash-failed'
    || preview.reason === 'active-turn-witnesses-path'
  );
  const mergeStates = preview?.pathStates ?? [];
  const mergeAllEligible = strategy === 'merge-undo'
    && mergeStates.length > 0
    && mergeStates.every((item) => ELIGIBLE_MERGE_STATES.has(item.state));
  const canConfirm = !!preview
    && !exactGateRefused
    && !confirming
    && effectivePaths.length > 0
    && (strategy === 'exact' || (mergeAllEligible && !!preview.mergePreviewToken));

  async function handlePreview(nextStrategy: RestoreStrategy = strategy) {
    setPreviewing(true);
    setError(null);
    setResult(null);
    try {
      const [pv, diff] = await Promise.all([
        nextStrategy === 'exact'
          ? previewCheckpointRestore(workspaceId, turn.turnId, effectivePaths)
          : window.api.checkpoints.preview(workspaceId, turn.turnId, {
              paths: effectivePaths,
              strategy: 'merge-undo',
            }),
        window.api.checkpoints.diff(workspaceId, turn.turnId),
      ]);
      setStrategy(nextStrategy);
      setPreview(pv);
      setKnownRenamePairs(renamePairs(pv.pathStates));
      setWindowDiff(diff.window);
    } catch (err) {
      setError(`Preview failed: ${String(err)}`);
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleConfirm() {
    if (!preview) return; // hard gate — never restore without a preview in hand
    setConfirming(true);
    setError(null);
    try {
      // Echo back only the tokens for the paths we are actually restoring.
      const tokens: Record<string, string> = {};
      const scope = strategy === 'merge-undo' ? effectivePaths : mode === 'revert' ? turn.witnessedPaths : effectivePaths;
      for (const p of scope) {
        if (preview.tokens[p] !== undefined) tokens[p] = preview.tokens[p];
      }
      const wholeTurn = mode === 'revert'
        && scope.length === turn.witnessedPaths.length
        && turn.witnessedPaths.every((path) => scope.includes(path));
      const mergeFields = strategy === 'merge-undo'
        ? { strategy, mergePreviewToken: preview.mergePreviewToken }
        : {};
      const out =
        wholeTurn
          ? await revertCheckpointTurn(
              { workspaceId, turnId: turn.turnId, previewTokens: tokens, ...mergeFields },
              agentId,
            )
          : await restoreCheckpointPaths(
              { workspaceId, turnId: turn.turnId, paths: effectivePaths, previewTokens: tokens, ...mergeFields },
              agentId,
            );
      setResult(out);
      onDone?.(out);
    } catch (err) {
      setError(`Restore failed: ${String(err)}`);
    } finally {
      setConfirming(false);
    }
  }

  function togglePath(p: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const group = knownRenamePairs.find((pair) => pair.includes(p)) ?? [p];
      const remove = group.every((path) => next.has(path));
      for (const path of group) {
        if (remove) next.delete(path);
        else next.add(path);
      }
      return next;
    });
    // Any change to the selection invalidates the preview (its tokens are
    // path-scoped) — force a re-preview before the next confirm.
    setPreview(null);
    setWindowDiff(null);
  }

  const title = mode === 'revert' ? 'Undo this turn' : 'Restore a file';

  return (
    <div
      data-testid="restore-dialog-backdrop"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.stopPropagation()}
    >
    <div
      role="dialog"
      aria-label={title}
      data-testid="restore-dialog"
      className="panel-shell w-full max-w-[38rem] max-h-[85vh] border-accent-orange p-3 flex flex-col text-[12px] overflow-y-auto"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-accent-orange font-semibold uppercase tracking-wider text-[11px]">
          {title}
        </span>
        <button onClick={onClose} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]">
          Close
        </button>
      </div>

      <div className="text-gray-400 mb-2">
        {turn.taskLabel || `Turn ${turn.turnSeq}`}
        {turn.agentTitle ? ` — ${turn.agentTitle}` : ''}
      </div>

      {/* CONTENT-SEMANTICS warning — a property of the turn's before-edge, shown
          up front (independent of the preview). */}
      {turn.beforeRawFilterBypassed && (
        <div
          role="alert"
          data-testid="filter-bypass-warning"
          className="mb-2 p-2 rounded text-accent-orange bg-accent-orange/10 border border-accent-orange/40"
        >
          <span className="font-semibold">Filtered content: </span>
          {FILTER_BYPASS_WARNING}
        </div>
      )}

      {/* Witnessed path selection (restore) / summary (revert). */}
      <div className="mb-2">
        <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
          Changed files {mode === 'restore' ? '(select to restore)' : '(all undone)'}
        </div>
        {turn.witnessedPaths.length === 0 ? (
          <div className="text-gray-500 italic">No changed files for this turn.</div>
        ) : (
          <ul className="space-y-0.5">
            {turn.witnessedPaths.map((p) => (
              <li key={p} className="flex items-center gap-1.5 font-mono">
                <input
                  type="checkbox"
                  checked={selectable ? selected.has(p) : true}
                  disabled={!selectable}
                  onChange={() => togglePath(p)}
                />
                <span className="truncate" title={p}>{p}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => void handlePreview()}
          disabled={previewing || effectivePaths.length === 0}
          className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] font-semibold"
        >
          {previewing ? 'Previewing…' : preview ? 'Re-preview' : 'Preview changes'}
        </button>
        {!preview && (
          <span className="text-gray-500 text-[11px]">A preview is required before restoring.</span>
        )}
      </div>

      {preview && strategy === 'exact' && (preview.reason === 'after-snapshot-overlap' || preview.overlap?.reason === 'after-snapshot-overlap') && (
        <div className="mb-2 rounded border border-accent-blue/30 bg-accent-blue/10 p-2" data-testid="merge-undo-offer">
          <p className="text-[11px] text-gray-300">This file changed since the turn. Exact restore would overwrite those changes; preview merged undo instead.</p>
          <button type="button" className="ui-btn ui-btn-ghost mt-1 px-2 py-1 text-[11px]" onClick={() => void handlePreview('merge-undo')}>Preview merged undo</button>
        </div>
      )}

      {preview && strategy === 'merge-undo' && (
        <div className="mb-2 space-y-2" data-testid="merge-undo-preview">
          <p className="text-[11px] text-accent-orange">Merged undo updates both the working tree and the staging area for every selected path.</p>
          {mergeStates.map((item) => {
            const ranges = item.state === 'conflicted' ? patchRanges(item.patch) : [];
            return (
              <article key={item.path} className="rounded border border-surface-3 p-2" data-testid={`merge-path-${item.path}`}>
                <div className="flex justify-between gap-2"><span className="font-mono text-[11px]">{item.path}</span><span className="text-[10px] uppercase text-gray-500">{item.state}</span></div>
                {item.state === 'conflicted' && <p className="mt-1 text-[11px] text-accent-red">Undo conflicts with later edits — {ranges.length > 0 ? ranges.join(', ') : 'binary or structural conflict (no text line range)'}</p>}
                {!ELIGIBLE_MERGE_STATES.has(item.state) && item.state !== 'conflicted' && <p className="mt-1 text-[11px] text-accent-red">{reasonCopy(item.reason ?? item.state)}</p>}
                {item.patch && <pre className="log-surface mt-1 max-h-40 overflow-auto whitespace-pre-wrap border border-surface-3 p-2 text-[11px]">{item.patch}</pre>}
                {item.patchTruncated && <p className="mt-1 text-[10px] text-accent-orange">Patch preview is bounded; {item.omittedBytes ?? 0} bytes omitted for this path.</p>}
              </article>
            );
          })}
          {(preview.omittedPathCount ?? 0) > 0 && <p className="text-[10px] text-accent-orange">{preview.omittedPathCount} path previews omitted by the total preview limit.</p>}
          {!preview.mergePreviewToken && <p className="text-[11px] text-accent-red">This preview cannot be confirmed. Select only eligible paths, then re-preview that exact subset.</p>}
        </div>
      )}

      {/* Current conflicts — open-turn contention + non-witnessed rejects. */}
      {preview && (contention.length > 0 || rejected.length > 0) && (
        <div
          data-testid="conflicts"
          className="mb-2 p-2 rounded text-accent-red bg-accent-red/10 border border-accent-red/30"
        >
          <div className="font-semibold mb-1">Current conflicts</div>
          {contention.map((c) => (
            <div key={`${c.path}:${c.turnId}`} className="font-mono text-[11px]">
              {c.path} — being changed by an active turn
            </div>
          ))}
          {rejected.map((p) => (
            <div key={`rej:${p}`} className="font-mono text-[11px]">
              {p} — not part of this turn (rejected)
            </div>
          ))}
        </div>
      )}

      {preview && exactGateRefused && (
        <div
          role="alert"
          data-testid="restore-refusal"
          className="mb-2 p-2 rounded text-accent-red bg-accent-red/10 border border-accent-red/30"
        >
          <div className="font-semibold mb-1">Undo is blocked</div>
          {preview.overlap?.files.map((file) => (
            <div key={file.path} className="mb-1 last:mb-0">
              <div className="font-mono text-[11px]">{file.path}</div>
              {file.blockers.map((blocker, index) => (
                <div key={blocker.kind === 'later-turn' ? blocker.turnId : `external:${index}`} className="text-[11px]">
                  {blocker.kind === 'external'
                    ? 'changed after this turn (not by a recorded turn)'
                    : `${blocker.agentTitle ?? blocker.agentId ?? 'Unknown agent'} — ${blocker.taskLabel ?? 'Untitled task'} — turn ${blocker.turnSeq}`}
                </div>
              ))}
            </div>
          ))}
          {preview.overlap?.files.length === 0 && (
            <div className="text-[11px]">{preview.reason ?? preview.overlap.reason}</div>
          )}
          {!preview.overlap && (
            <div className="text-[11px]">{preview.reason}</div>
          )}
        </div>
      )}

      {/* Unattributed window diff — CLEARLY labeled as raw/unattributed. */}
      {preview && windowDiff && (
        <div className="mb-2" data-testid="unattributed-window">
          <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">
            {windowDiff.label /* "unattributed changes in this window" */} · raw · not attributed to this turn
          </div>
          {windowDiff.available ? (
            <pre className="log-surface border border-surface-3 p-2 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">
              {windowDiff.text || '(no changes in the window)'}
            </pre>
          ) : (
            <div className="text-gray-500 italic">
              Window diff unavailable{windowDiff.reason ? ` (${windowDiff.reason})` : ''}.
            </div>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="mb-2 text-accent-red text-[11px]">
          {error}
        </div>
      )}

      {result && (
        <div role="status" className="mb-2 text-[11px] text-gray-300" data-testid="restore-result">
          Restore {result.status}: {result.completedPaths.length} restored
          {result.failures.length > 0 ? `, ${result.failures.length} failed` : ''}
          {result.failureReason ? ` — ${result.failureReason}` : ''}
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={handleConfirm}
          disabled={!canConfirm}
          data-testid="confirm-restore"
          className="ui-btn ui-btn-danger flex-1 py-1 text-[12px] font-semibold border-accent-orange/50"
          title={!preview ? 'Preview the changes before restoring' : undefined}
        >
          {confirming ? 'Restoring…' : mode === 'revert' ? 'Confirm undo' : 'Confirm restore'}
        </button>
        <button onClick={onClose} className="ui-btn ui-btn-ghost px-3 py-1 text-[12px]">
          Cancel
        </button>
      </div>
    </div>
    </div>
  );
}
