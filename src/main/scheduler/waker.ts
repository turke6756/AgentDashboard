import type { AgentProvider, AgentStatus } from '../../shared/types';
import type { ScheduledDeliveryResult, ScheduledFiring } from './agent-scheduler';

export interface StagedFiring extends ScheduledFiring {
  onOutcome: (result: ScheduledDeliveryResult) => void;
}

export interface ScheduledFiringWakerDeps {
  getAgent(agentId: string): { provider: AgentProvider; status: AgentStatus } | null;
  stage(agentId: string, firing: StagedFiring): void;
  clearGeneration(agentId: string, generation: number): void;
  reviveAgent(agentId: string): Promise<unknown>;
}

const NON_REVIVABLE_PROVIDERS: ReadonlySet<AgentProvider> = new Set([
  'grok',
  'agy',
  'gemini',
]);

/** Stage a terminal agent's firing before revival and keep the scheduler's
 * delivery promise open until the supervisor releases that exact generation. */
export function wakeScheduledFiring(
  firing: ScheduledFiring,
  deps: ScheduledFiringWakerDeps,
): ScheduledDeliveryResult | Promise<ScheduledDeliveryResult> {
  const agent = deps.getAgent(firing.agentId);
  if (!agent) {
    firing.finalizeFailure('delivery-failed');
    return { disposition: 'held' };
  }
  if (agent.status !== 'done' && agent.status !== 'crashed') {
    return { disposition: 'held' };
  }
  if (NON_REVIVABLE_PROVIDERS.has(agent.provider)) {
    firing.finalizeFailure('provider-no-revive');
    return { disposition: 'held' };
  }

  let settle!: (result: ScheduledDeliveryResult) => void;
  const outcome = new Promise<ScheduledDeliveryResult>((resolve) => { settle = resolve; });
  deps.stage(firing.agentId, { ...firing, onOutcome: settle });
  firing.markReviving();

  let revival: Promise<unknown>;
  try {
    revival = deps.reviveAgent(firing.agentId);
  } catch {
    deps.clearGeneration(firing.agentId, firing.generation);
    firing.finalizeFailure('revive-failed');
    settle({ disposition: 'held' });
    return outcome;
  }
  void revival.catch(() => {
    deps.clearGeneration(firing.agentId, firing.generation);
    firing.finalizeFailure('revive-failed');
    settle({ disposition: 'held' });
  });
  return outcome;
}
