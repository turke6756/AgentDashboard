// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionBoardPackageTimeline } from '../../../shared/types';
import PlanPackageChecklist, { type PlanPackageChecklistRow } from './PlanPackageChecklist';

let container: HTMLDivElement;
let root: Root;

function row(over: Partial<PlanPackageChecklistRow> = {}): PlanPackageChecklistRow {
  return {
    packageId: 'wp:plan-1:wp-1',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    title: 'Package one',
    acceptanceCondition: 'Fallback outcome',
    state: 'ready',
    assigneeAgentId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    liveActivity: [],
    durableTurns: [],
    recoveryOperations: [],
    ...over,
  };
}

const synced = async (): Promise<'synced'> => 'synced';
const noTimeline = async (): Promise<MissionBoardPackageTimeline[]> => [];

async function render(
  packages: PlanPackageChecklistRow[],
  options: {
    timeline?: MissionBoardPackageTimeline[];
    projection?: 'synced' | 'invalid';
  } = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <PlanPackageChecklist
        planId="plan-1"
        listPackages={async () => packages}
        listTimeline={options.timeline ? async () => options.timeline! : noTimeline}
        inspectProjection={options.projection === 'invalid' ? async () => 'invalid' : synced}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  delete (window as unknown as { api?: unknown }).api;
});

describe('PlanPackageChecklist', () => {
  it('orders one row per package by sortOrder and renders every state glyph', async () => {
    await render([
      row({ packageId: 'archived', title: 'Archived', state: 'archived', sortOrder: 50 }),
      row({ packageId: 'done', title: 'Done', state: 'done', sortOrder: 10 }),
      row({ packageId: 'blocked', title: 'Blocked', state: 'blocked', sortOrder: 40 }),
      row({ packageId: 'ready', title: 'Ready', state: 'ready', sortOrder: 30 }),
      row({ packageId: 'executing', title: 'Executing', state: 'executing', sortOrder: 20 }),
    ]);

    const rows = [...container.querySelectorAll('[data-testid="plan-package-checklist-row"]')];
    expect(rows.map((entry) => entry.querySelector('strong')?.textContent))
      .toEqual(['Done', 'Executing', 'Ready', 'Blocked', 'Archived']);
    expect(
      rows.map((entry) => entry.querySelector('[data-testid="plan-package-checklist-glyph"]')?.textContent),
      'REACHABILITY:wp7-checklist',
    ).toEqual(['✓', '◐', '○', '▲', '⌫']);
  });

  it('enters through the production renderer transport backed by the ordered package query', async () => {
    const boardList = vi.fn(async () => [row({ packageId: 'production', title: 'Production row' })]);
    const boardTimeline = vi.fn(async () => []);
    const documents = vi.fn(async () => ({ planId: 'plan-1', warnings: [], tabs: [] }));
    (window as unknown as { api: unknown }).api = {
      plans: { boardList, boardTimeline, documents },
    };

    await act(async () => {
      root.render(<PlanPackageChecklist planId="plan-1" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(boardList).toHaveBeenCalledWith('plan-1');
    expect(boardTimeline).toHaveBeenCalledWith('plan-1');
    expect(documents).toHaveBeenCalledWith('plan-1');
    expect(container.textContent, 'REACHABILITY:wp7-checklist').toContain('Production row');
  });

  it('prefers gloss and falls back to Outcome text', async () => {
    await render([
      row({ packageId: 'gloss', gloss: 'Plain-language gloss.', outcome: 'Outcome is ignored.' }),
      row({ packageId: 'outcome', gloss: null, outcome: 'Human outcome.' }),
    ]);

    const summaries = [...container.querySelectorAll('[data-testid="plan-package-checklist-gloss"]')]
      .map((entry) => entry.textContent);
    expect(summaries).toEqual(['Plain-language gloss.', 'Human outcome.']);
  });

  it('shows the rollup and landed time from the package lifecycle timeline', async () => {
    const landedAt = Date.UTC(2026, 7, 9, 20, 15);
    await render([
      row({ packageId: 'done', state: 'done' }),
      row({ packageId: 'executing', state: 'executing' }),
      row({ packageId: 'archived', state: 'archived' }),
    ], {
      timeline: [{
        packageId: 'done',
        events: [{
          source: 'finalization', eventId: 'finish-1', packageId: 'done', occurredAt: landedAt,
          toState: 'done', actor: 'worker', packageRevision: 1, checkpointTurnId: null,
          boundaryStatus: 'ready', lifecycleStatus: 'active',
        }],
      }],
    });

    expect(container.querySelector('[data-testid="plan-package-checklist-rollup"]')?.textContent)
      .toContain('1 of 3 landed · 1 remaining · 1 archived');
    const landed = container.querySelector('[data-state="done"] [data-testid="plan-package-checklist-landed"]');
    expect(landed?.textContent).toContain('Landed');
    expect(landed?.getAttribute('datetime')).toBe(new Date(landedAt).toISOString());
  });

  it('fails closed with packaging invalid instead of rendering projected rows', async () => {
    await render([row({ title: 'Untrusted package block' })], { projection: 'invalid' });

    expect(container.querySelector('[data-testid="plan-package-checklist-invalid"]')?.textContent)
      .toMatch(/packaging invalid/i);
    expect(container.textContent).not.toContain('Untrusted package block');
    expect(container.querySelector('[data-testid="plan-package-checklist-row"]')).toBeNull();
  });
});
