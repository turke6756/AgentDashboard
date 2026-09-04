// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Workspace } from '../../../shared/types';
import AgentLaunchDialog from './AgentLaunchDialog';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const storeState = {
  agents: [],
  wslEnabled: false,
  loadAgents: vi.fn().mockResolvedValue(undefined),
  checkHealth: vi.fn().mockResolvedValue(undefined),
  openPrerequisitesDialog: vi.fn(),
};

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
}));
vi.mock('../browser/useBrowserSuspension', () => ({ useBrowserSuspension: () => undefined }));

const workspace: Workspace = {
  id: 'wsl-workspace', title: 'Linux Workspace', path: '/home/test/project', pathType: 'wsl',
  description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
};

describe('AgentLaunchDialog WSL disabled guard', () => {
  let container: HTMLDivElement;
  let root: Root;
  let launch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    launch = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        templates: { list: vi.fn().mockResolvedValue([]) },
        personas: { list: vi.fn().mockResolvedValue([]) },
        agents: { checkAgentMd: vi.fn(), launch },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<AgentLaunchDialog workspace={workspace} onClose={vi.fn()} />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('shows an inline notice and disables launch without probing WSL workspace files', () => {
    expect(container.textContent).toContain('WSL is disabled. Turn it on in the sidebar status bar');
    const launchButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Launch') as HTMLButtonElement;
    expect(launchButton.disabled).toBe(true);
    expect(window.api.personas.list).not.toHaveBeenCalled();
    expect(window.api.agents.checkAgentMd).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
