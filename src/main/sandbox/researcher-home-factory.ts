import path from 'path';
import type { AgentProvider, AgentRoleLane } from '../../shared/types';
import {
  resolveProviderRedirectAdapter,
  type DiscoveryResolverShape,
} from './provider-redirect-adapters';

export type ResearcherLaunchRedirect =
  | { kind: 'env'; name: string; value: string }
  | { kind: 'argv'; argument: string };

export interface ResearcherSandboxHome {
  researcherSandboxHomePath: string;
  launchRedirect: ResearcherLaunchRedirect;
  discoveryLocation: {
    providerStateRoot: string;
    resolver: DiscoveryResolverShape;
  };
}

export interface ResolveResearcherSandboxHomeInput {
  roleLane: AgentRoleLane;
  workspaceStateRoot: string;
  agentId: string;
  provider: AgentProvider;
}

function assertCanonicalInputs(workspaceStateRoot: string, agentId: string): void {
  if (!path.win32.isAbsolute(workspaceStateRoot) && !path.posix.isAbsolute(workspaceStateRoot)) {
    throw new Error('Researcher sandbox workspace state root must be absolute');
  }
  if (!agentId || agentId === '.' || agentId === '..' || /[\\/]/.test(agentId)) {
    throw new Error('Researcher sandbox agent id must be one path segment');
  }
}

/**
 * The sole researcher-lane construction seam. The home identity is derived,
 * never stored: its path depends only on the workspace state root and agent id.
 */
export function resolveResearcherSandboxHome(
  input: ResolveResearcherSandboxHomeInput,
): ResearcherSandboxHome | null {
  if (input.roleLane !== 'researcher') return null;

  assertCanonicalInputs(input.workspaceStateRoot, input.agentId);
  const adapter = resolveProviderRedirectAdapter(input.provider);
  if ('kind' in adapter) {
    throw new Error(`Researcher sandbox provider '${input.provider}' is unsupported: no adapter entry`);
  }
  if (adapter.support.implementation !== 'active') {
    throw new Error(
      `Researcher sandbox provider '${input.provider}' is ${adapter.support.verdict}`,
    );
  }

  // On Windows, win32.isAbsolute('/home/...') is also true. Select by syntax
  // so a WSL root is never reinterpreted relative to the host drive.
  const pathApi = input.workspaceStateRoot.startsWith('/') ? path.posix : path.win32;
  const researcherSandboxHomePath = pathApi.join(
    pathApi.resolve(input.workspaceStateRoot),
    'agent-homes',
    input.agentId,
  );
  const launchRedirect: ResearcherLaunchRedirect = adapter.redirect.kind === 'env'
    ? {
        kind: 'env',
        name: adapter.redirect.name,
        value: researcherSandboxHomePath,
      }
    : {
        kind: 'argv',
        argument: adapter.redirect.argumentShape.replace('<path>', researcherSandboxHomePath),
      };

  return {
    researcherSandboxHomePath,
    launchRedirect,
    discoveryLocation: {
      providerStateRoot: researcherSandboxHomePath,
      resolver: adapter.discovery,
    },
  };
}
