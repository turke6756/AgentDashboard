// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDocumentsModel } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import PlanDocumentTabs from './PlanDocumentTabs';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const model: PlanDocumentsModel = {
  planId: 'plan-1',
  warnings: [],
  tabs: [{
    key: 'overview',
    populated: true,
    documents: [{
      ref: { source: 'folder', documentId: 'd-arc' },
      name: 'ARC.md',
      kind: 'arc',
      sizeBytes: 20,
      mtimeMs: 1,
    }],
  }],
};

describe('PlanOverviewBar through PlanDocumentTabs (WP-9)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (window as unknown as { api: unknown }).api = {
      plans: {
        documents: vi.fn(async () => model),
        readDocument: vi.fn(async () => ({
          ref: { source: 'folder', documentId: 'd-arc' },
          name: 'ARC.md',
          content: '# Technical plan\n\nPrimary markdown remains visible.',
          truncated: false,
          sizeBytes: 20,
        })),
        getOverview: vi.fn(async () => ({
          planId: 'plan-1',
          tab: 'overview',
          body: 'A plain-language explanation.',
          revision: 1,
          updatedBy: 'sup-1',
          createdAt: '2026-08-09T00:00:00Z',
          updatedAt: '2026-08-09T00:00:00Z',
        })),
        listIntents: vi.fn(async () => null),
      },
    };
    useDashboardStore.setState({ agents: [], selectedWorkspaceId: 'ws-1' } as never);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<PlanDocumentTabs planId="plan-1" />); });
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useDashboardStore.setState({ agents: [], selectedWorkspaceId: null } as never);
    vi.clearAllMocks();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('REACHABILITY:wp9-overview-bar mounts collapsed while the primary document stays visible', () => {
    const toggle = document.querySelector('[data-testid="plan-overview-toggle"]') as HTMLButtonElement;
    const content = document.getElementById('plan-overview-bar-content') as HTMLDivElement;

    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toContain('Simple overview');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content.hidden).toBe(true);
    expect(document.body.textContent).toContain('Primary markdown remains visible.');
  });

  it('expands and collapses the simple overview on click', async () => {
    const toggle = document.querySelector('[data-testid="plan-overview-toggle"]') as HTMLButtonElement;
    const content = document.getElementById('plan-overview-bar-content') as HTMLDivElement;

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
    expect(content.textContent).toContain('A plain-language explanation.');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content.hidden).toBe(true);
  });
});
