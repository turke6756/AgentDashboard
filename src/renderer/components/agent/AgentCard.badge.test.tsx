// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent, AgentPlanBadge } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';

let container: HTMLDivElement;
let root: Root | null;

function agent(): Agent {
  return {
    id: 'a1', workspaceId: 'ws', title: 'Alpha', slug: 'alpha', roleDescription: '',
    workingDirectory: 'C:/ws', command: 'claude', provider: 'claude', isSupervisor: false,
    isSupervised: false, isWorker: false, isResearcher: false, tmuxSessionName: null,
    autoRestartEnabled: false, resumeSessionId: null, status: 'idle', ownerAgentId: null,
    restartCount: 0, createdAt: '2026-07-19 10:00:00',
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

async function renderCard() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentCard agent={agent()} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = { agents: { getContextStats: vi.fn(async () => null) } };
  useDashboardStore.setState({ selectedWorkspaceId: 'ws', agents: [], agentPlanBadges: {} } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container.remove();
});

describe('AgentCard plan badges', () => {
  it('renders the named ownership destination with its portable code tooltip', async () => {
    useDashboardStore.setState({ agentPlanBadges: { a1: plans(1) } });
    await renderCard();
    expect(container.querySelector('[title="Plan 1 · plan_0"]')?.textContent).toContain('Plan 1');
    expect(container.textContent).not.toContain('Authored:');
  });

  it('renders no placeholder without an ownership destination', async () => {
    await renderCard();
    expect(container.querySelector('[aria-label="Owned plans"]')).toBeNull();
  });

  it('bounds visible chips at two and exposes the overflow count', async () => {
    useDashboardStore.setState({ agentPlanBadges: { a1: plans(3) } });
    await renderCard();
    expect(container.querySelectorAll('[data-testid="agent-plan-badge"]')).toHaveLength(2);
    expect(container.querySelector('[data-testid="agent-plan-overflow"]')?.textContent).toBe('+1');
  });
});
