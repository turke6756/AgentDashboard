import React, { useEffect, useMemo, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ActivityHeartbeatSnapshot, ActivityItem, ActivityPage } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

export const RENDERER_HEARTBEAT_STALE_MS = 20_000;

export type ShieldState = 'protected' | 'limited' | 'not-protected';
export interface ShieldView { state: ShieldState; copy: string; }

function turnRows(items: ActivityItem[]) {
  return items.flatMap((item) => item.kind === 'turn' ? [item] : item.kind === 'plan-group' ? item.members : []);
}

function activityObservedAfter(page: ActivityPage | null, timestamp: number): boolean {
  if (!page) return false;
  return page.items.some((item) => {
    if (item.kind === 'turn') return (item.startedAt ?? item.endedAt ?? 0) > timestamp;
    if (item.kind === 'plan-group') return item.members.some((row) => (row.startedAt ?? row.endedAt ?? 0) > timestamp);
    if (item.kind === 'tool-unjoined') return item.endedAt > timestamp;
    return false;
  });
}

function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
}

export function deriveShieldView(input: {
  heartbeat: ActivityHeartbeatSnapshot | null;
  page: ActivityPage | null;
  lastHeartbeatOkAt: number | null;
  degradedStreak: number;
  now: number;
}): ShieldView {
  const { heartbeat, page, lastHeartbeatOkAt, degradedStreak, now } = input;
  if (lastHeartbeatOkAt !== null && now - lastHeartbeatOkAt > RENDERER_HEARTBEAT_STALE_MS) {
    return { state: 'not-protected', copy: 'Dashboard cannot confirm protection — the checkpoint service did not respond.' };
  }
  if (!heartbeat || lastHeartbeatOkAt === null) {
    return { state: 'limited', copy: 'Protection starting' };
  }

  const covered = page?.pageCounts.turnCount ?? 0;
  if (heartbeat.serverState === 'protected' && covered > 0) {
    const verifiedAt = heartbeat.latestClosedAfterVerification?.verifiedAt ?? heartbeat.serverNow;
    return {
      state: 'protected',
      copy: `Protected — last snapshot ${ageLabel(Math.max(0, heartbeat.serverNow - verifiedAt))} · ${covered} turns covered`,
    };
  }
  if (heartbeat.serverState === 'idle-but-healthy' || (heartbeat.serverState === 'protected' && covered === 0)) {
    return { state: 'limited', copy: 'Protection limited — ready; no restore snapshots yet.' };
  }
  if (heartbeat.serverState === 'starting') return { state: 'limited', copy: 'Protection starting' };
  if (heartbeat.serverState === 'capture-in-progress') {
    return { state: 'limited', copy: 'Protection limited — checking the current restore snapshot.' };
  }

  const engineDead = heartbeat.engine === 'failed'
    || heartbeat.engine === 'absent'
    || heartbeat.reason === 'engine-bootstrap-stale';
  const red = heartbeat.serverState === 'silently-wedged' || engineDead || degradedStreak >= 3;
  if (!red) {
    return {
      state: 'limited',
      copy: `Protection limited — ${page?.pageCounts.noCheckpointCount ?? 0} recent turns have no restore point`,
    };
  }

  const observed = activityObservedAfter(page, heartbeat.engineChangedAt);
  if ((heartbeat.engine === 'failed' || heartbeat.reason === 'engine-bootstrap-stale') && !observed) {
    return { state: 'not-protected', copy: 'Restore snapshots are unavailable — checkpoint engine did not start.' };
  }
  if (observed) {
    return { state: 'not-protected', copy: 'Not protected — activity is being recorded, but restore snapshots are unavailable.' };
  }
  return { state: 'not-protected', copy: 'Not protected — restore snapshots are unavailable.' };
}

export default function ActivityShield(): React.ReactElement | null {
  const workspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const heartbeat = useDashboardStore((state) => state.activityHeartbeat);
  const page = useDashboardStore((state) => state.activityPage);
  const lastHeartbeatOkAt = useDashboardStore((state) => state.lastHeartbeatOkAt);
  const degradedStreak = useDashboardStore((state) => state.activityDegradedStreak);
  const loadActivity = useDashboardStore((state) => state.loadActivity);
  const subscribeActivity = useDashboardStore((state) => state.subscribeActivity);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!workspaceId || !window.api.activity) return;
    void loadActivity(workspaceId, {}, false);
    const unsubscribe = subscribeActivity(workspaceId);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { unsubscribe(); window.clearInterval(clock); };
  }, [loadActivity, subscribeActivity, workspaceId]);

  const view = useMemo(() => deriveShieldView({ heartbeat, page, lastHeartbeatOkAt, degradedStreak, now }),
    [degradedStreak, heartbeat, lastHeartbeatOkAt, now, page]);
  if (!workspaceId) return null;
  const Icon = view.state === 'protected' ? ShieldCheck : view.state === 'limited' ? Shield : ShieldAlert;
  const tone = view.state === 'protected' ? 'text-gray-500' : view.state === 'limited' ? 'text-accent-orange' : 'text-accent-red';
  const rows = page ? turnRows(page.items) : [];

  return (
    <div className="relative app-no-drag">
      <button
        type="button"
        aria-label={view.copy}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`h-7 px-2 flex items-center gap-1.5 rounded-sm hover:bg-white/5 ${tone}`}
      >
        <Icon className="w-3.5 h-3.5" />
        <span className="max-w-56 truncate">{view.state === 'protected' ? 'Protected' : view.state === 'limited' ? 'Protection limited' : 'Not protected'}</span>
      </button>
      {open && (
        <div role="status" className="ui-card absolute right-0 top-full mt-1 z-50 w-96 p-3 text-[12px]">
          <p className={tone}>{view.copy}</p>
          <p className="mt-2 text-gray-500">
            {rows.length} turns · {rows.filter((row) => row.undo.state === 'restorable').length} restorable · {page?.pageCounts.noCheckpointCount ?? 0} without restore points
          </p>
          <p className="mt-2 text-[11px] text-gray-600">Protected means a restore point exists; it does not mean the work is correct.</p>
        </div>
      )}
    </div>
  );
}
