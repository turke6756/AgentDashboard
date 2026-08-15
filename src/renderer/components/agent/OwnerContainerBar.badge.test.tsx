// @vitest-environment jsdom
//
// Plan badges on the OWNER path. AgentCard.badge.test.tsx renders AgentCard
// directly for a childless agent — production never does that for anyone who
// earns badges (supervisors own children and route through OwnerContainerBar).
// These tests go through AgentGrid so they fail if the bar loses the badges
// OR if the grid stops routing owners to the bar.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentGrid from './AgentGrid';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent, AgentPlanBadge } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    workspaceId: 'ws',
    title: over.id,
    slug: over.id,
    roleDescription: '',
    workingDirectory: 'C:/ws',
    command: 'claude',
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: false,
    isResearcher: false,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    resumeSessionId: null,
    status: 'idle',
    ownerAgentId: null,
    restartCount: 0,
    createdAt: '2026-07-19 10:00:00',
    ...over,
  } as Agent;
}

function ownerAndChild(): Agent[] {
  return [
    agent({ id: 'sup1', title: 'Supervisor', isSupervisor: true }),
    agent({ id: 'wrk1', title: 'Worker', isWorker: true, ownerAgentId: 'sup1' }),
  ];
}

async function renderGrid() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentGrid />);
  });
}

async function loadBadges(agentId: string, ...artifacts: string[]) {
  const destinations = artifacts.map((artifact, index) => ({
    kind: 'promoted-plan' as const,
    planId: `plan-row-${index}`,
    planArtifactId: artifact,
    title: `Plan ${index + 1}`,
    relationships: ['carrying' as const],
  })) as unknown as AgentPlanBadge;
  (window as any).api.agents.getAgentPlanBadgeSummary = vi.fn(async () => ({ [agentId]: destinations }));
  await act(async () => {
    await useDashboardStore.getState().loadAgentPlanBadges('ws');
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
    },
  };
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws',
    agents: ownerAndChild(),
    selectedAgentId: null,
    agentPlanBadges: {},
    deliberatingSupervisorIds: [],
  } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('OwnerContainerBar — plan badges (via AgentGrid owner routing)', () => {
  it('routes an owner to the bar and renders carrying from the production destination-array loader', async () => {
    await loadBadges('sup1', 'plan_f18d7c9e');
    await renderGrid();

    // Default owner expand is collapsed, so the child card is not mounted.
    // Zero .agent-card nodes + the collapse toggle means the owner took
    // the OwnerContainerBar branch, not AgentCard.
    expect(container.querySelector('.agent-card')).toBeNull();
    expect(container.querySelector('[title="Expand owned agents"]')).toBeTruthy();
    expect(container.textContent).toContain('1 owned');

    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')?.textContent)
      .toBe('Carrying: plan_f18d7c9e');
  });

  it('renders no placeholder when the owner has neither role', async () => {
    await renderGrid();
    expect(container.querySelector('[aria-expanded]')).toBeTruthy();
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')).toBeNull();
    expect(container.querySelector('[aria-label="Plan roles"]')).toBeNull();
  });

  it('uses a carrying count for multiple destination arrays', async () => {
    await loadBadges('sup1', 'plan_c', 'plan_d', 'plan_e');
    await renderGrid();
    expect(container.querySelector('.agent-card')).toBeNull();
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')?.textContent)
      .toBe('Carrying: 3 plans');
  });

  it('does not show a childless agent as an owner bar', async () => {
    useDashboardStore.setState({ agents: [agent({ id: 'lone', title: 'Loner' })] } as any);
    await loadBadges('lone', 'plan_x');
    await renderGrid();
    expect(container.querySelector('.agent-card')).toBeTruthy();
    expect(container.querySelector('[title="Expand owned agents"]')).toBeNull();
    expect(container.querySelector('[title="Collapse owned agents"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\d+ owned/);
    expect(container.querySelector('[data-testid="authored-plan-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="carrying-plan-badge"]')?.textContent)
      .toBe('Carrying: plan_x');
  });
});
