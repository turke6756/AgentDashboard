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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  mkdir = vi.fn().mockResolvedValue({ ok: true });
  listDirectory = vi.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      files: { mkdir, listDirectory },
      workspaces: { openInVSCode: vi.fn() },
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
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

describe('Sidebar workspace options', () => {
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
