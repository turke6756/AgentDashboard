import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw, Search, X } from 'lucide-react';
import type { ActivityCountScope, ActivityCounts, ActivityItem, Agent, CheckpointTurnSummary, CountStat, DayGroupRow as DayGroup, FileGroupRow as FileGroup, PlanGroupRow as PlanGroup, TurnActivityRow } from '../../../shared/types';
import { ACTIVITY_FILE_WINDOW_CAP, ACTIVITY_TURN_WINDOW_CAP, useDashboardStore, type ActivityScope } from '../../stores/dashboard-store';
import RestoreDialog from '../checkpoints/RestoreDialog';
import GitInitConsent from '../onboarding/GitInitConsent';

export function activityBadge(row: TurnActivityRow): string {
  if (row.status === 'open' || row.undo.state === 'checking') return 'In progress';
  if (row.undo.state === 'restorable') return 'Restorable';
  if (row.undo.state === 'blocked-overlap' && row.undo.reason === 'after-snapshot-overlap') return 'Changed since turn';
  if (row.undo.state === 'blocked-overlap' && row.undo.reason === 'active-turn-witnesses-path') return 'Agent still editing';
  if (row.undo.state === 'blocked-overlap' && row.undo.reason === 'merge-undo-conflict') return 'Undo has conflicts';
  if (row.undo.state === 'blocked-overlap') return 'Undo unavailable';
  return 'No restore point';
}

function badgeTone(label: string): string {
  if (label === 'Restorable') return 'text-accent-green bg-accent-green/10';
  if (label === 'Changed since turn') return 'text-accent-blue bg-accent-blue/10';
  if (label === 'Agent still editing' || label === 'Undo has conflicts' || label === 'Undo unavailable') return 'text-accent-red bg-accent-red/10';
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

function TurnRow({ row, onUndo }: { row: TurnActivityRow; onUndo: (row: TurnActivityRow, strategy: 'exact' | 'merge-undo') => void }): React.ReactElement {
  const badge = activityBadge(row);
  const storeTitle = useDashboardStore((state) => state.agents.find((agent) => agent.id === row.agentId)?.title);
  const agentTitle = row.agentTitle ?? storeTitle ?? 'Unknown agent';
  return (
    <article className="ui-card p-3" data-testid={`activity-turn-${row.turnId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">Agent edit</span>
            <span className="truncate text-[11px] font-medium text-gray-300" data-testid="activity-turn-agent-title">{agentTitle}</span>
            <span className="text-[11px] text-gray-600">{when(row.endedAt ?? row.startedAt)}</span>
          </div>
          <h3 className="mt-1 text-[13px] text-gray-200 truncate">{row.taskLabel || `Turn ${row.turnSeq}`}</h3>
          <p className="text-[11px] text-gray-500">{row.writeCount} changes</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${badgeTone(badge)}`}>{badge}</span>
          {row.undo.state === 'restorable' && (
            <button type="button" onClick={() => onUndo(row, 'exact')} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]" aria-label={`Undo ${row.taskLabel || `Turn ${row.turnSeq}`}`}>
              <RotateCcw className="w-3 h-3" /> Undo
            </button>
          )}
          {row.undo.state === 'blocked-overlap' && row.undo.reason === 'after-snapshot-overlap' && (
            <button type="button" onClick={() => onUndo(row, 'merge-undo')} className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]">Preview merged undo</button>
          )}
        </div>
      </div>
      {row.undo.state === 'blocked-overlap' && row.undo.reason === 'after-snapshot-overlap' && <p className="mt-2 text-[11px] text-gray-400">This file changed since the turn. Exact restore would overwrite those changes; merged undo can preserve later edits.</p>}
      {row.undo.state === 'blocked-overlap' && row.undo.reason === 'active-turn-witnesses-path' && <p className="mt-2 text-[11px] text-accent-red">An active turn is editing this path. Wait for it to finish or stop the agent, then try again.</p>}
      {row.witnessedPaths.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Changed files">
          {row.witnessedPaths.map((path) => <li key={path.repoPath} className="rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-gray-500">{path.displayPath}</li>)}
        </ul>
      )}
    </article>
  );
}

