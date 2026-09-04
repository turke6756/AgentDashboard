// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import Sidebar from './Sidebar';

let container: HTMLDivElement;
let root: Root;
let mkdir: ReturnType<typeof vi.fn>;
let listDirectory: ReturnType<typeof vi.fn>;
let setWslEnabled: ReturnType<typeof vi.fn>;
let getWslEnabled: ReturnType<typeof vi.fn>;
let healthCheck: ReturnType<typeof vi.fn>;
let wslEnabledSetting: boolean;

const health = (enabled: boolean) => ({
  wslEnabled: enabled,
  wslAvailable: enabled,
  tmuxAvailable: enabled,
  claudeWindowsAvailable: true,
  claudeWslAvailable: enabled,
  wslStatus: { state: enabled ? 'running' as const : 'disabled' as const, distros: [] },
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mkdir = vi.fn().mockResolvedValue({ ok: true });
  listDirectory = vi.fn().mockResolvedValue([]);
  wslEnabledSetting = true;
  setWslEnabled = vi.fn(async (enabled: boolean) => { wslEnabledSetting = enabled; });
  getWslEnabled = vi.fn(async () => wslEnabledSetting);
  healthCheck = vi.fn(async () => health(wslEnabledSetting));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      files: { mkdir, listDirectory },
      workspaces: { openInVSCode: vi.fn() },
      system: {
        getWslEnabled,
        setWslEnabled,
        shutdownWsl: vi.fn().mockResolvedValue(undefined),
        healthCheck,
      },
    },
  });
  useDashboardStore.setState({
    workspaces: [{
      id: 'workspace-1',
      title: 'Test Workspace',
      path: 'C:\\code\\test-workspace',
      pathType: 'windows',
      description: '',
      defaultCommand: '',
      createdAt: '',
      updatedAt: '',
      lastOpenedAt: null,
    }],
    selectedWorkspaceId: 'workspace-1',
    workspaceHeat: {},
    wslEnabled: true,
    health: health(true),
    healthChecking: false,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('Sidebar workspace options', () => {
  it('toggles WSL off and dims WSL workspace rows with an explanatory title', async () => {
    useDashboardStore.setState({
      workspaces: [{
        id: 'wsl-workspace',
        title: 'Linux Workspace',
        path: '/home/test/project',
        pathType: 'wsl',
        description: '',
        defaultCommand: '',
        createdAt: '',
        updatedAt: '',
        lastOpenedAt: null,
      }],
      selectedWorkspaceId: 'wsl-workspace',
      workspaceHeat: { 'wsl-workspace': { activeCount: 1, workingCount: 1, waitingCount: 0 } },
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<Sidebar width={280} />);
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-label')).toBe('Turn WSL off');
    expect(container.textContent).toContain('WSL running');
    expect(toggle.title).toContain('will not stop 1 live WSL agent');

    await act(async () => { toggle.click(); });

    expect(setWslEnabled).toHaveBeenCalledWith(false);
    expect(container.textContent).toContain('WSL off');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const workspaceButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Linux Workspace'))!;
    expect(workspaceButton.className).toContain('opacity-40');
    expect(workspaceButton.title).toBe('WSL is disabled  turn it on in the status bar');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Shut down WSL now"]')?.disabled).toBe(true);
  });

  it('turns WSL back on, adopts persisted state, and refreshes health', async () => {
    wslEnabledSetting = false;
    useDashboardStore.setState({
      wslEnabled: false,
      health: health(false),
      healthChecking: false,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<Sidebar width={280} />);
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Turn WSL on');

    await act(async () => { toggle.click(); });

    expect(setWslEnabled).toHaveBeenCalledWith(true);
    expect(getWslEnabled).toHaveBeenCalled();
    expect(useDashboardStore.getState().wslEnabled).toBe(true);
    expect(healthCheck).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(container.textContent).toContain('WSL running');
  });

  it('does not let an older disabled health result overwrite a later enable', async () => {
    wslEnabledSetting = false;
    let resolveStaleHealth!: (value: ReturnType<typeof health>) => void;
    healthCheck
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStaleHealth = resolve; }))
      .mockImplementation(async () => health(wslEnabledSetting));
    useDashboardStore.setState({
      wslEnabled: false,
      health: health(false),
      healthChecking: false,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<Sidebar width={280} />);
    });
    let staleCheck!: Promise<void>;
    await act(async () => {
      staleCheck = useDashboardStore.getState().checkHealth();
      await Promise.resolve();
    });
    expect(healthCheck).toHaveBeenCalledTimes(1);

    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => { toggle.click(); });
    resolveStaleHealth(health(false));
    await act(async () => { await staleCheck; });

    expect(setWslEnabled).toHaveBeenCalledWith(true);
    expect(healthCheck).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().wslEnabled).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('creates a folder at the workspace root and expands its tree', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<Sidebar width={280} />);
    });

    const workspaceButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Test Workspace'))!;
    await act(async () => {
      workspaceButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    });

    const newFolderButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'New Folder...')!;
    await act(async () => newFolderButton.click());

    const input = document.body.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      valueSetter.call(input, '  root-folder  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());

    expect(mkdir).toHaveBeenCalledWith(
      'C:\\code\\test-workspace',
      'C:\\code\\test-workspace',
      'windows',
      'root-folder',
    );
    expect(listDirectory).toHaveBeenCalledWith('C:\\code\\test-workspace', 'windows');
  });
});
