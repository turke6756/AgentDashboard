// @vitest-environment jsdom
//
// WP-H1 — the workspace-level memory warning banner (+ the useMemoryReview
// fetch it owns).
//
// Acceptance:
//   1. pulls the summary for the selected workspace on mount and shows the
//      "N entries pending review, cap at P%" headline;
//   2. renders NOTHING when the queue + index state are clean (no signal);
//   3. a hard-invalid / runtime state renders the SEVERE (red) styling;
//   4. "Details" expands the review panel; "Dismiss" hides the banner;
//   5. switching workspace re-pulls and the LATE arrival of an old workspace's
//      response never lands (stale-guard);
//   6. no workspace selected → no fetch, nothing rendered.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MemoryWarningBanner from './MemoryWarningBanner';
import type { MemoryJanitorDispatchDto, MemoryReviewSummaryDto } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root;

function summary(over: Partial<MemoryReviewSummaryDto> = {}): MemoryReviewSummaryDto {
  return {
    pendingCount: 0,
    capPressure: false,
    capPercent: null,
    hardInvalid: false,
    lastRuntimeError: null,
    lastRuntimeErrorAt: null,
    items: [],
    ...over,
  };
}

const listReview = vi.fn<(ws: string) => Promise<MemoryReviewSummaryDto>>();
const dispatchJanitor = vi.fn<(ws: string) => Promise<MemoryJanitorDispatchDto>>();

function installApi() {
  (window as any).api = { memoryReview: { listReview, dispatchJanitor } };
}

async function render(workspaceId: string | null) {
  await act(async () => {
    root = createRoot(container);
    root.render(<MemoryWarningBanner workspaceId={workspaceId} />);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function rerender(workspaceId: string | null) {
  await act(async () => { root.render(<MemoryWarningBanner workspaceId={workspaceId} />); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  listReview.mockReset();
  dispatchJanitor.mockReset();
  installApi();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

describe('MemoryWarningBanner', () => {
  it('pulls on mount and shows the pending-review + cap headline', async () => {
    listReview.mockResolvedValue(summary({ pendingCount: 4, capPressure: true, capPercent: 82 }));
    await render('ws-1');
    expect(listReview).toHaveBeenCalledWith('ws-1');
    const text = container.textContent ?? '';
    expect(text).toContain('Memory index: 4 entries pending review');
    expect(text).toContain('cap at 82%');
  });

  it('renders nothing on a clean workspace', async () => {
    listReview.mockResolvedValue(summary());
    await render('ws-1');
    expect(container.textContent).toBe('');
  });

  it('renders nothing while no workspace is selected — and does not fetch', async () => {
    await render(null);
    expect(listReview).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('uses severe (red) styling for a hard-invalid index', async () => {
    listReview.mockResolvedValue(summary({ pendingCount: 1, hardInvalid: true }));
    await render('ws-1');
    const banner = container.querySelector('[data-testid="memory-warning-banner"]');
    expect(banner?.innerHTML).toContain('accent-red');
    expect(banner?.innerHTML).not.toContain('accent-yellow');
  });

  it('shows a runtime-error-only signal even with an empty queue', async () => {
    listReview.mockResolvedValue(summary({ pendingCount: 0, lastRuntimeError: 'boom' }));
    await render('ws-1');
    expect(container.textContent ?? '').toContain('last read/parse failed');
  });

  it('renders the janitor control and dispatches the current workspace exactly once', async () => {
    listReview.mockResolvedValue(summary({ pendingCount: 1 }));
    let resolveDispatch!: (result: MemoryJanitorDispatchDto) => void;
    dispatchJanitor.mockImplementation(() => new Promise((resolve) => { resolveDispatch = resolve; }));
    await render('ws-1');

    const dispatchButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Dispatch janitor');
    expect(dispatchButton).toBeTruthy();
    await click(dispatchButton);

    expect(dispatchJanitor).toHaveBeenCalledTimes(1);
    expect(dispatchJanitor).toHaveBeenCalledWith('ws-1');
    expect((dispatchButton as HTMLButtonElement).disabled).toBe(true);
    expect(dispatchButton?.textContent).toBe('Dispatching…');

    await act(async () => {
      resolveDispatch({ ok: true, agentId: 'memory-janitor-7', brief: 'clean up' });
      await Promise.resolve();
    });
    expect(container.textContent ?? '').toContain('Janitor dispatched: memory-janitor-7');
    expect((dispatchButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a dispatch failure inline and keeps the banner visible', async () => {
    listReview.mockResolvedValue(summary({ pendingCount: 1 }));
    dispatchJanitor.mockRejectedValue(new Error('launch unavailable'));
    await render('ws-1');

    const dispatchButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Dispatch janitor');
    await click(dispatchButton);

    expect(container.querySelector('[data-testid="memory-warning-banner"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Failed to dispatch janitor: launch unavailable');
    expect((dispatchButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps a renderer caller for the dispatchJanitor bridge', () => {
    const modulePath = resolve(process.cwd(), 'src/renderer/components/memory/MemoryWarningBanner.tsx');
    const source = readFileSync(modulePath, 'utf8');
    expect(source).toMatch(/window\.api\.memoryReview\.dispatchJanitor\(workspaceId\)/);
  });

  it('Details expands the review panel; Dismiss hides the banner', async () => {
    listReview.mockResolvedValue(summary({
      pendingCount: 1,
      items: [{ findingId: 'f', kind: 'stale-active', entryId: 'mb-2026-06-01-a', reason: 'untouched', exitCondition: null, firstSeen: 't', lastSeen: 't' }],
    }));
    await render('ws-1');
    expect(container.querySelector('[data-testid="memory-review-panel"]')).toBeNull();

    const detailsBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Details');
    await click(detailsBtn);
    expect(container.querySelector('[data-testid="memory-review-panel"]')).not.toBeNull();
    expect(container.textContent ?? '').toContain('Stale active entry');

    const dismiss = container.querySelector('button[aria-label="Dismiss"]');
    await click(dismiss);
    expect(container.textContent).toBe('');
  });

  it('re-pulls on workspace switch and never lands the stale response', async () => {
    // ws-1 resolves LATE (after the switch); ws-2 resolves immediately.
    let resolveWs1!: (s: MemoryReviewSummaryDto) => void;
    listReview.mockImplementation((ws: string) =>
      ws === 'ws-1'
        ? new Promise<MemoryReviewSummaryDto>((res) => { resolveWs1 = res; })
        : Promise.resolve(summary({ pendingCount: 2, capPercent: 50 })));

    await render('ws-1');
    await rerender('ws-2');
    expect(listReview).toHaveBeenCalledWith('ws-2');
    expect(container.textContent ?? '').toContain('Memory index: 2 entries pending review');

    // The stale ws-1 response arrives now — it must be discarded, not shown.
    await act(async () => { resolveWs1(summary({ pendingCount: 99 })); await Promise.resolve(); });
    expect(container.textContent ?? '').not.toContain('99');
    expect(container.textContent ?? '').toContain('2 entries pending review');
  });
});
