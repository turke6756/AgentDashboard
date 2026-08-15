// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent, AgentPlanBadge } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentGrid from './AgentGrid';

const controllerProbe = vi.hoisted(() => ({ rewriteOwnerTitle: false }));
const openPlanTab = vi.fn(async () => ({ kind: 'opened-main' as const, tab: 'overview' as const }));

vi.mock('./useAgentPlanNavigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useAgentPlanNavigation')>();
  return {
    ...actual,
    useAgentPlanNavigation(destinations: Parameters<typeof actual.useAgentPlanNavigation>[0]) {
      const navigation = actual.useAgentPlanNavigation(destinations);
      if (!controllerProbe.rewriteOwnerTitle) return navigation;
      return {
        ...navigation,
        destinations: navigation.destinations.map((entry) => entry.planId === 'plan-row-2'
          ? { ...entry, title: 'Controller-provided owner title' }
          : entry),
      };
    },
  };
});

let container: HTMLDivElement;
let root: Root;

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    workspaceId: 'ws', title: over.id, slug: over.id, roleDescription: '',
    workingDirectory: 'C:/ws', command: 'claude', provider: 'claude',
    isSupervisor: false, isSupervised: false, isWorker: false, isResearcher: false,
    tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'idle', ownerAgentId: null, restartCount: 0,
    createdAt: '2026-08-15 10:00:00', ...over,
  } as Agent;
}

function destination(index: number, title: string) {
  return {
    kind: 'promoted-plan' as const,
    planId: `plan-row-${index}`,
    planArtifactId: `plan_${index.toString().padStart(8, '0')}`,
    title,
    relationships: ['carrying' as const],
  };
}

async function renderGrid() {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentGrid />);
  });
}

function childlessCard(): HTMLElement {
  const card = container.querySelector<HTMLElement>('.agent-card');
  expect(card, 'AgentCard route').toBeTruthy();
  return card!;
}

function ownerBar(): HTMLElement {
  const toggle = container.querySelector<HTMLElement>('[title="Expand owned agents"]');
  expect(toggle, 'OwnerContainerBar route').toBeTruthy();
  const bar = toggle!.closest<HTMLElement>('.relative');
  expect(bar, 'OwnerContainerBar subtree').toBeTruthy();
  return bar!;
}

beforeEach(() => {
  controllerProbe.rewriteOwnerTitle = false;
  localStorage.setItem('owner-expand:owner', '0');
  container = document.createElement('div');
  document.body.appendChild(container);
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
    },
    plans: {
      documents: vi.fn(async () => ({ tabs: [{ key: 'overview' }, { key: 'proposal' }] })),
    },
    files: {
      resolveOpenableWorkspacePath: vi.fn(async (_request: unknown) => ({ ok: true, canonicalPath: 'C:/ws/proposal.md' })),
    },
  };

  useDashboardStore.setState({
    selectedWorkspaceId: 'ws',
    agents: [
      agent({ id: 'childless', title: 'Childless badge holder' }),
      agent({ id: 'owner', title: 'Owner badge holder', isSupervisor: true }),
      agent({
        id: 'finished-child', title: 'Finished child hidden from display',
        ownerAgentId: 'owner', isWorker: true, status: 'done',
      }),
    ],
    agentPlanBadges: {
      childless: [destination(1, 'Childless destination with a deliberately long title')] as AgentPlanBadge,
      owner: [
        destination(2, 'Owner plan one'),
        destination(3, 'Owner plan two'),
        destination(4, 'Owner plan three'),
      ] as AgentPlanBadge,
    },
    selectedAgentId: null,
    deliberatingSupervisorIds: [],
    openPlanTab,
  } as any);
  openPlanTab.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem('owner-expand:owner');
});