export function OtherRow({ item }: { item: Extract<ActivityItem, { kind: 'tool-unjoined' | 'window-unattributed' }> }): React.ReactElement {
  const external = item.kind === 'window-unattributed';
  const paths = item.paths;
  return (
    <article className="ui-card p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{external ? 'External or script change' : 'Tool or script activity outside a recorded turn'}</div>
      <div className="mt-1 text-[12px] text-gray-300">{paths.length} changed {paths.length === 1 ? 'file' : 'files'}</div>
      <div className="mt-2 flex flex-wrap gap-1">{paths.map((path) => <span key={path.repoPath} className="rounded bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-mono text-gray-500">{path.displayPath}</span>)}</div>
      {external && item.hasOmittedPaths && (
        <p className="mt-2 text-[11px] text-accent-orange">Additional changed paths cannot be displayed.</p>
      )}
    </article>
  );
}

function gapLabel(milliseconds: number): string {
  const hours = Math.max(1, Math.round(milliseconds / 3_600_000));
  if (hours < 24) return `${hours}h later`;
  const days = Math.max(1, Math.round(hours / 24));
  return `${days} ${days === 1 ? 'day' : 'days'} later`;
}

export function DayGroupRow({ group, expanded, onToggle, onUndo }: { group: DayGroup; expanded: boolean; onToggle: () => void; onUndo: (row: TurnActivityRow, strategy: 'exact' | 'merge-undo') => void }): React.ReactElement {
  const label = group.latestStartedAt === null
    ? 'Time unavailable'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: group.timeZone }).format(group.latestStartedAt);
  return <div className="space-y-2" data-testid={`activity-day-${group.dayKey ?? 'unknown'}`}>
    {group.gapFromNewerGroupMs !== null && <div className="flex items-center gap-3 py-2 text-[10px] text-gray-500" role="separator"><span className="h-px flex-1 bg-white/10" /><span>{gapLabel(group.gapFromNewerGroupMs)}</span><span className="h-px flex-1 bg-white/10" /></div>}
    <section className="space-y-2">
      <button type="button" className="ui-card flex w-full items-center gap-2 p-3 text-left" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`} onClick={onToggle}>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-400">{label}</span>
        <span className="shrink-0 text-[11px] text-gray-500">{group.members.length} {group.members.length === 1 ? 'turn' : 'turns'} · {when(group.latestStartedAt)}</span>
      </button>
      {expanded && <div className="space-y-2 pl-3">{group.members.map((row) => <TurnRow key={row.turnId} row={row} onUndo={onUndo} />)}</div>}
    </section>
  </div>;
}

function PlanGroupRow({ group, expanded, onToggle, onUndo }: {
  group: PlanGroup;
  expanded: boolean;
  onToggle: () => void;
  onUndo: (row: TurnActivityRow, strategy: 'exact' | 'merge-undo') => void;
}): React.ReactElement {
  const label = group.planTitle ?? group.planId;
  return <section className="space-y-2" data-testid={`activity-plan-${group.planId}`}>
    <button type="button" className="ui-card flex w-full items-center gap-2 p-3 text-left" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} plan ${label}`} onClick={onToggle}>
      {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-[11px] text-accent-purple">Plan: {label}</span>
      <span className="shrink-0 text-[11px] text-gray-500">{group.members.length} {group.members.length === 1 ? 'turn' : 'turns'} · {when(group.latestStartedAt)}</span>
    </button>
    {expanded && <div className="space-y-2 pl-3">{group.members.map((row) => <TurnRow key={row.turnId} row={row} onUndo={onUndo} />)}</div>}
  </section>;
}

