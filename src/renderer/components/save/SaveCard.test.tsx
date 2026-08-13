// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { DirtyEntry } from '../../../shared/commit-candidates';
import type { SaveCardInventoryResponse, SaveCardMemberDto, SaveCardWorkerUnit, SaveIntentUnitDto } from '../../../shared/types';
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
    intentUnits: [unit()], fallbackUnits: [], unwitnessed: [],
    legacyTaskIdentityUnavailable: [], witnessedUngroupable: [],
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
  it('always renders every contributor and distinct-file shares', async () => {
    const contributor = (agentId: string, name: string, fileCount: number, fileSharePercent: number): SaveCardWorkerUnit => ({
      agentId, name, roleDescription: 'editor', kind: 'supervisor', startedAt: null, endedAt: null,
      turnCount: 1, memberEntryIds: [], fileCount, fileSharePercent,
    });
    useSaveCardStore.getState().clearInventoryCache();
    await renderCard(inventory({
      intentUnits: [unit({
        members: [member('entry-1', 'src/one.ts'), member('entry-2', 'src/two.ts'), member('entry-3', 'src/three.ts')],
        contributors: [
          contributor('supervisor-a', 'Supervisor A', 2, 67),
          contributor('supervisor-b', 'Supervisor B', 1, 33),
        ],
      })],
    }));
    const roster = container.querySelector('[data-testid="save-contributor-roster"]')!;
    expect(roster.textContent).toContain('Supervisor A: 2 of 3 files (67%)');
    expect(roster.textContent).toContain('Supervisor B: 1 of 3 files (33%)');

    useSaveCardStore.getState().clearInventoryCache();
    await renderCard(inventory({
      intentUnits: [unit({ contributors: [contributor('supervisor-a', 'Solo supervisor', 1, 100)] })],
    }));
    expect(container.querySelector('[data-testid="save-contributor-roster"]')?.textContent)
      .toContain('Solo supervisor: 1 of 1 files (100%)');
  });

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

  it('renders a reachable inventory refresh control with populated packages', async () => {
    await renderCard(inventory());
    const refresh = container.querySelector<HTMLButtonElement>('[data-testid="save-card-refresh"]');
    expect(refresh).not.toBeNull();
    await act(async () => { refresh!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(getInventory).toHaveBeenCalledTimes(2);
  });

  it('sends the projected repository key when pinning a real-shaped inventory snapshot', async () => {
    vi.mocked(window.api.saveCard.markDone).mockResolvedValue({
      finalizationId: 'finalization-1', packageId: 'intent-1', finalizationKind: 'plan-package',
      outcome: 'created', boundaryRef: 'refs/lares/test', boundaryStatus: 'ready', packageRevision: 1,
      pinnedSelection: { selectedComponentIds: [], selectedUnattributedEntryIds: [] },
    } as never);
    await renderCard(inventory({
      computeState: {
        scope: 'global',
        inventory: {
          completeness: 'complete', dirtyCorpusStopReasons: [], observedEntries: 1,
          observedStatusBytes: 1, observedPathBytes: 1, totalsExact: true,
        },
        protection: { assessment: { evaluation: 'complete', rung: 'unprotected' }, checkpointStopReasons: [] },
        snapshot: {
          snapshotId: 'snapshot-1', boundaryInputFingerprint: 'fingerprint-1',
          repositoryKey: 'repo-1', stability: 'stable',
        },
      },
    }));
    const pin = container.querySelector<HTMLButtonElement>('[data-testid="save-bundle-pin"]')!;
    await act(async () => { pin.click(); await Promise.resolve(); });
    expect(window.api.saveCard.markDone).toHaveBeenCalledWith(expect.objectContaining({
      packageId: 'intent-1', targetWorkspaceId: 'ws-1',
      pinnedSnapshotId: 'snapshot-1', pinnedSnapshotFingerprint: 'fingerprint-1',
      repositoryKey: 'repo-1',
    }));
  });

  it('keeps committed intents, unstamped turns, and legacy finalizations read-only', async () => {
    await renderCard(inventory({
      intentUnits: [unit({ state: 'committed' })],
      legacyTaskIdentityUnavailable: [member('legacy-entry', 'legacy.ts')],
      witnessedUngroupable: [member('legacy-entry', 'legacy.ts')],
      legacyFinalizations: [{ finalizationId: 'legacy-fin', packageId: 'legacy-package',
        packageRevision: 2, finalizationKind: 'plan-package', boundaryStatus: 'ready', finalizedAt: 1 }],
    }));

    expect(container.querySelector('[data-testid="witnessed-ungroupable"]')?.textContent)
      .toContain('need manual grouping');
    expect(container.querySelector('[data-testid="legacy-package-finalizations"]')?.textContent)
      .toContain('Read-only legacy history');
    expect(container.querySelector('[data-testid="save-bundle-pin"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-bundle-submit"]')).toBeNull();
  });

  it('renders a fallback unit as a save gesture and sends only the main-owned unit identity', async () => {
    const fallback = unit({
      intentId: 'agent-fallback:repo:stable',
      kind: 'agent-session-fallback',
      saveUnitId: 'agent-fallback:repo:stable',
      saveUnitKind: 'agent-session-fallback',
      title: 'Build worker — mixed session work',
      plan: null,
      planItem: null,
      topologyEvidence: {
        componentIds: [], pathsWithMultipleTurns: [],
        captureHealth: { turns: [], captureOutage: false, pathsWithoutFinalizationEdge: [] },
      },
    });
    vi.mocked(window.api.saveCard.markDone).mockResolvedValue({
      finalizationId: 'finalization', packageId: fallback.intentId, finalizationKind: 'fleet-adhoc',
      outcome: 'created', boundaryRef: 'refs/lares/test', boundaryStatus: 'ready', packageRevision: 1,
      pinnedSelection: { selectedComponentIds: [], selectedUnattributedEntryIds: ['entry-1'] },
    } as never);
    await renderCard(inventory({ intentUnits: [], fallbackUnits: [fallback] }));
    expect(container.querySelector('[data-testid="fallback-save-unit"]')?.textContent)
      .toContain('Build worker — mixed session work');
    const prepare = container.querySelector<HTMLButtonElement>('[data-testid="save-bundle-pin"]')!;
    await act(async () => { prepare.click(); await Promise.resolve(); });
    expect(window.api.saveCard.markDone).toHaveBeenCalledWith({
      saveUnitId: 'agent-fallback:repo:stable',
      saveUnitKind: 'agent-session-fallback',
      targetWorkspaceId: 'ws-1',
    });
    const request = vi.mocked(window.api.saveCard.markDone).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty('memberEntryIds');
    expect(request).not.toHaveProperty('packageId');
  });

  it('commits one fallback gesture with cross-intent context when its member is shared with another fallback unit', async () => {
    const first = unit({
      intentId: 'agent-fallback:first', kind: 'agent-session-fallback',
      saveUnitId: 'agent-fallback:first', saveUnitKind: 'agent-session-fallback',
      plan: null, planItem: null,
    });
    const second = unit({
      intentId: 'agent-fallback:second', kind: 'agent-session-fallback',
      saveUnitId: 'agent-fallback:second', saveUnitKind: 'agent-session-fallback',
      plan: null, planItem: null,
    });
    vi.mocked(window.api.saveCard.markDone).mockResolvedValue({
      finalizationId: 'fallback-fin', packageId: first.intentId, finalizationKind: 'fleet-adhoc',
      outcome: 'created', boundaryRef: 'refs/lares/fallback', boundaryStatus: 'ready', packageRevision: 1,
      pinnedSelection: { selectedComponentIds: [], selectedUnattributedEntryIds: ['entry-1'] },
    } as never);
    vi.mocked(window.api.saveCard.preview).mockResolvedValue({
      isCandidate: true,
      candidate: {
        candidateId: 'fallback-candidate', contractVersion: 2,
        repository: {
          repositoryKey: 'repo-1', objectDatabaseKey: 'odb-1', gitObjectFormat: 'sha1', bareRepo: false,
          workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
        },
        componentIds: [], selectedUnattributedEntryIds: ['entry-1'], members: [],
        finalizations: [{ finalizationId: 'fallback-fin', packageId: first.intentId,
          packageRevision: 1, boundaryStatus: 'ready' }],
        eligibility: { eligible: true }, token: null,
      },
      laresTrailers: [], defaultMessageBody: 'Save fallback',
      unacknowledgedUnattributedEntryIds: [], componentTopologyDigest: 'topology',
      selectionDrift: { added: [], missing: [], reAttributed: [], byteMoved: [] },
      selectionDriftDisplayPaths: {},
      pinnedSelection: { selectedComponentIds: [], selectedUnattributedEntryIds: ['entry-1'], frozenMemberCount: 1 },
      reviewedManifest: { manifestVersion: 2, reviewedManifestDigest: 'review-digest', members: [],
        challengeVersion: 1, challengeAtoms: [{
          kind: 'cross-intent', atomId: 'fallback-cross', digest: 'fallback-cross-digest', reasonVersion: 1,
          pathBytesBase64: btoa('src/intent.ts'), displayPath: 'src/intent.ts',
          earlierIntentId: first.intentId, laterIntentId: second.intentId,
          evidenceDigest: 'fallback-cross-digest', resolution: null,
        }] },
      durableFinalizationIntent: [{ finalizationId: 'fallback-fin', packageId: first.intentId,
        packageRevision: 1, boundaryStatus: 'ready', frozenMemberManifestDigest: 'frozen-digest' }],
    } as never);
    vi.mocked(window.api.saveCard.sweep).mockResolvedValue({
      halted: false, haltKind: null,
      results: [{ kind: 'saved', repositoryKey: 'repo-1', finalizationId: 'fallback-fin',
        packageId: first.intentId, packageRevision: 1, attemptId: 'attempt-1', commitOid: 'commit-1' }],
    });
    await renderCard(inventory({ intentUnits: [], fallbackUnits: [first, second] }));
    const article = container.querySelectorAll<HTMLElement>('[data-testid="fallback-save-unit"]')[0];
    await act(async () => {
      article.querySelector<HTMLButtonElement>('[data-testid="save-bundle-pin"]')!.click();
      await Promise.resolve();
    });
    await act(async () => {
      article.querySelector<HTMLButtonElement>('[data-testid="save-bundle-submit"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.api.saveCard.preview).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', saveUnitIds: [first.intentId], finalizationIds: ['fallback-fin'],
    }));
    const previewRequest = vi.mocked(window.api.saveCard.preview).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(previewRequest).not.toHaveProperty('resolutionIds');
    expect(window.api.saveCard.resolveAttribution).not.toHaveBeenCalled();
    expect(window.api.saveCard.sweep).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgedChallengeAtoms: [],
    }));
    expect(article.textContent).toContain('saved — commit commit-1');
  });

  it('shows a visible warning for a null-session coarse fallback unit', async () => {
    await renderCard(inventory({
      intentUnits: [],
      fallbackUnits: [unit({
        intentId: 'agent-fallback:repo:coarse', kind: 'agent-session-fallback',
        saveUnitId: 'agent-fallback:repo:coarse', saveUnitKind: 'agent-session-fallback',
        coarseIdentityWarning: true, plan: null, planItem: null,
      })],
    }));
    expect(container.querySelector('[data-testid="fallback-coarse-warning"]')?.textContent)
      .toContain('agent\'s lifetime');
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

  it('gives could-not-assess precedence when protection degradation and no unit co-occur', async () => {
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
    expect(banner.dataset.computeState).toBe('assessment-unavailable');
    expect(banner.textContent).toContain('Save status could not be assessed');
    expect(banner.textContent).toContain('Nothing here is being reported as already saved.');
    expect(container.querySelector('[data-testid="save-card-none-loud"]')).toBeNull();
  });

  it('renders the all-clear when every unresolved bucket is empty and protection is complete', async () => {
    await renderCard(inventory({
      intentUnits: [unit({ state: 'committed' })],
      legacyFinalizations: [{ finalizationId: 'history', packageId: 'legacy-package', packageRevision: 1,
        finalizationKind: 'fleet-adhoc', boundaryStatus: 'ready', finalizedAt: 1 }],
    }));
    expect(container.querySelector('[data-testid="save-card-none-loud"]')?.textContent)
      .toContain('everything witnessed is already protected');
  });

  it('never renders the all-clear for unresolved buckets even when ordinary degradation co-occurs', async () => {
    await renderCard(inventory({
      intentUnits: [],
      unwitnessed: [member('no-witness', 'human.ts')],
      computeState: {
        scope: 'global',
        inventory: { completeness: 'partial', dirtyCorpusStopReasons: ['deadline'], observedEntries: 1,
          observedStatusBytes: 1, observedPathBytes: 1, totalsExact: false },
        protection: { assessment: { evaluation: 'incomplete' }, checkpointStopReasons: ['deadline'] },
      },
    }));
    expect(container.querySelector('[data-testid="save-card-none-loud"]')).toBeNull();
    expect(container.querySelector('[data-testid="save-card-degraded"]')?.getAttribute('data-compute-state'))
      .toBe('assessment-unavailable');
  });

  it('keeps scope-excluded witnessed work visible and off the all-clear', async () => {
    const excluded = member('excluded-plan', '.lares/plans/active/plan.md');
    await renderCard(inventory({
      intentUnits: [], fallbackUnits: [], unwitnessed: [],
      legacyTaskIdentityUnavailable: [excluded],
      witnessedUngroupable: [excluded],
    }));
    expect(container.querySelector('[data-testid="witnessed-ungroupable"]')?.textContent)
      .toContain('need manual grouping');
    expect(container.querySelector('[data-testid="save-card-none-loud"]')).toBeNull();
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
