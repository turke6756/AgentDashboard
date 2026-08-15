// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent, AgentPlanBadge } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from './AgentGrid';

let container: HTMLDivElement;
let root: Root | null;

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    workspaceId: 'ws', title: over.id, slug: over.id, roleDescription: '',
    workingDirectory: 'C:/ws', command: 'claude', provider: 'claude', isSupervisor: false,
    isSupervised: false, isWorker: false, isResearcher: false, tmuxSessionName: null,
    autoRestartEnabled: false, resumeSessionId: null, status: 'idle', ownerAgentId: null,
    restartCount: 0, createdAt: '2026-07-19 10:00:00', ...over,
  } as Agent;
}

function plans(count: number): AgentPlanBadge {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'promoted-plan' as const,
    planId: `plan-row-${index}`,
    planArtifactId: `plan_${index}`,
    title: `Plan ${index + 1}`,
    relationships: ['carrying' as const],
  }));
}

async function renderGrid() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentGrid />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    agents: { getContextStats: vi.fn(async () => null), updateSupervised: vi.fn(async () => {}) },
  };
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws',
    agents: [
      agent({ id: 'sup1', title: 'Supervisor', isSupervisor: true }),
      agent({ id: 'wrk1', title: 'Worker', isWorker: true, ownerAgentId: 'sup1' }),
    ],
    selectedAgentId: null,
    agentPlanBadges: {},
    deliberatingSupervisorIds: [],
  } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
});

describe('OwnerContainerBar plan badges through AgentGrid', () => {
  it('renders the same named ownership destination on the owner route', async () => {
    useDashboardStore.setState({ agentPlanBadges: { sup1: plans(1) } });
    await renderGrid();
    expect(container.querySelector('.agent-card')).toBeNull();
    expect(container.querySelector('[title="Plan 1 · plan_0"]')?.textContent).toContain('Plan 1');
  });

  it('renders no placeholder when the owner has no destination', async () => {
    await renderGrid();
    expect(container.querySelector('[aria-label="Owned plans"]')).toBeNull();
  });

  it('bounds the owner row at two chips with an overflow count', async () => {
    useDashboardStore.setState({ agentPlanBadges: { sup1: plans(3) } });
    await renderGrid();
    expect(container.querySelectorAll('[data-testid="agent-plan-badge"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="agent-plan-overflow"]')?.textContent).toBe('+1');
  });

  it('keeps a childless badge holder on AgentCard', async () => {
    useDashboardStore.setState({
      agents: [agent({ id: 'lone', title: 'Loner' })],
      agentPlanBadges: { lone: plans(1) },
    } as any);
    await renderGrid();
    expect(container.querySelector('.agent-card')).toBeTruthy();
    expect(container.querySelector('[title="Expand owned agents"]')).toBeNull();
    expect(container.querySelector('[title="Plan 1 · plan_0"]')).toBeTruthy();
  });
});
