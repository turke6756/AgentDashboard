import type { Agent, MissionBoardPackageState } from '../../shared/types';
import { TMUX_OPTION_MAX_AGE_MS } from '../../shared/constants';
import { derivePackageRollup, type PackageRollup, type PackageStateCounts } from '../../shared/package-rollup';
import type { TurnRecord } from '../database';
import { projectLiveStampedActivity } from './stamped-evidence-projection';
import type { LifecycleEventKind } from './plan-manifest';

export type PromotedPlanLifecycle =
  | 'completed'
  | 'archived'
  | 'hardening'
  | 'ready'
  | 'executing'
  | 'promoted';

export type PromotedPlanActivityTier = 'active' | 'owner-live' | 'idle';

export interface PromotedLifecycleSnapshot {
  lifecycle: PromotedPlanLifecycle;
  rollup: PackageRollup | null;
  activeVerifiedTurnCount: number;
  activityTier: PromotedPlanActivityTier;
}

export interface PromotedLifecycleInput {
  planId: string;
  runState: string | null | undefined;
  latestLifecycleKind?: LifecycleEventKind;
  responsibleSupervisorAgentId?: string | null;
  packages: ReadonlyArray<{ state: MissionBoardPackageState }>;
  turns: readonly TurnRecord[];
  liveAgents?: ReadonlyArray<Pick<Agent, 'id' | 'lastHookEventAt'>>;
  nowMs?: number;
  heartbeatStaleMs?: number;
}

const LIFECYCLES: ReadonlySet<string> = new Set(['hardening', 'ready', 'executing', 'archived']);

function lifecycleFromInput(input: PromotedLifecycleInput): PromotedPlanLifecycle {
  if (input.latestLifecycleKind === 'completed') return 'completed';
  if (input.latestLifecycleKind === 'archived') return 'archived';
  const { runState } = input;
  return runState !== null && runState !== undefined && LIFECYCLES.has(runState)
    ? runState as PromotedPlanLifecycle
    : 'promoted';
}

function rollupFromPackages(
  packages: ReadonlyArray<{ state: MissionBoardPackageState }>,
): PackageRollup | null {
  if (packages.length === 0) return null;
  const counts: PackageStateCounts = { ready: 0, executing: 0, blocked: 0, done: 0, archived: 0 };
  for (const pkg of packages) counts[pkg.state] += 1;
  return derivePackageRollup(counts);
}

export function derivePromotedLifecycle(input: PromotedLifecycleInput): PromotedLifecycleSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatStaleMs = input.heartbeatStaleMs ?? TMUX_OPTION_MAX_AGE_MS;
  const freshAgentIds = new Set((input.liveAgents ?? [])
    .filter((agent) => typeof agent.lastHookEventAt === 'number'
      && nowMs - agent.lastHookEventAt <= heartbeatStaleMs)
    .map((agent) => agent.id));
  const activeVerifiedTurnCount = projectLiveStampedActivity(input.turns)
    .filter((turn) => turn.isActive
      && turn.planId === input.planId
      && turn.agentId !== null
      && freshAgentIds.has(turn.agentId))
    .length;
  const activityTier: PromotedPlanActivityTier = activeVerifiedTurnCount > 0
    ? 'active'
    : input.responsibleSupervisorAgentId
      && freshAgentIds.has(input.responsibleSupervisorAgentId)
      ? 'owner-live'
      : 'idle';
  return {
    lifecycle: lifecycleFromInput(input),
    rollup: rollupFromPackages(input.packages),
    activeVerifiedTurnCount,
    activityTier,
  };
}
