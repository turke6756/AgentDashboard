import { useEffect, useSyncExternalStore } from 'react';
import type { ScheduleSummary } from '../../../shared/schedule-types';

type WorkspaceScheduleState = {
  summaries: Map<string, ScheduleSummary>;
  listeners: Set<() => void>;
  hydratePromise: Promise<void> | null;
  pendingPushes: Map<string, ScheduleSummary | null>;
};

const workspaces = new Map<string, WorkspaceScheduleState>();
let removeChangedListener: (() => void) | null = null;

function stateFor(workspaceId: string): WorkspaceScheduleState {
  let state = workspaces.get(workspaceId);
  if (!state) {
    state = { summaries: new Map(), listeners: new Set(), hydratePromise: null, pendingPushes: new Map() };
    workspaces.set(workspaceId, state);
  }
  return state;
}

function emit(state: WorkspaceScheduleState): void {
  for (const listener of state.listeners) listener();
}

function ensurePushListener(): void {
  if (removeChangedListener) return;
  const scheduleApi = window.api?.schedule;
  if (!scheduleApi) return;
  removeChangedListener = scheduleApi.onChanged(({ agentId, scheduleSummary }) => {
    for (const state of workspaces.values()) {
      state.pendingPushes.set(agentId, scheduleSummary);
      if (scheduleSummary) state.summaries.set(agentId, scheduleSummary);
      else state.summaries.delete(agentId);
      emit(state);
    }
  });
}

export function hydrateSchedules(workspaceId: string): Promise<void> {
  const state = stateFor(workspaceId);
  ensurePushListener();
  if (!state.hydratePromise) {
    const scheduleApi = window.api?.schedule;
    if (!scheduleApi) return Promise.resolve();
    state.hydratePromise = scheduleApi.hydrate(workspaceId).then((summaries) => {
      state.summaries = new Map(summaries.map((summary) => [summary.agentId, summary]));
      for (const [agentId, summary] of state.pendingPushes) {
        if (summary) state.summaries.set(agentId, summary);
        else state.summaries.delete(agentId);
      }
      emit(state);
    });
  }
  return state.hydratePromise;
}

export function useScheduleSummary(workspaceId: string, agentId: string): ScheduleSummary | null {
  const state = stateFor(workspaceId);
  useEffect(() => { void hydrateSchedules(workspaceId); }, [workspaceId]);
  return useSyncExternalStore(
    (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    () => state.summaries.get(agentId) ?? null,
    () => null,
  );
}

export function resetScheduleStoreForTests(): void {
  removeChangedListener?.();
  removeChangedListener = null;
  workspaces.clear();
}
