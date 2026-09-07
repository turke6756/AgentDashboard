// @vitest-environment jsdom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent } from '../../../shared/types';
import type { ScheduleSummary } from '../../../shared/schedule-types';
import { useDashboardStore } from '../../stores/dashboard-store';
import AgentCard from './AgentCard';
import { resetScheduleStoreForTests } from './schedule-store';

let container: HTMLDivElement;
let root: Root;
let changed: ((payload: { agentId: string; scheduleSummary: ScheduleSummary | null }) => void) | null;

const activeSummary: ScheduleSummary = {
  agentId: 'agent-1', scheduleId: 'schedule-1', lifecycle: 'active', badgeState: 'active',
  nextFireAt: Date.UTC(2026, 8, 7, 12), lastOutcome: null, revision: 1,
};

function agent(id: string): Agent {
  return {
    id, workspaceId: 'workspace-1', title: id, slug: id, roleDescription: '',
    workingDirectory: 'C:/workspace', command: 'codex', provider: 'codex',
    isSupervisor: false, isSupervised: true, isWorker: true, isResearcher: false,
    tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'idle', ownerAgentId: null, restartCount: 0, createdAt: '2026-09-06 10:00:00',
  } as Agent;
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  changed = null;
  resetScheduleStoreForTests();
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ items: [] })),
    },
    schedule: {
      hydrate: vi.fn(async () => [activeSummary]),
      get: vi.fn(async () => null),
      history: vi.fn(async () => []),
      set: vi.fn(),
      clear: vi.fn(),
      onChanged: vi.fn((callback) => { changed = callback; return vi.fn(); }),
    },
  };
  useDashboardStore.setState({ agents: [], selectedAgentId: null, workspaces: [], wslEnabled: true } as any);
});

afterEach(() => {
  act(() => root.unmount());
  resetScheduleStoreForTests();
  container.remove();
});

describe('AgentCard schedule badge', () => {
  it('hydrates once per workspace, opens the dialog through the clock, and clears on a null push', async () => {
    await act(async () => {
      root.render(<><AgentCard agent={agent('agent-1')} /><AgentCard agent={agent('agent-2')} /></>);
    });
    await flush();

    expect(window.api.schedule.hydrate).toHaveBeenCalledTimes(1);
    const badge = container.querySelector<HTMLButtonElement>('[data-testid="schedule-badge"]');
    expect(badge).toBeTruthy();
    expect(badge?.title).toContain('Schedules stop when you quit Lares.');
    expect(badge?.title).toContain('Next firing:');

    await act(async () => { badge!.click(); });
    await flush();
    expect(document.body.querySelector('[role="dialog"]'), 'REACHABILITY:cron-badge badge click must enter ScheduleDialog').toBeTruthy();

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[aria-label="Close schedule"]')!.click(); });
    act(() => changed?.({ agentId: 'agent-1', scheduleSummary: null }));
    expect(container.querySelector('[data-testid="schedule-badge"]')).toBeNull();
  });

  it('renders every summary state and opens the same dialog from the context menu', async () => {
    await act(async () => { root.render(<AgentCard agent={agent('agent-1')} />); });
    await flush();
    for (const badgeState of ['active', 'held', 'reviving', 'warn', 'paused', 'exhausted'] as const) {
      act(() => changed?.({
        agentId: 'agent-1',
        scheduleSummary: {
          ...activeSummary,
          lifecycle: badgeState === 'paused' ? 'paused' : badgeState === 'exhausted' ? 'exhausted' : 'active',
          badgeState,
          lastOutcome: badgeState === 'warn' ? 'unconfirmed' : null,
        },
      }));
      expect(container.querySelector('[data-testid="schedule-badge"]')?.getAttribute('data-schedule-state')).toBe(badgeState);
    }

    act(() => container.querySelector<HTMLElement>('.agent-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })));
    const item = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === 'Schedule…');
    expect(item).toBeTruthy();
    await act(async () => { item!.click(); });
    await flush();
    expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
  });
});
