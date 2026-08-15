import React, { useEffect, useMemo, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { ActivityItem, CheckpointTurnSummary, TurnActivityRow } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import RestoreDialog from '../checkpoints/RestoreDialog';

export function activityBadge(row: TurnActivityRow): string {
  if (row.status === 'open' || row.undo.state === 'checking') return 'In progress';
  if (row.undo.state === 'restorable') return 'Restorable';
  if (row.undo.state === 'blocked-overlap') return 'Undo blocked by later overlap';
  return 'No restore point';
}

function badgeTone(label: string): string {
  if (label === 'Restorable') return 'text-accent-green bg-accent-green/10';
  if (label === 'Undo blocked by later overlap') return 'text-accent-red bg-accent-red/10';
  if (label === 'In progress') return 'text-accent-blue bg-accent-blue/10';
  return 'text-accent-orange bg-accent-orange/10';
}

function when(timestamp: number | null): string {
  if (timestamp === null) return 'time unavailable';
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  return new Date(timestamp).toLocaleDateString();
}

function asCheckpointTurn(row: TurnActivityRow): CheckpointTurnSummary {
  return {
    turnId: row.turnId,
    turnSeq: row.turnSeq,
    agentId: row.agentId,
    agentTitle: row.agentTitle,
    taskLabel: row.taskLabel,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    beforeReady: row.beforeReady,
    afterReady: row.afterReady,
    beforeQuality: row.beforeQuality,
    afterQuality: row.afterQuality,
    witnessedPaths: row.witnessedPaths.map((path) => path.repoPath),
    failureReason: row.failureReason,
  };
}

function TurnRow({ row, onUndo }: { row: TurnActivityRow; onUndo: (row: TurnActivityRow) => void }): React.ReactElement {
  const badge = activityBadge(row);
  return (
    <article className="ui-card p-3" data-testid={`activity-turn-${row.turnId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">Agent edit</span>
            <span className="text-[11px] text-gray-600">{when(row.endedAt ?? row.startedAt)}</span>
          </div>
          <h3 className="mt-1 text-[13px] text-gray-200 truncate">{row.taskLabel || `Turn ${row.turnSeq}`}</h3>
          <p className="text-[11px] text-gray-500">{row.agentTitle ?? 'Unknown agent'} · {row.writeCount} changes</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badgeTone(badge)}`}>{badge}</span>
          {row.undo.state === 'restorable' && (
            <button type="button" onClick={() => onUndo(row)} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]" aria-label={`Undo ${row.taskLabel || `Turn ${row.turnSeq}`}`}>
              <RotateCcw className="w-3 h-3" /> Undo
            </button>
          )}
        </div>
      </div>
      {row.witnessedPaths.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Changed files">
          {row.witnessedPaths.map((path) => <li key={path.repoPath} className="rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-gray-500">{path.displayPath}</li>)}
        </ul>
      )}
    </article>
  );
}

function OtherRow({ item }: { item: Exclude<ActivityItem, TurnActivityRow | { kind: 'plan-group' }> }): React.ReactElement {
  const external = item.kind === 'window-unattributed';
  const paths = item.paths;
  return (
    <article className="ui-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{external ? 'External or script change' : 'Agent edit'}</div>
      <div className="mt-1 text-[12px] text-gray-300">{paths.length} changed {paths.length === 1 ? 'file' : 'files'}</div>
      <div className="mt-2 flex flex-wrap gap-1">{paths.map((path) => <span key={path.repoPath} className="rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-gray-500">{path.displayPath}</span>)}</div>
    </article>
  );
}

export default function ActivityTab(): React.ReactElement {
  const workspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const page = useDashboardStore((state) => state.activityPage);
  const counts = useDashboardStore((state) => state.activityReturnCounts);
  const filter = useDashboardStore((state) => state.activityFilter);
  const loading = useDashboardStore((state) => state.activityLoading);
  const error = useDashboardStore((state) => state.activityError);
  const loadActivity = useDashboardStore((state) => state.loadActivity);
  const showActivity = useDashboardStore((state) => state.showActivity);
  const [undoRow, setUndoRow] = useState<TurnActivityRow | null>(null);

  useEffect(() => {
    if (workspaceId) void loadActivity(workspaceId, filter, true);
  }, [filter.agentId, filter.planId, filter.planItemId, loadActivity, workspaceId]);

  const newCount = counts?.turnCount ?? 0;
  const items = useMemo(() => page?.items ?? [], [page]);
  if (!workspaceId) return <div className="flex-1 p-6 text-gray-500">Select a workspace to view activity.</div>;

  return (
    <section className="flex-1 min-h-0 overflow-y-auto p-5 scrollbar-thin" aria-label="Activity">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div><h2 className="text-[16px] text-gray-100 font-semibold">While you were away</h2><p className="text-[11px] text-gray-500">Newest activity first</p></div>
          {(filter.agentId || filter.planId || filter.planItemId) && (
            <button type="button" className="ui-btn ui-btn-ghost text-[11px]" onClick={() => { showActivity({}); void loadActivity(workspaceId, {}); }}><X className="w-3 h-3" /> Clear filter</button>
          )}
        </div>
        {newCount > 0 && <div role="status" className="mb-4 rounded border border-accent-blue/30 bg-accent-blue/10 p-3 text-[12px] text-accent-blue">{newCount} new activity {newCount === 1 ? 'item' : 'items'} since you last viewed this workspace</div>}
        {error && <div role="alert" className="mb-4 text-[12px] text-accent-red">Activity unavailable: {error}</div>}
        {loading && items.length === 0 ? <div className="text-gray-500">Loading activity…</div> : items.length === 0 ? <div className="ui-card p-6 text-center text-gray-500">No activity observed yet.</div> : (
          <div className="space-y-2">
            {items.map((item) => item.kind === 'turn' ? <TurnRow key={item.turnId} row={item} onUndo={setUndoRow} /> : item.kind === 'plan-group' ? (
              <section key={`plan:${item.planId}`} className="space-y-2">
                <div className="px-1 text-[11px] text-accent-purple">Plan: {item.planTitle ?? item.planId} · observed evidence</div>
                {item.members.map((row) => <TurnRow key={row.turnId} row={row} onUndo={setUndoRow} />)}
              </section>
            ) : <OtherRow key={item.id} item={item} />)}
          </div>
        )}
      </div>
      {undoRow && <RestoreDialog workspaceId={workspaceId} agentId={undoRow.agentId ?? ''} turn={asCheckpointTurn(undoRow)} mode="revert" paths={undoRow.witnessedPaths.map((path) => path.repoPath)} onClose={() => setUndoRow(null)} onDone={() => void loadActivity(workspaceId, filter, false)} />}
    </section>
  );
}
