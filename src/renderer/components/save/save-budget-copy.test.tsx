// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderBudgetStopBanner } from './SaveCard';
import { SAVE_CARD_LONGER_SCAN_BUDGET_MS } from '../../../shared/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const partial = (reasons: Array<'deadline' | 'entries' | 'status-bytes' | 'path-bytes'>) => ({
  scope: 'global' as const,
  inventory: {
    completeness: 'partial' as const,
    dirtyCorpusStopReasons: reasons,
    observedEntries: 1234,
    observedStatusBytes: 10,
    observedPathBytes: 20,
    totalsExact: false,
  },
  protection: {
    assessment: { evaluation: 'complete' as const, rung: 'unprotected' as const },
    checkpointStopReasons: [],
  },
});

describe('SaveCard inventory budget copy', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('REACHABILITY:budget-copy renders ran-out-of-time copy with the working longer-scan action', async () => {
    const longerScan = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<section>{renderBudgetStopBanner({
        computeState: partial(['deadline']), onLongerScan: longerScan,
      })}</section>);
    });

    expect(container.textContent).toContain('ran out of time, not space');
    expect(container.textContent).toContain('1,234 changes found so far');
    const button = container.querySelector<HTMLButtonElement>('[data-testid="save-card-longer-scan"]');
    expect(button?.disabled).toBe(false);
    await act(async () => { button!.click(); });
    expect(longerScan).toHaveBeenCalledWith(SAVE_CARD_LONGER_SCAN_BUDGET_MS);
  });

  it('keeps entry and byte stops on smaller-scope copy without the longer scan action', () => {
    const html = renderBudgetStopBanner({
      computeState: partial(['entries', 'path-bytes']), onLongerScan: vi.fn(),
    });
    expect(html).not.toBeNull();
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<section>{html}</section>); });
    expect(host.textContent).toContain('needs a smaller scope');
    expect(host.textContent).toContain('change-count budget');
    expect(host.querySelector('[data-testid="save-card-longer-scan"]')).toBeNull();
    host.remove();
  });
});
