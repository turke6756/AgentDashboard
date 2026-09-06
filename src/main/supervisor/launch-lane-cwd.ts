import path from 'path';
import type { AgentProvider, PathType } from '../../shared/types';

export interface ResolveLaneCwdOptions {
  workspaceRoot: string;
  activityRoot?: string | null;
  explicitCwd?: string | null;
  stateDirName: string;
  pathType: PathType;
  provider: AgentProvider;
  persona?: string | null;
  isSupervisor?: boolean;
  isResearcher?: boolean;
  isWorkerLane?: boolean;
}

function normalizeLaunchPath(value: string, pathType: PathType): string {
  return pathType === 'windows'
    ? path.resolve(value).toLowerCase().replace(/[\\/]+$/, '')
    : value.replace(/\/+$/, '');
}

function joinLaunchPath(pathType: PathType, root: string, ...parts: string[]): string {
  return pathType === 'windows' ? path.join(root, ...parts) : [root, ...parts].join('/');
}

function isAtOrUnder(candidate: string, root: string, separator: string): boolean {
  return candidate === root || candidate.startsWith(root + separator);
}

export function assertLaneLaunchCwd(options: {
  agentCwd: string;
  laneRoot: string;
  stateDirName: string;
  pathType: PathType;
}): void {
  const { agentCwd, laneRoot, stateDirName, pathType } = options;
  const separator = pathType === 'windows' ? path.sep : '/';
  const normCwd = normalizeLaunchPath(agentCwd, pathType);
  const normLaneStateRoot = normalizeLaunchPath(
    joinLaunchPath(pathType, laneRoot, stateDirName),
    pathType,
  );
  if (!normCwd.startsWith(normLaneStateRoot + separator)) {
    throw new Error(
      `lane launch cwd '${agentCwd}' is not a ${stateDirName} lane folder; refusing hookless launch`,
    );
  }
}

/** Resolve the cwd for every provider-native lane before process creation. */
export function resolveLaneCwd(options: ResolveLaneCwdOptions): string {
  const {
    workspaceRoot, activityRoot, explicitCwd, stateDirName, pathType, provider,
    persona, isSupervisor, isResearcher, isWorkerLane,
  } = options;
  const separator = pathType === 'windows' ? path.sep : '/';
  const normWorkspaceRoot = normalizeLaunchPath(workspaceRoot, pathType);
  const effectiveActivityRoot = activityRoot || workspaceRoot;
  const normActivityRoot = normalizeLaunchPath(effectiveActivityRoot, pathType);
  const normExplicitCwd = explicitCwd ? normalizeLaunchPath(explicitCwd, pathType) : null;
  const laneClassed = !!(persona || isSupervisor || isResearcher || isWorkerLane);
  const shouldDeriveLane = laneClassed && (!explicitCwd
    || normExplicitCwd === normWorkspaceRoot
    || normExplicitCwd === normActivityRoot);

  let agentCwd = explicitCwd || workspaceRoot;
  if (shouldDeriveLane && persona) {
    agentCwd = joinLaunchPath(pathType, effectiveActivityRoot, stateDirName, 'agents', persona);
  } else if (shouldDeriveLane && isSupervisor) {
    agentCwd = joinLaunchPath(pathType, effectiveActivityRoot, stateDirName, 'supervisor', provider);
  } else if (shouldDeriveLane && isResearcher) {
    agentCwd = joinLaunchPath(pathType, effectiveActivityRoot, stateDirName, 'researcher', provider);
  } else if (shouldDeriveLane && isWorkerLane) {
    agentCwd = joinLaunchPath(pathType, effectiveActivityRoot, stateDirName, 'workers', provider);
  }

  const normCwd = normalizeLaunchPath(agentCwd, pathType);
  if (!isAtOrUnder(normCwd, normWorkspaceRoot, separator)
      && !isAtOrUnder(normCwd, normActivityRoot, separator)) {
    throw new Error(`agentCwd '${agentCwd}' resolves outside workspace root '${workspaceRoot}'`);
  }

  if (laneClassed) {
    assertLaneLaunchCwd({ agentCwd, laneRoot: effectiveActivityRoot, stateDirName, pathType });
  }

  return agentCwd;
}
