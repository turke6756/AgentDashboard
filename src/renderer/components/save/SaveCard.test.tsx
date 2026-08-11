// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { DirtyEntry } from '../../../shared/commit-candidates';
import type { SaveCardInventoryResponse, SaveCardMemberDto, SaveIntentUnitDto } from '../../../shared/types';
import { useSaveCardStore } from '../../stores/save-card-store';
import SaveCard, { type SaveCardProps } from './SaveCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const dashboardState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  workspaces: [{ id: 'ws-1', title: 'Workspace', path: 'C:/repo', pathType: 'windows' }],
  saveCardOpenGesture: false,
  consumeSaveCardGesture: vi.fn(),
};

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector: (state: typeof dashboardState) => unknown) => selector(dashboardState),
}));

function member(entryId: string, displayPath: string): SaveCardMemberDto {
  return {
    entry: {
      entryId,
      path: { displayPath, pathBytesBase64: btoa(displayPath), utf8Clean: true },
    } as DirtyEntry,
    protection: 'unprotected' as const,
  };
}

function unit(over: Partial<SaveIntentUnitDto> = {}): SaveIntentUnitDto {
  return {
    intentId: 'intent-1', kind: 'task', title: 'Implement the intent cutover', state: 'open',
    plan: { id: 'plan-1', title: 'Save Card architecture' },
    planItem: { id: 'item-1', title: 'Cut over consumers' },
    members: [member('entry-1', 'src/intent.ts')], contributors: [],
    topologyEvidence: { componentIds: ['component-1'], pathsWithMultipleTurns: [],
      captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] } },
    concurrencyCases: [], saveability: { saveable: true }, ...over,
  };
}

