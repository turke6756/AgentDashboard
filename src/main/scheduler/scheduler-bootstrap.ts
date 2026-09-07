import { AgentScheduleStore } from './agent-schedule-store';
import {
  AgentScheduler,
  type ScheduledDeliveryResult,
  type ScheduledFiring,
} from './agent-scheduler';
import type { ScheduleSummary } from '../../shared/schedule-types';

type SupervisorEvent = 'statusChanged' | 'agentDeleted';
type SupervisorListener = (event: { agentId: string }) => void;

export interface SchedulerBootstrapDeps {
  supervisor: {
    deliverScheduledFiring(firing: ScheduledFiring): ScheduledDeliveryResult | Promise<ScheduledDeliveryResult>;
    on(event: SupervisorEvent, listener: SupervisorListener): unknown;
    off(event: SupervisorEvent, listener: SupervisorListener): unknown;
    cancelStagedScheduledFiring(agentId: string): void;
  };
  app: {
    on(event: 'before-quit', listener: () => void): unknown;
  };
  getAgent(agentId: string): unknown | null;
  onSummaryChange?: (agentId: string, summary: ScheduleSummary | null) => void;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function bootstrapAgentScheduler(deps: SchedulerBootstrapDeps): AgentScheduler {
  const store = new AgentScheduleStore({
    agentExists: (agentId) => deps.getAgent(agentId) !== null,
    now: deps.now,
  });
  const scheduler = new AgentScheduler({
    store,
    deliver: (firing) => deps.supervisor.deliverScheduledFiring(firing),
    onSummaryChange: deps.onSummaryChange,
    cancelStaged: (agentId) => deps.supervisor.cancelStagedScheduledFiring(agentId),
    now: deps.now,
    setInterval: deps.setInterval,
    clearInterval: deps.clearInterval,
  });
  const releaseHeld: SupervisorListener = ({ agentId }) => scheduler.releaseHeld(agentId);
  const disposeAgent: SupervisorListener = ({ agentId }) => scheduler.disposeForAgent(agentId);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    deps.supervisor.off('statusChanged', releaseHeld);
    deps.supervisor.off('agentDeleted', disposeAgent);
    scheduler.stop();
  };

  deps.supervisor.on('statusChanged', releaseHeld);
  deps.supervisor.on('agentDeleted', disposeAgent);
  deps.app.on('before-quit', stop);
  scheduler.start();
  return scheduler;
}
