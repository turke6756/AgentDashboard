// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentCard from './AgentCard';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, AgentPlanBadge } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'a1', workspaceId: 'ws', title: 'Alpha', slug: 'alpha', roleDescription: '',
    workingDirectory: 'C:/ws', command: 'claude', provider: 'claude', isSupervisor: false,
    isSupervised: false, isWorker: false, isResearcher: false, tmuxSessionName: null,
    autoRestartEnabled: false, resumeSessionId: null, status: 'idle', ownerAgentId: null,
    restartCount: 0, createdAt: '2026-07-19 10:00:00', ...over,
  } as Agent;
}

async function render(a: Agent) {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentCard agent={a} />);
  });
}

async function loadBadges(...artifacts: string[]) {
  const destinations = artifacts.map((artifact, index) => ({
    kind: 'promoted-plan' as const,
    planId: `plan-row-${index}`,
    planArtifactId: artifact,
    title: `Plan ${index + 1}`,
    relationships: ['carrying' as const],
  })) as unknown as AgentPlanBadge;
  (window as any).api.agents.getAgentPlanBadgeSummary = vi.fn(async () => ({ a1: destinations }));
  await act(async () => {
    await useDashboardStore.getState().loadAgentPlanBadges('ws');
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = { agents: { getContextStats: vi.fn(async () => null) } };
  useDashboardStore.setState({ selectedWorkspaceId: 'ws', agents: [], selectedAgentId: null, agentPlanBadges: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('AgentCard — plan badges', () => {
  it('renders carrying from the production destination-array loader with no authored mark', async () => {
    await loadBadges('plan_f18d7c9e');
    await render(agent());
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')?.textContent)
      .toBe('Carrying: plan_f18d7c9e');
  });

  it('renders no placeholder when the agent has neither role', async () => {
    await render(agent());
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')).toBeNull();
    expect(container.querySelector('[aria-label="Plan roles"]')).toBeNull();
  });

  it('uses a carrying count for multiple destination arrays', async () => {
    await loadBadges('plan_c', 'plan_d', 'plan_e');
    await render(agent());
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')?.textContent)
      .toBe('Carrying: 3 plans');
  });
});
