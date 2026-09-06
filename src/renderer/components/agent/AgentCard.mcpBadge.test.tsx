// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentCard from './AgentCard';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { Agent } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root | null;

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'codex-degraded', workspaceId: 'ws', title: 'Codex worker', slug: 'codex-worker',
    roleDescription: '', workingDirectory: 'C:/ws', command: 'codex', provider: 'codex',
    isSupervisor: false, isSupervised: true, isWorker: true, isResearcher: false,
    tmuxSessionName: null, autoRestartEnabled: false, resumeSessionId: null,
    status: 'launching', ownerAgentId: null, restartCount: 0, createdAt: '2026-08-15 10:00:00',
    ...over,
  } as Agent;
}

async function render(a: Agent): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<AgentCard agent={a} />);
  });
}

function mcpBadge(): HTMLElement | null {
  return Array.from(container.querySelectorAll('span')).find(
    (span) => (span.textContent ?? '').trim() === 'MCP OFF',
  ) ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  (window as any).api = {
    agents: {
      getContextStats: vi.fn(async () => null),
      updateSupervised: vi.fn(async () => {}),
      stop: vi.fn(async () => ({ items: [] })),
    },
  };
  useDashboardStore.setState({ agents: [], selectedAgentId: null } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('AgentCard dashboard MCP delivery badge', () => {
  it('shows a persistent MCP OFF warning alongside launching status when delivery degraded', async () => {
    const message = 'Codex is launching without dashboard tools. Install the official Windows build.';
    await render(agent({ dashboardMcpStatus: 'degraded', dashboardMcpMessage: message }));
    const badge = mcpBadge();
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute('title')).toBe(message);
    expect(container.textContent?.toLowerCase()).toContain('starting');
  });

  it('does not show MCP OFF when dashboard MCP delivery is available or unknown', async () => {
    await render(agent({ dashboardMcpStatus: 'available' }));
    expect(mcpBadge()).toBeNull();
    await act(async () => {
      root!.render(<AgentCard agent={agent({ dashboardMcpStatus: 'unknown' })} />);
    });
    expect(mcpBadge()).toBeNull();
  });
  it('shows no badge for an available Grok worker', async () => {
    await render(agent({ provider: 'grok', command: 'grok', dashboardMcpStatus: 'available' }));
    expect(mcpBadge()).toBeNull();
  });

  it('shows the Grok degraded reason in the badge tooltip', async () => {
    const message = 'Grok worker cwd is not trusted for project MCP discovery.';
    await render(agent({ provider: 'grok', command: 'grok', dashboardMcpStatus: 'degraded', dashboardMcpMessage: message }));
    expect(mcpBadge()).toBeTruthy();
    expect(mcpBadge()?.getAttribute('title')).toBe(message);
  });

  it('shows the Antigravity degraded reason in the badge tooltip', async () => {
    const message = 'Antigravity dashboard MCP is unavailable for this launch.';
    await render(agent({ provider: 'agy', command: 'agy', dashboardMcpStatus: 'degraded', dashboardMcpMessage: message }));
    expect(mcpBadge()).toBeTruthy();
    expect(mcpBadge()?.getAttribute('title')).toBe(message);
  });

});