describe('AgentGrid plan badge routing', () => {
  it('REACHABILITY:badges-both-card-routes enters the shared badges through childless and owner routes', async () => {
    await renderGrid();

    const card = childlessCard();
    expect(card.textContent).toContain('Childless badge holder');
    expect(card.querySelector('[title="Childless destination with a deliberately long title · plan_00000001"]')).toBeTruthy();

    // The only child is terminal and not mounted in the collapsed owner, but it
    // remains in the unfiltered roster that selects OwnerContainerBar routing.
    const bar = ownerBar();
    expect(bar.textContent).toContain('Owner badge holder');
    expect(container.textContent).not.toContain('Finished child hidden from display');
    expect(bar.querySelector('[title="Owner plan one · plan_00000002"]')).toBeTruthy();
    expect(bar.querySelector('[title="Owner plan two · plan_00000003"]')).toBeTruthy();
    expect(bar.querySelector('[title="Owner plan three · plan_00000004"]')).toBeNull();
    expect(bar.querySelector('[data-testid="agent-plan-overflow"]')?.textContent).toBe('+1');
  });

  it('REACHABILITY:controller-unconsumed-by-bar renders the controller-provided destinations in OwnerContainerBar', async () => {
    controllerProbe.rewriteOwnerTitle = true;
    await renderGrid();

    const bar = ownerBar();
    expect(bar.querySelector('[title="Controller-provided owner title · plan_00000002"]')).toBeTruthy();
    expect(bar.querySelector('[title="Owner plan one · plan_00000002"]')).toBeNull();
  });

  it('renders no authored mark or empty badge row', async () => {
    useDashboardStore.setState({ agentPlanBadges: {} });
    await renderGrid();

    expect(container.querySelector('[aria-label="Owned plans"]')).toBeNull();
    expect(container.textContent).not.toContain('Authored:');
  });

  it('shows exactly two chips without an overflow trigger', async () => {
    useDashboardStore.setState({
      agentPlanBadges: {
        childless: [destination(10, 'First'), destination(11, 'Second')] as AgentPlanBadge,
      },
    });
    await renderGrid();

    const card = childlessCard();
    expect(card.querySelectorAll('[data-testid="agent-plan-badge"]')).toHaveLength(2);
    expect(card.querySelector('[data-testid="agent-plan-overflow"]')).toBeNull();
  });

  it('shows +3 when five destinations overflow the two visible chips', async () => {
    useDashboardStore.setState({
      agentPlanBadges: {
        childless: Array.from({ length: 5 }, (_, index) => destination(20 + index, `Many ${index + 1}`)) as AgentPlanBadge,
      },
    });
    await renderGrid();

    const card = childlessCard();
    expect(card.querySelectorAll('[data-testid="agent-plan-badge"]')).toHaveLength(2);
    expect(card.querySelector('[data-testid="agent-plan-overflow"]')?.textContent).toBe('+3');
  });

  it('REACHABILITY:plan-menu-both-card-routes enters shared plan rows through both real surfaces', async () => {
    await renderGrid();

    await act(async () => {
      childlessCard().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });
    const childPlan = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Go to plan — Childless destination'));
    expect(childPlan).toBeTruthy();
    await act(async () => { childPlan!.click(); });
    expect(openPlanTab).toHaveBeenCalledWith('plan-row-1', expect.any(String), 'ws', { tab: 'overview' });

    await act(async () => {
      ownerBar().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
    });
    const plansRow = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Plans (3)…');
    expect(plansRow).toBeTruthy();
    await act(async () => { plansRow!.click(); });
    const ownerPlan = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Go to plan — Owner plan two');
    expect(ownerPlan).toBeTruthy();
    await act(async () => { ownerPlan!.click(); });
    expect(openPlanTab).toHaveBeenCalledWith('plan-row-3', 'Owner plan two', 'ws', { tab: 'overview' });
  });

  it('routes a promoted proposal from the real AgentCard menu', async () => {
    await renderGrid();
    await act(async () => {
      childlessCard().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });
    const proposal = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Go to proposal — Childless destination'));
    await act(async () => { proposal!.click(); });
    expect(openPlanTab).toHaveBeenCalledWith('plan-row-1', expect.any(String), 'ws', { tab: 'proposal' });
  });
});
