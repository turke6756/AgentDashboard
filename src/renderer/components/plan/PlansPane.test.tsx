// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDashboardStore } from '../../stores/dashboard-store';
import PlansPane from './PlansPane';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  useDashboardStore.setState({ workspaces: [], selectedWorkspaceId: null, openTabs: [], activeTabId: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('PlansPane shell', () => {
  it('reserves proposal and promoted-plan regions without surfacing history', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PlansPane />));

    expect(container.querySelector('[data-testid="plans-proposals-region"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/historic|history|legacy/i);
  });

  it('keeps Proposals visible and opens Research as a filtered Library tool tab', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(<PlansPane />));

    expect(container.querySelector('[data-testid="plans-tab-proposals"]')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="plans-proposals-region"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();

    act(() => container!.querySelector<HTMLElement>('[data-testid="plans-tab-research"]')!.click());
    expect(container.querySelector('[data-testid="plans-proposals-region"]')).not.toBeNull();
    const libraryTab = useDashboardStore.getState().openTabs.find((tab) => tab.toolId === 'library');
    expect(libraryTab?.params).toEqual({ type: 'research' });
    expect(useDashboardStore.getState().activeTabId).toBe(libraryTab?.id);
    expect(container.querySelector('[data-testid="plans-promoted-region"]')).not.toBeNull();

    act(() => container!.querySelector<HTMLElement>('[data-testid="plans-tab-proposals"]')!.click());
    expect(container.querySelector('[data-testid="plans-proposals-region"]')).not.toBeNull();
  });
});