function inventory(over: Partial<SaveCardInventoryResponse> = {}): SaveCardInventoryResponse {
  return {
    intentUnits: [unit()], unwitnessed: [], legacyTaskIdentityUnavailable: [],
    legacyFinalizations: [], planningActivities: [], quotaWeakening: null, ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
let getInventory: ReturnType<typeof vi.fn>;

async function renderCard(value: SaveCardInventoryResponse, props: SaveCardProps = {}): Promise<void> {
  getInventory.mockResolvedValue(value);
  await act(async () => {
    root.render(<SaveCard {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  useSaveCardStore.getState().clearInventoryCache();
  getInventory = vi.fn();
  (window as unknown as { api: unknown }).api = {
    saveCard: {
      getInventory,
      scopedRescan: vi.fn(),
      completeOnboarding: vi.fn(async () => ({ policyGeneration: 1 })),
      markDone: vi.fn(), preview: vi.fn(), sweep: vi.fn(),
      resolveAttribution: vi.fn(), adoptAllAsBaseline: vi.fn(),
    },
    demandProbe: { record: vi.fn(async () => undefined) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SaveCard intent-first rendering', () => {
  it('enters the production onboarding bridge from a main-issued inventory prompt', async () => {
    await renderCard(inventory({
      onboarding: {
        presentation: 'first-contact',
        recommendations: [
          { pathBytesBase64: btoa('node_modules/'), displayPath: 'node_modules/', countLabel: '>=5,000' },
        ],
      },
    }));
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === 'Keep everything')!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(window.api.saveCard.completeOnboarding).toHaveBeenCalledWith({
      workspaceId: 'ws-1', decision: 'keep-everything', selectedPathBytesBase64: [btoa('node_modules/')],
    });
  });

  it('offers the approved first-contact save-tracking prompt and sends selected exclusions', async () => {
    const onDecision = vi.fn(async () => undefined);
    await renderCard(inventory(), {
      onboarding: {
        presentation: 'first-contact',
        recommendations: [
          { pathBytesBase64: btoa('node_modules/'), displayPath: 'node_modules/', countLabel: '>=5,000' },
          { pathBytesBase64: btoa('.venv/'), displayPath: '.venv/', countLabel: '>=5,000' },
        ],
      },
      onOnboardingDecision: onDecision,
    });

    const prompt = container.querySelector('[data-testid="save-card-first-contact"]') as HTMLElement;
    expect(prompt.textContent).toContain('Setting up save tracking for Workspace.');
    expect(prompt.textContent).toContain('These look like build output or dependencies and are usually excluded:');
    expect(prompt.textContent).toContain('node_modules/ (>=5,000 files)');
    expect(prompt.textContent).toContain('Exclude selected');
    const boxes = prompt.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => { boxes[1].click(); });
    const exclude = [...prompt.querySelectorAll('button')]
      .find((button) => button.textContent === 'Exclude selected')!;
    await act(async () => { exclude.click(); await Promise.resolve(); });
    expect(onDecision).toHaveBeenCalledWith('exclude-selected', [btoa('node_modules/')]);
  });

  it('does not show first-contact copy for an established presentation', async () => {
    await renderCard(inventory(), {
      onboarding: {
        presentation: 'established',
        recommendations: [
          { pathBytesBase64: btoa('node_modules/'), displayPath: 'node_modules/', countLabel: '>=5000' },
        ],
      },
      onOnboardingDecision: vi.fn(),
    });
    expect(container.querySelector('[data-testid="save-card-first-contact"]')).toBeNull();
  });

  it('renders plan -> item -> intent hierarchy with one card per task intent', async () => {
    await renderCard(inventory({ intentUnits: [unit(), unit({ intentId: 'intent-2', title: 'Verify cutover' })] }));

    expect(container.querySelector('[data-testid="save-intent-hierarchy"]')?.textContent)
      .toContain('Save Card architecture');
    expect(container.querySelector('[data-testid="save-intent-plan-item"]')?.textContent)
      .toContain('Cut over consumers');
    expect(container.querySelectorAll('[data-testid="save-intent-unit"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="save-bundle"]')).toHaveLength(2);
  });

  it('keeps committed intents, unstamped turns, and legacy finalizations read-only', async () => {
    await renderCard(inventory({
      intentUnits: [unit({ state: 'committed' })],
      legacyTaskIdentityUnavailable: [member('legacy-entry', 'legacy.ts')],
      legacyFinalizations: [{ finalizationId: 'legacy-fin', packageId: 'legacy-package',
        packageRevision: 2, finalizationKind: 'plan-package', boundaryStatus: 'ready', finalizedAt: 1 }],
    }));

    expect(container.querySelector('[data-testid="legacy-task-identity-unavailable"]')?.textContent)
      .toContain('1 witnessed file');
    expect(container.querySelector('[data-testid="legacy-package-finalizations"]')?.textContent)
      .toContain('Read-only legacy history');
    expect(container.querySelector('[data-testid="save-bundle-pin"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-bundle-submit"]')).toBeNull();
  });

  it('keeps human edits unwitnessed and offers the single baseline-adoption gesture', async () => {
    await renderCard(inventory({ intentUnits: [], unwitnessed: [member('human', 'human.txt')] }));

    const pool = container.querySelector('[data-testid="unwitnessed-pool"]');
    expect(pool?.textContent).toContain('1 file');
    expect(pool?.querySelector('button')?.textContent).toContain('Adopt all as baseline');
    expect(container.querySelectorAll('[data-testid="save-intent-unit"]')).toHaveLength(0);
  });

  it('REACHABILITY:save-card-degraded-states renders lower bounds and gates mint until a complete scoped rescan', async () => {
    const partial = inventory({
      onboarding: { presentation: 'established', recommendations: [{
        pathBytesBase64: btoa('node_modules/'), displayPath: 'node_modules/', countLabel: '>=10,000',
      }] },
      computeState: {
        scope: 'global',
        inventory: {
          completeness: 'partial', dirtyCorpusStopReasons: ['entries'],
          observedEntries: 10_001, observedStatusBytes: 64, observedPathBytes: 128, totalsExact: false,
        },
        protection: { assessment: { evaluation: 'complete', rung: 'unprotected' }, checkpointStopReasons: [] },
      },
    });
    const scoped = inventory({
      computeState: {
        scope: 'scoped',
        inventory: {
          completeness: 'complete', dirtyCorpusStopReasons: [],
          observedEntries: 1, observedStatusBytes: 8, observedPathBytes: 13, totalsExact: true,
        },
        protection: { assessment: { evaluation: 'complete', rung: 'unprotected' }, checkpointStopReasons: [] },
      },
    });
    vi.mocked(window.api.saveCard.scopedRescan).mockResolvedValue(scoped);
    await renderCard(partial);

    const banner = container.querySelector('[data-testid="save-card-degraded"]') as HTMLElement;
    expect(banner.dataset.computeState).toBe('partial');
    expect(banner.textContent).toContain('at least 10,001 changes');
    expect(banner.textContent).toContain('change-count budget');
    expect(banner.textContent).toContain('Rescan node_modules/ (>=10,000)');
    expect(container.querySelector<HTMLButtonElement>('[data-testid="save-all"]')?.disabled).toBe(true);

    const rescan = [...banner.querySelectorAll('button')]
      .find((button) => button.textContent === 'Rescan src/intent.ts')!;
    await act(async () => { rescan.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(window.api.saveCard.scopedRescan).toHaveBeenCalledWith({
      workspaceId: 'ws-1', pathBytesBase64: btoa('src/intent.ts'),
    });
    expect(container.querySelector('[data-testid="save-card-degraded"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="save-all"]')?.disabled).toBe(false);
  });

  it('shows approved zero-changed protection-incomplete copy from the aggregate assessment', async () => {
    await renderCard(inventory({
      intentUnits: [],
      computeState: {
        scope: 'global',
        inventory: {
          completeness: 'complete', dirtyCorpusStopReasons: [], observedEntries: 0,
          observedStatusBytes: 0, observedPathBytes: 0, totalsExact: true,
        },
        protection: { assessment: { evaluation: 'incomplete' }, checkpointStopReasons: ['pairs'] },
      },
    }));
    const banner = container.querySelector('[data-testid="save-card-degraded"]') as HTMLElement;
    expect(banner.dataset.computeState).toBe('protection-incomplete');
    expect(banner.textContent).toContain('Lares did not modify any files, but it could not finish checking checkpoint coverage.');
    expect(banner.textContent).toContain('checkpoint membership-pair budget');
  });

  it('renders unresolved protection as unknown while preserving proven lower rungs', async () => {
    const unresolved = member('entry-unknown', 'unknown.ts');
    unresolved.protection = 'unknown';
    unresolved.protectionAssessment = { evaluation: 'incomplete' };
    const proven = member('entry-proven', 'proven.ts');
    proven.protection = 'checkpoint-protected';
    proven.protectionAssessment = { evaluation: 'incomplete', provenRung: 'checkpoint-protected' };
    await renderCard(inventory({
      intentUnits: [unit({ members: [unresolved, proven] })],
      computeState: {
        scope: 'global',
        inventory: { completeness: 'complete', dirtyCorpusStopReasons: [], observedEntries: 2,
          observedStatusBytes: 2, observedPathBytes: 2, totalsExact: true },
        protection: { assessment: { evaluation: 'incomplete' }, checkpointStopReasons: [] },
      },
    }));
    const assessments = container.querySelector('[data-testid="save-card-protection-assessments"]');
    expect(assessments?.textContent).toContain('unknown.ts: unknown');
    expect(assessments?.textContent).toContain('proven.ts: checkpoint-protected proven');
  });

  it('treats absent legacy compute evidence as complete', async () => {
    await renderCard(inventory());
    expect(container.querySelector('[data-testid="save-card-degraded"]')).toBeNull();
  });
});