export function FileGroupRow({ group, expanded, onToggle, onDrill, onUndo }: {
  group: FileGroup;
  expanded: boolean;
  onToggle: () => void;
  onDrill: (repoPath: string) => void;
  onUndo: (row: TurnActivityRow, strategy: 'exact' | 'merge-undo') => void;
}): React.ReactElement {
  return <section className="space-y-2" data-testid={`activity-file-${group.repoPath}`}>
    <div className="ui-card flex w-full items-center gap-2 p-3">
      <button type="button" className="shrink-0 text-gray-500 hover:text-gray-200" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.displayPath}`} onClick={onToggle}>
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      <button type="button" className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-gray-300 hover:text-gray-100" onClick={() => onDrill(group.repoPath)}>{group.displayPath}</button>
      <span className="shrink-0 text-[11px] text-gray-500">{group.members.length} {group.members.length === 1 ? 'turn' : 'turns'} · {when(group.latestStartedAt)}</span>
      <button type="button" className="ui-btn ui-btn-ghost px-2 py-1 text-[10px]" onClick={() => onDrill(group.repoPath)}>Open</button>
    </div>
    {expanded && <div className="space-y-2 pl-3">{group.members.map((row) => <TurnRow key={row.turnId} row={row} onUndo={onUndo} />)}</div>}
  </section>;
}

function LensSwitcher({ value, onChange }: { value: ActivityScope['grouping']; onChange: (grouping: ActivityScope['grouping']) => void }): React.ReactElement {
  return <div className="flex rounded border border-white/10 p-0.5" aria-label="Activity lens">
    {([['time', 'Time'], ['file', 'File'], ['plan', 'Plan'], ['none', 'Flat']] as const).map(([grouping, label]) => <button key={grouping} type="button" aria-pressed={value === grouping} className={`rounded px-2 py-1 text-[11px] ${value === grouping ? 'bg-white/10 text-gray-100' : 'text-gray-500'}`} onClick={() => onChange(grouping)}>{label}</button>)}
  </div>;
}

function scopeLabel(scope: ActivityScope, depth: number): string {
  const lens = scope.grouping === 'none' ? 'Flat' : `${scope.grouping[0].toUpperCase()}${scope.grouping.slice(1)}`;
  return scope.pathPrefix ? scope.pathPrefix : depth === 0 ? lens : `${lens} view`;
}

function Breadcrumb({ history, current, onBack, onPopToDepth }: {
  history: ActivityScope[];
  current: ActivityScope;
  onBack: () => void;
  onPopToDepth: (depth: number) => void;
}): React.ReactElement | null {
  if (history.length === 0) return null;
  return <nav className="mb-4 flex items-center gap-2 text-[11px] text-gray-500" aria-label="Activity drill breadcrumb">
    <button type="button" className="ui-btn ui-btn-ghost text-[11px]" onClick={onBack}>Back</button>
    <ol className="flex min-w-0 items-center gap-2">
      {history.map((scope, depth) => <li key={`${depth}:${scope.grouping}:${scope.pathPrefix ?? ''}`} className="flex min-w-0 items-center gap-2">
        <button type="button" className="max-w-48 truncate hover:text-gray-200" onClick={() => onPopToDepth(depth)}>{scopeLabel(scope, depth)}</button>
        <span aria-hidden="true">/</span>
      </li>)}
      <li className="max-w-64 truncate text-gray-300" aria-current="page">{scopeLabel(current, history.length)}</li>
    </ol>
  </nav>;
}

type ActivityFilterKey = 'agentId' | 'pathPrefix' | 'planId' | 'planItemId';

function AgentPicker({ agents, workspaceId, value, onChange }: { agents: Agent[]; workspaceId: string; value?: string; onChange: (agentId?: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [flyoutId, setFlyoutId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workspaceAgents = useMemo(() => agents.filter((agent) => agent.workspaceId === workspaceId), [agents, workspaceId]);
  const selected = workspaceAgents.find((agent) => agent.id === value);
  const supervisors = workspaceAgents.filter((agent) => agent.isSupervisor === true || agent.privilegeLane === 'supervisor');
  const supervisorIds = new Set(supervisors.map((agent) => agent.id));
  const unowned = workspaceAgents.filter((agent) => !supervisorIds.has(agent.id)
    && (!agent.ownerAgentId || !supervisorIds.has(agent.ownerAgentId)));
  const filtered = query.trim() === '' ? [] : workspaceAgents.filter((agent) => {
    const needle = query.trim().toLowerCase();
    return agent.title.toLowerCase().includes(needle)
      || agent.id.toLowerCase().includes(needle)
      || agent.slug.toLowerCase().includes(needle);
  });

  const close = () => {
    setOpen(false);
    setQuery('');
    setFlyoutId(null);
  };

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const choose = (agentId?: string) => {
    onChange(agentId);
    close();
  };
  const option = (agent: Agent) => <button key={agent.id} type="button" role="option" aria-selected={value === agent.id} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[11px] text-gray-300 hover:bg-white/5 focus:bg-white/5 focus:outline-none" onClick={() => choose(agent.id)}>
    <span className="truncate">{agent.title || agent.id}</span><span className="ml-2 text-[9px] uppercase text-gray-600">{agent.status}</span>
  </button>;

  return <div className="relative" ref={rootRef}>
    <button type="button" aria-label="Filter activity by agent" aria-haspopup="listbox" aria-expanded={open} className="flex items-center gap-1 rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-gray-300" onClick={() => open ? close() : setOpen(true)}>
      <span className="max-w-40 truncate">{selected?.title || 'All agents'}</span><ChevronDown className="h-3 w-3" />
    </button>
    {open && <div className="absolute right-0 z-30 mt-1 w-64 rounded border border-white/10 bg-surface-0 p-2 shadow-xl" role="listbox" aria-label="Activity agents">
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search agents" aria-label="Search agents" className="w-full rounded border border-white/10 bg-black/20 py-1.5 pl-7 pr-2 text-[11px] text-gray-200 placeholder:text-gray-600 focus:border-accent-blue/60 focus:outline-none" />
      </div>
      {query.trim() !== '' ? <div className="max-h-64 overflow-y-auto">{filtered.length > 0 ? filtered.map(option) : <div className="px-2 py-2 text-[11px] text-gray-500">No matching agents.</div>}</div> : <div className="max-h-64 space-y-1 overflow-y-auto" data-testid="activity-agent-grouped-pane">
        <button type="button" role="option" aria-selected={!value} className="w-full rounded px-2 py-1.5 text-left text-[11px] text-gray-300 hover:bg-white/5" onClick={() => choose(undefined)}>All agents</button>
        {supervisors.map((supervisor) => {
          const workers = workspaceAgents.filter((agent) => agent.ownerAgentId === supervisor.id);
          const showFlyout = flyoutId === supervisor.id && workers.length > 0;
          return <div key={supervisor.id} className="py-0.5">
            <div className="flex items-center rounded hover:bg-white/5 focus-within:bg-white/5">
              <button type="button" role="option" aria-selected={value === supervisor.id} className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-[11px] text-gray-300 focus:outline-none" onClick={() => choose(supervisor.id)}>{supervisor.title || supervisor.id}</button>
              {workers.length > 0 && <button type="button" aria-label={`Show agents owned by ${supervisor.title || supervisor.id}`} aria-expanded={showFlyout} className="p-1.5 text-gray-500 hover:text-gray-200" onClick={() => setFlyoutId((current) => current === supervisor.id ? null : supervisor.id)}><ChevronRight className="h-3 w-3" /></button>}
            </div>
            {showFlyout && <div className="pt-1 pl-4"><div className="max-h-64 overflow-y-auto rounded border border-white/10 bg-black/10 p-1" aria-label={`Agents owned by ${supervisor.title || supervisor.id}`}>{workers.map(option)}</div></div>}
          </div>;
        })}
        {unowned.length > 0 && <div className="border-t border-white/10 pt-1"><div className="px-2 py-1 text-[9px] uppercase tracking-wider text-gray-600">Unowned</div>{unowned.map(option)}</div>}
      </div>}
    </div>}
  </div>;
}

function FilterChips({ scope, agents, onRemove, onClear }: {
  scope: ActivityScope;
  agents: Agent[];
  onRemove: (key: ActivityFilterKey) => void;
  onClear: () => void;
}): React.ReactElement | null {
  const agentLabel = scope.agentId
    ? agents.find((agent) => agent.id === scope.agentId)?.title || scope.agentId
    : null;
  const filters: Array<{ key: ActivityFilterKey; label: string }> = [
    ...(scope.agentId ? [{ key: 'agentId' as const, label: `Agent: ${agentLabel}` }] : []),
    ...(scope.pathPrefix ? [{ key: 'pathPrefix' as const, label: `Path: ${scope.pathPrefix}` }] : []),
    ...(scope.planId ? [{ key: 'planId' as const, label: `Plan: ${scope.planId}` }] : []),
    ...(scope.planItemId ? [{ key: 'planItemId' as const, label: `Plan item: ${scope.planItemId}` }] : []),
  ];
  if (filters.length === 0) return null;
  return <div className="mb-4 flex flex-wrap items-center gap-2" aria-label="Active activity filters">
    {filters.map((filter) => <span key={filter.key} className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] px-2 py-1 text-[11px] text-gray-300">
      {filter.label}
      <button type="button" className="rounded text-gray-500 hover:text-gray-200" aria-label={`Remove ${filter.key} filter`} onClick={() => onRemove(filter.key)}><X className="h-3 w-3" /></button>
    </span>)}
    <button type="button" className="ui-btn ui-btn-ghost text-[11px]" onClick={onClear}>Clear all</button>
  </div>;
}

function boundedCount(value: number, complete: boolean, markPartial = false): string {
  if (complete) return String(value);
  return `${value}+${markPartial ? ' (partial)' : ''}`;
}

function countStat(stat: CountStat): string {
  return stat.status === 'pending' ? '…' : String(stat.value);
}

function CountSummary({ counts, scope }: { counts: ActivityCounts; scope: ActivityCountScope }): React.ReactElement {
  const turnValue = boundedCount(counts.turnCount, scope.completeness.turns, true);
  const turnNoun = scope.turnCountBasis === 'loaded-turns'
    ? 'turns'
    : scope.filters.pathPrefix
      ? 'visible turns under this path'
      : 'visible turns in file groups';
  return <dl className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500" aria-label="Activity counts">
    <div><dt className="sr-only">Turns</dt><dd data-testid="activity-count-turns">{turnValue} {turnNoun}</dd></div>
    <div><dt className="sr-only">Agents</dt><dd><span data-testid="activity-count-agents">{boundedCount(counts.agentCount, scope.completeness.agents)}</span> agents</dd></div>
    <div><dt className="sr-only">Files</dt><dd><span data-testid="activity-count-files">{boundedCount(counts.fileCount, scope.completeness.files)}</span> files</dd></div>
    <div><dt className="sr-only">Plans</dt><dd><span data-testid="activity-count-plans">{boundedCount(counts.planCount, scope.completeness.plans)}</span> plans</dd></div>
    <div><dt className="sr-only">Commits</dt><dd><span data-testid="activity-count-commits">{boundedCount(counts.commitCount, scope.completeness.commits)}</span> commits</dd></div>
    <div><dt className="sr-only">Blocked overlaps</dt><dd><span data-testid="activity-count-blocked">{countStat(counts.blockedOverlapCount)}</span> blocked overlaps</dd></div>
    <div><dt className="sr-only">Unavailable</dt><dd><span data-testid="activity-count-unavailable">{countStat(counts.unavailableCount)}</span> unavailable</dd></div>
    <div><dt className="sr-only">Checking</dt><dd><span data-testid="activity-count-checking">{countStat(counts.checkingCount)}</span> checking</dd></div>
  </dl>;
}

export default function ActivityTab(): React.ReactElement {
  const workspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const page = useDashboardStore((state) => state.activityPage);
  const counts = useDashboardStore((state) => state.activityReturnCounts);
  const scope = useDashboardStore((state) => state.activityScope);
  const scopeHistory = useDashboardStore((state) => state.activityScopeHistory);
  const turnWindow = useDashboardStore((state) => state.activityTurnWindow);
  const fileWindow = useDashboardStore((state) => state.activityFileWindow);
  const loading = useDashboardStore((state) => state.activityLoading);
  const error = useDashboardStore((state) => state.activityError);
  const loadActivity = useDashboardStore((state) => state.loadActivity);
  const loadOlderActivity = useDashboardStore((state) => state.loadOlderActivity);
  const setLens = useDashboardStore((state) => state.setLens);
  const agents = useDashboardStore((state) => state.agents);
  const setAgentFilter = useDashboardStore((state) => state.setAgentFilter);
  const removeFilter = useDashboardStore((state) => state.removeFilter);
  const clearActivityFilters = useDashboardStore((state) => state.clearActivityFilters);
  const pushDrill = useDashboardStore((state) => state.pushDrill);
  const popDrill = useDashboardStore((state) => state.popDrill);
  const popToDepth = useDashboardStore((state) => state.popToDepth);
  const prerequisites = useDashboardStore((state) => state.prerequisites);
  const [undoDialog, setUndoDialog] = useState<{ row: TurnActivityRow; strategy: 'exact' | 'merge-undo' } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    const state = useDashboardStore.getState();
    if (state.activityPage === null && !state.activityLoading && !state.activityError) void loadActivity(workspaceId, state.activityScope, true);
  }, [workspaceId, loadActivity]);

  const newCount = counts?.turnCount ?? 0;
  const items = useMemo(() => page?.items ?? [], [page]);
  const nextOlder = page?.cursor.nextOlder;
  const grouped = scope.grouping !== 'none';
  const sourceBelowCap = Boolean(nextOlder && (
    (!nextOlder.turns.exhausted && turnWindow < ACTIVITY_TURN_WINDOW_CAP)
    || (!nextOlder.fileActivities.exhausted && fileWindow < ACTIVITY_FILE_WINDOW_CAP)
  ));
  const showLoadOlder = Boolean(nextOlder && (!grouped || sourceBelowCap));
  const showTerminalNotice = Boolean(grouped && nextOlder && !sourceBelowCap);
  const gitCapability = prerequisites?.optional.find((check) => check.id === 'git')?.git;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setExpandedGroups(new Set());
  }, [workspaceId, scope.grouping]);
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  if (!workspaceId) return <div className="flex-1 p-6 text-gray-500">Select a workspace to view activity.</div>;

  return (
    <section className="flex-1 min-h-0 overflow-y-auto p-5 scrollbar-thin" aria-label="Activity">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div><h2 className="text-[16px] text-gray-100 font-semibold">While you were away</h2><p className="text-[11px] text-gray-500">Newest activity first</p></div>
          <div className="flex items-center gap-2">
            <AgentPicker agents={agents} workspaceId={workspaceId} value={scope.agentId} onChange={setAgentFilter} />
            <LensSwitcher value={scope.grouping} onChange={setLens} />
          </div>
        </div>
        <FilterChips scope={scope} agents={agents} onRemove={removeFilter} onClear={clearActivityFilters} />
        <Breadcrumb history={scopeHistory} current={scope} onBack={popDrill} onPopToDepth={popToDepth} />
        {page && <CountSummary counts={page.pageCounts} scope={page.scope} />}
        {gitCapability?.protectedRoot ? (
          <div className="ui-card mb-4 border-accent-orange/30 p-4" data-testid="checkpoints-protected-root">
            <h3 className="text-[13px] font-medium text-gray-200">Checkpoints are unavailable for this workspace</h3>
            <p className="mt-1 text-[12px] text-gray-400">
              This folder is a protected root. Lares will not create a Git repository in your home folder, Desktop,
              Documents, Downloads, or a drive/filesystem root. Open a specific project subfolder instead.
            </p>
          </div>
        ) : gitCapability?.repoState === 'non-repo' ? (
          <div className="ui-card mb-4 p-4" data-testid="checkpoints-non-repo">
            <p className="text-[12px] text-gray-300">
              Checkpoints are unavailable because this folder is not a Git repository.
            </p>
            <GitInitConsent />
          </div>
        ) : null}
        {newCount > 0 && <div role="status" className="mb-4 rounded border border-accent-blue/30 bg-accent-blue/10 p-3 text-[12px] text-accent-blue">{newCount} new activity {newCount === 1 ? 'item' : 'items'} since you last viewed this workspace</div>}
        {error && <div role="alert" className="mb-4 text-[12px] text-accent-red">Activity unavailable: {error}</div>}
        {loading && items.length === 0 ? <div className="text-gray-500">Loading activity…</div> : (
          <div className="space-y-2">
            {items.length === 0 && <div className="ui-card p-6 text-center text-gray-500">No activity observed on this page.</div>}
            {items.map((item) => {
              const groupKey = item.kind === 'plan-group' ? `plan:${item.planId}` : item.kind === 'day-group' ? `time:${item.dayKey ?? 'unknown'}` : item.kind === 'file-group' ? `file:${item.repoPath}` : null;
              const expanded = groupKey !== null && expandedGroups.has(groupKey);
              return item.kind === 'turn' ? <TurnRow key={item.turnId} row={item} onUndo={(row, strategy) => setUndoDialog({ row, strategy })} />
                : item.kind === 'plan-group' ? <PlanGroupRow key={`plan:${item.planId}:${item.latestTurnSeq}`} group={item} expanded={expanded} onToggle={() => toggleGroup(groupKey!)} onUndo={(row, strategy) => setUndoDialog({ row, strategy })} />
                  : item.kind === 'day-group' ? <DayGroupRow key={`day:${item.dayKey ?? 'unknown'}`} group={item} expanded={expanded} onToggle={() => toggleGroup(groupKey!)} onUndo={(row, strategy) => setUndoDialog({ row, strategy })} />
                    : item.kind === 'file-group' ? <FileGroupRow key={`file:${item.repoPath}`} group={item} expanded={expanded} onToggle={() => toggleGroup(groupKey!)} onDrill={(repoPath) => pushDrill({ ...scope, grouping: 'time', pathPrefix: repoPath })} onUndo={(row, strategy) => setUndoDialog({ row, strategy })} />
                      : <OtherRow key={item.id} item={item} />;
            })}
            {showLoadOlder && (
              <button type="button" className="ui-btn ui-btn-ghost mx-auto flex text-[11px]" disabled={loading} onClick={() => void loadOlderActivity(workspaceId)}>
                {loading ? 'Loading older activity...' : 'Load older activity'}
              </button>
            )}
            {showTerminalNotice && <p className="text-center text-[11px] text-gray-500">More history is available — switch to Flat to continue.</p>}
          </div>
        )}
      </div>
      {undoDialog && <RestoreDialog workspaceId={workspaceId} agentId={undoDialog.row.agentId ?? ''} turn={asCheckpointTurn(undoDialog.row)} mode="revert" paths={undoDialog.row.witnessedPaths.map((path) => path.repoPath)} initialStrategy={undoDialog.strategy} onClose={() => setUndoDialog(null)} onDone={() => void loadActivity(workspaceId, useDashboardStore.getState().activityScope, false)} />}
    </section>
  );
}
