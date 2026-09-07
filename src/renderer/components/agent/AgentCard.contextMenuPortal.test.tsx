// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent } from '../../../shared/types';
import type { ScheduleSummary } from '../../../shared/schedule-types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';
import OwnerContainerBar from './OwnerContainerBar';
import { resetScheduleStoreForTests } from './schedule-store';

let container: HTMLDivElement;
let root: Root;

const summary: ScheduleSummary = {
  agentId: 'supervisor-1',
  scheduleId: 'schedule-1',
  lifecycle: 'active',
  badgeState: 'active',
  nextFireAt: Date.UTC(2026, 8, 8, 12),
  lastOutcome: null,
  revision: 1,
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1', workspaceId: 'workspace-1', title: 'Agent', slug: 'agent', roleDescription: '',
    workingDirectory: 'C:/workspace', command: 'codex', provider: 'codex',
    isSupervisor: false, isSupervised: true, isWorker: true, isResearcher: false,
    tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'idle', ownerAgentId: null, restartCount: 0, createdAt: '2026-09-07 10:00:00',
    ...overrides,
  } as Agent;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  resetScheduleStoreForTests();
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ items: [] })),
    },
    schedule: {
      hydrate: vi.fn(async () => [summary]),
      get: vi.fn(async () => null),
      history: vi.fn(async () => []),
      set: vi.fn(),
      clear: vi.fn(),
      onChanged: vi.fn(() => vi.fn()),
    },
  };
  useDashboardStore.setState({
    agents: [], selectedAgentId: null, terminalAgentId: null, workspaces: [],
    contextStats: {}, continuationPhases: {}, agentPlanBadges: {}, wslEnabled: true,
  } as any);
});

afterEach(() => {
  act(() => root.unmount());
  resetScheduleStoreForTests();
  container.remove();
});

describe('agent context-menu portals', () => {
  it('renders the AgentCard menu directly under document.body', async () => {
    await act(async () => { root.render(<AgentCard agent={agent()} />); });
    act(() => container.querySelector<HTMLElement>('.agent-card')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 30 }),
    ));

    const menu = Array.from(document.body.querySelectorAll<HTMLElement>('.ui-menu'))
      .find((element) => element.textContent?.includes('Agent Actions'));
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);

    act(() => menu!.querySelector<HTMLElement>('.ui-menu-header')!.click());
    expect(document.body.contains(menu!)).toBe(true);
    act(() => document.body.click());
    expect(document.body.contains(menu!)).toBe(false);
  });

  it('portals the supervisor menu, exposes Schedule, and opens ScheduleDialog', async () => {
    const supervisor = agent({
      id: 'supervisor-1', title: 'Supervisor', isSupervisor: true, isWorker: false,
    });
    await act(async () => {
      root.render(
        <OwnerContainerBar
          agent={supervisor}
          childCount={2}
          expanded={true}
          onToggle={() => {}}
          depth={0}
        />,
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="schedule-badge"]')).toBeTruthy();
    act(() => container.firstElementChild!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 50 }),
    ));

    const menu = Array.from(document.body.querySelectorAll<HTMLElement>('.ui-menu'))
      .find((element) => element.textContent?.includes('Supervisor'));
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);
    const schedule = Array.from(menu!.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Schedule…');
    expect(schedule).toBeTruthy();

    await act(async () => { schedule!.click(); });
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.body.querySelector('[aria-labelledby="schedule-dialog-title"]')).toBeTruthy();
  });
});
