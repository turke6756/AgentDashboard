// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { DirtyEntry } from '../../../shared/commit-candidates';
import type { SaveCardInventoryResponse, SaveCardMemberDto, SaveIntentUnitDto } from '../../../shared/types';
import SaveCard, { composeSaveDisabledReason } from './SaveCard';
import SaveBundle from './SaveBundle';
import { useSaveCardStore } from '../../stores/save-card-store';

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

function member(id = 'entry-1'): SaveCardMemberDto {
  return { entry: { entryId: id, path: { displayPath: 'src/a.ts', pathBytesBase64: btoa('src/a.ts'), utf8Clean: true } } as DirtyEntry, protection: 'unprotected' };
}
function unit(over: Partial<SaveIntentUnitDto> = {}): SaveIntentUnitDto {
  return {
    intentId: 'intent-1', kind: 'task', title: 'Package', state: 'open', plan: null, planItem: null,
    members: [member()], contributors: [], topologyEvidence: { componentIds: ['component-1'], pathsWithMultipleTurns: [], captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] } },
    concurrencyCases: [], saveability: { saveable: true }, saveGate: { ready: true }, ...over,
  };
}
function inventory(over: Partial<SaveCardInventoryResponse> = {}): SaveCardInventoryResponse {
  return { intentUnits: [unit()], fallbackUnits: [], unwitnessed: [], legacyTaskIdentityUnavailable: [], witnessedUngroupable: [], legacyFinalizations: [], planningActivities: [], quotaWeakening: null, ...over };
}

describe('Save-card gating', () => {
  it('proves every adjacent precedence boundary in the five-position order', () => {
    const hash = { ready: false, reason: 'members-unhashed' as const, unhashedMemberCount: 2, sampleDisplayPaths: ['a'] };
    expect(composeSaveDisabledReason({ snapshotStable: false, saveable: false, saveGate: hash, snapshotRefusal: 'snapshot-stale', transient: true })).toMatch(/unstable/);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: false, saveGate: hash, snapshotRefusal: 'snapshot-stale', transient: true })).toMatch(/cannot be saved/);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: true, saveGate: hash, snapshotRefusal: 'snapshot-stale', transient: true })).toMatch(/scanned or hashed/);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: true, saveGate: { ready: true }, snapshotRefusal: 'snapshot-stale', transient: true })).toMatch(/stale/);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: true, saveGate: { ready: true }, snapshotRefusal: 'snapshot-repository-missing' })).toMatch(/repository identity is missing/);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: true, saveGate: { ready: true }, snapshotRefusal: 'snapshot-repository-missing' })).not.toMatch(/refresh/i);
    expect(composeSaveDisabledReason({ snapshotStable: true, saveable: true, saveGate: { ready: true }, snapshotRefusal: null, transient: true })).toMatch(/busy/);
  });

  it('renders the Prepare control disabled with the same reachable reason as Save', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => root.render(<SaveBundle unit={unit({ saveGate: { ready: false, reason: 'members-unhashed', unhashedMemberCount: 1, sampleDisplayPaths: ['src/a.ts'] } })} onPin={vi.fn()} pinDisabled pinReason="This package is not ready to save because 1 member has not been scanned or hashed yet." />));
    const prepare = container.querySelector('[data-testid="save-bundle-pin"]') as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    expect(container.querySelector(`#${prepare.getAttribute('aria-describedby')}`)?.textContent).toMatch(/scanned or hashed/);
    act(() => root.unmount());
  });

  it('keeps every Save control disabled during enumeration-partial', async () => {
    const getInventory = vi.fn(async () => inventory({ computeState: { scope: 'global', inventory: { completeness: 'partial', dirtyCorpusStopReasons: ['entries'], observedEntries: 1, observedStatusBytes: 1, observedPathBytes: 1, totalsExact: false }, protection: { assessment: { evaluation: 'complete', rung: 'unprotected' }, checkpointStopReasons: [] } } }));
    const container = document.createElement('div'); const root = createRoot(container);
    (window as any).api = { saveCard: { getInventory, scopedRescan: vi.fn(), markDone: vi.fn(), preview: vi.fn(), sweep: vi.fn(), completeOnboarding: vi.fn(), resolveAttribution: vi.fn(), adoptAllAsBaseline: vi.fn() }, demandProbe: { record: vi.fn() } };
    useSaveCardStore.getState().clearInventoryCache();
    await act(async () => { root.render(<SaveCard />); await Promise.resolve(); await Promise.resolve(); });
    expect((container.querySelector('[data-testid="save-bundle-pin"]') as HTMLButtonElement).disabled).toBe(true);
    const all = container.querySelector('[data-testid="save-all"]') as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    expect(container.querySelector('#save-all-reason')?.textContent).toMatch(/Review and undo now replace Save/);
    act(() => root.unmount());
  });

  it('renders assessment-unavailable as a no-bounded-action state', async () => {
    const container = document.createElement('div'); const root = createRoot(container);
    (window as any).api = { saveCard: { getInventory: vi.fn(async () => inventory({ intentUnits: [], unwitnessed: [member()], computeState: { scope: 'global', inventory: { completeness: 'complete', dirtyCorpusStopReasons: [], observedEntries: 1, observedStatusBytes: 1, observedPathBytes: 1, totalsExact: true }, protection: { assessment: { evaluation: 'incomplete' }, checkpointStopReasons: [] } } })), scopedRescan: vi.fn(), adoptAllAsBaseline: vi.fn() }, demandProbe: { record: vi.fn() } };
    useSaveCardStore.getState().clearInventoryCache();
    await act(async () => { root.render(<SaveCard />); await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toMatch(/No bounded save action is available/);
    act(() => root.unmount());
  });

  it('does not mark done or refresh when the disabled Prepare control is clicked', async () => {
    const refreshed = inventory({ intentUnits: [unit({ title: 'Replaced after refresh' })] });
    const getInventory = vi.fn()
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(refreshed);
    const markDone = vi.fn(async () => ({
      finalizationId: 'f-1', packageId: 'intent-1', finalizationKind: 'fleet-adhoc' as const,
      outcome: 'boundary-unavailable' as const, boundaryRef: null, boundaryStatus: 'unavailable' as const,
      packageRevision: 1, pinnedSelection: { selectedComponentIds: [], selectedUnattributedEntryIds: [] },
    }));
    const container = document.createElement('div'); const root = createRoot(container);
    (window as any).api = { saveCard: { getInventory, markDone, scopedRescan: vi.fn(), preview: vi.fn(), sweep: vi.fn(), completeOnboarding: vi.fn(), resolveAttribution: vi.fn(), adoptAllAsBaseline: vi.fn() }, demandProbe: { record: vi.fn() } };
    useSaveCardStore.getState().clearInventoryCache();
    await act(async () => { root.render(<SaveCard />); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { (container.querySelector('[data-testid="save-bundle-pin"]') as HTMLButtonElement).click(); await new Promise((resolve) => setTimeout(resolve, 25)); await Promise.resolve(); await Promise.resolve(); });
    expect(markDone).not.toHaveBeenCalled();
    expect(getInventory).toHaveBeenCalledTimes(1);
    expect(useSaveCardStore.getState().inventoryByWorkspace['ws-1'].inventory.intentUnits[0].title).toBe('Package');
    act(() => root.unmount());
  });
});
