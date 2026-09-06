// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDashboardStore } from '../../stores/dashboard-store';
import ResearchCardGallery from './ResearchCardGallery';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const workspace = {
  id: 'ws-1', title: 'Workspace', path: 'C:\\work', pathType: 'windows' as const,
  description: '', defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const listInboxReports = vi.fn();

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ResearchCardGallery />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  listInboxReports.mockReset().mockResolvedValue([
    {
      status: 'ok', relPath: '2026-08-15-vite-stable-version.md',
      filePath: 'C:\\work\\.lares\\research\\inbox\\2026-08-15-vite-stable-version.md',
      artifactId: 'r-2026-08-15-vite-stable', topic: 'Vite stable version',
      created: '2026-08-15T12:00:00Z', summary: 'Vite remains stable.', provider: 'codex',
    },
    {
      status: 'malformed', relPath: 'historical/broken.md',
      filePath: 'C:\\work\\.lares\\research\\inbox\\historical\\broken.md',
      reason: 'Research artifact rejected: source_urls must be a non-empty list of http(s) URLs',
      recovered: { topic: 'Broken historical report' },
    },
  ]);
  (window as unknown as { api: unknown }).api = { research: { listInboxReports } };
  useDashboardStore.setState({
    workspaces: [workspace], selectedWorkspaceId: workspace.id,
    openTabs: [], activeTabId: null, fileViewerOpen: false,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ResearchCardGallery', () => {
  it('loads through the workspace-only bridge and renders ok and degraded cards without dropping either', async () => {
    await render();
    expect(listInboxReports).toHaveBeenCalledWith('ws-1');
    expect(container!.querySelectorAll('[data-testid="research-card"]')).toHaveLength(1);
    expect(container!.querySelectorAll('[data-testid="research-card-malformed"]')).toHaveLength(1);
    expect(container!.textContent).toContain('Vite stable version');
    expect(container!.textContent).toContain('Broken historical report');
    expect(container!.querySelector('[data-testid="research-malformed-reason"]')?.textContent)
      .toBe('Research artifact rejected: source_urls must be a non-empty list of http(s) URLs');
    expect([...container!.querySelectorAll('[data-testid="research-provider"]')].map((node) => node.textContent))
      .toEqual(['codex', 'unknown']);
  });

  it('renders valid reports newest-first before malformed reports', async () => {
    listInboxReports.mockResolvedValue([
      {
        status: 'malformed', relPath: '000-legacy.md', filePath: 'C:\\work\\000-legacy.md',
        reason: 'Missing frontmatter', recovered: { topic: 'Legacy malformed' },
      },
      {
        status: 'ok', relPath: 'older.md', filePath: 'C:\\work\\older.md', artifactId: 'older',
        topic: 'Older valid', created: '2026-08-01T12:00:00Z', summary: 'Older.',
      },
      {
        status: 'ok', relPath: 'newer.md', filePath: 'C:\\work\\newer.md', artifactId: 'newer',
        topic: 'Newer valid', created: '2026-09-05T12:00:00Z', summary: 'Newer.',
      },
    ]);

    await render();

    expect([...container!.querySelectorAll('article h3')].map((node) => node.textContent))
      .toEqual(['Newer valid', 'Older valid', 'Legacy malformed']);
  });

  it('opens the main-issued raw path through the existing file-viewer state', async () => {
    await render();
    const rawLinks = container!.querySelectorAll<HTMLElement>('[data-testid="research-open-raw"]');
    act(() => rawLinks[1].click());
    const state = useDashboardStore.getState();
    expect(state.fileViewerOpen).toBe(true);
    expect(state.openTabs.at(-1)?.filePath).toBe('C:\\work\\.lares\\research\\inbox\\historical\\broken.md');
  });
});
