// @vitest-environment jsdom
//
// SC-WP-3I — plan-lens candidate preview integration.
//
// Two properties, both from the WP acceptance:
//
//  1. IDENTICAL identity across lenses. The plan lens resolves a D-1-filtered
//     WHOLE-component selection and runs the SAME WP-3G `buildCandidate` service the
//     save lens uses — so for the same effective selection the `candidateId` and the
//     per-member verdicts are byte-identical, and a component that also connects to
//     ANOTHER plan is included WHOLE, never carved into a proper subset. This test
//     drives `buildCandidate` directly (the single identity/topology authority; the
//     plan channel `buildPlanCandidatePreview` is a thin wrapper that only forwards
//     the whole-component selection to this exact call — it can't be imported here
//     because `plan-ipc` pulls the native DB, so we mirror its selection resolution).
//
//  2. The plan-owned preview renders member paths and verdicts without exposing
//     the retired Save message, trailer, or commit surfaces.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlanSurfaceView from './PlanSurfaceView';
import { buildCandidate, type CandidateBuildContext } from '../../../main/commit-engine/candidate-service';
import type {
  ConflictComponent,
  DirtyEntry,
  DirtyInventory,
  RepositoryIdentity,
  CommitCandidate,
} from '../../../shared/commit-candidates';
import type { CommitRepresentation } from '../../../main/commit-engine/commit-representation';
import type { FrozenManifestMember } from '../../../main/commit-engine/finalization-service';
import type { PackageFinalization } from '../../../main/database';
import type { PlanCandidatePreviewResponse } from '../../../shared/types';

// ── fixtures ──────────────────────────────────────────────────────────────────
//
// A single component `c1` that fuses two entries and connects to BOTH plan-A and
// plan-B (a genuine cross-plan component). A finalization covers both entries and the
// current temp-index reps match, so a whole-component selection verifies + is
// eligible under either lens.

const REPO_KEY = 'repo-key-3i';

function repository(): RepositoryIdentity {
  return {
    repositoryKey: REPO_KEY,
    objectDatabaseKey: 'odb-1',
    gitObjectFormat: 'sha1',
    bareRepo: false,
    workspaces: [{ workspaceId: 'ws-1', workspacePrefix: '' }],
  };
}

function entry(id: string, over: Partial<DirtyEntry> = {}): DirtyEntry {
  return {
    entryId: id,
    path: { pathBytesBase64: `b64-${id}`, displayPath: `src/${id}.ts`, utf8Clean: true },
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: `raw-${id}`,
    gitLevelEligibility: 'supported',
    commitPathspecs: [],
    ...over,
  };
}

// c1 fuses e1 + e2 and carries TWO plan associations — it connects to plan-A AND
// plan-B, so the plan-A lens must include the whole component (e1 + e2), never e1
// alone.
function crossPlanComponent(): ConflictComponent {
  return {
    componentId: 'c1',
    dirtyEntryIds: ['e1', 'e2'],
    associations: [
      { planId: 'plan-A', planItemId: null, contributingTurnIds: ['t1'], memberEntryIds: ['e1'] },
      { planId: 'plan-B', planItemId: null, contributingTurnIds: ['t2'], memberEntryIds: ['e2'] },
    ],
    overlap: {
      componentId: 'c1',
      contributingAgentCount: 2,
      mergedGroupCount: 2,
      perPathContributors: {},
    },
    componentTopologyDigest: 'topo-c1',
  };
}

function inventory(entries: DirtyEntry[], unattributedEntryIds: string[] = []): DirtyInventory {
  return { repository: repository(), entries, unattributedEntryIds, topologyDigest: 'inv-topo' };
}

function frozen(entryId: string): FrozenManifestMember {
  return {
    pathBytesBase64: `b64-${entryId}`,
    expectedState: 'present',
    rawBlobOid: `raw-${entryId}`,
    commitBlobOid: `commit-${entryId}`,
    commitMode: '100644',
  };
}

function finalization(): PackageFinalization {
  return {
    id: 'fin-1',
    packageId: 'pkg-1',
    repositoryKey: REPO_KEY,
    finalizationKind: 'fleet-adhoc',
    planId: null,
    planItemId: null,
    packageRevision: 3,
    finalizedAt: 1,
    finalizedBy: 'human-ipc',
    checkpointTurnId: null,
    checkpointOid: 'boundary-oid',
    boundaryRef: 'refs/lares/fin-1',
    boundaryStatus: 'ready',
    lifecycleStatus: 'active',
    supersededByFinalizationId: null,
    releasedAt: null,
    memberManifestJson: JSON.stringify([frozen('e1'), frozen('e2')]),
    contractVersion: 1,
    failureReason: null,
    createdFromWorkspaceId: null,
  };
}

function context(): CandidateBuildContext {
  return {
    repository: repository(),
    inventory: inventory([entry('e1'), entry('e2')]),
    components: [crossPlanComponent()],
    finalizations: [finalization()],
    currentCommitReps: new Map<string, CommitRepresentation>([
      ['e1', { expectedState: 'present', rawBlobOid: 'raw-e1', commitBlobOid: 'commit-e1', commitMode: '100644' }],
      ['e2', { expectedState: 'present', rawBlobOid: 'raw-e2', commitBlobOid: 'commit-e2', commitMode: '100644' }],
    ]),
    ledger: [],
    pinnedHeadOid: 'HEAD-OID',
    indexFingerprint: { fingerprint: 'fp-1', entries: [], hasUnmerged: false, writeTreeOid: null },
    contractVersion: 1,
  };
}

/** Mirror of the plan channel's D-1 filter (`buildPlanCandidatePreview`): the plan
 *  lens's default selection is EVERY whole component with an association to `planId`
 *  — whole components only, never a carved subset. */
function planLensComponentIds(ctx: CandidateBuildContext, planId: string): string[] {
  return ctx.components
    .filter((component) => component.associations.some((a) => a.planId === planId))
    .map((component) => component.componentId);
}

// ── property 1: identical candidateId + verdicts across lenses ──────────────────

describe('SC-WP-3I plan-lens candidate identity', () => {
  it('assembles an IDENTICAL candidateId + member verdicts as the save lens for the same whole component', () => {
    const ctx = context();
    const finalizationIds = ['fin-1'];

    // Save lens: the user selects the whole component c1.
    const saveLens = buildCandidate(
      { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds },
      ctx,
    ) as CommitCandidate;

    // Plan lens (plan-A): its D-1 filter resolves the SAME whole component c1 — even
    // though c1 also connects to plan-B, it is included whole, never carved.
    const planComponentIds = planLensComponentIds(ctx, 'plan-A');
    expect(planComponentIds).toEqual(['c1']);
    const planLens = buildCandidate(
      { selectedComponentIds: planComponentIds, selectedUnattributedEntryIds: [], finalizationIds },
      ctx,
    ) as CommitCandidate;

    // Both are finalization-backed candidates with a stable id.
    expect(saveLens.candidateId).toBeTypeOf('string');
    expect(saveLens.candidateId.length).toBeGreaterThan(0);
    // IDENTICAL identity across lenses (§14).
    expect(planLens.candidateId).toBe(saveLens.candidateId);
    // IDENTICAL per-member verdicts, in order.
    expect(planLens.members.map((m) => m.entryId)).toEqual(saveLens.members.map((m) => m.entryId));
    expect(planLens.members.map((m) => m.packageVerification)).toEqual(
      saveLens.members.map((m) => m.packageVerification),
    );
    expect(planLens.eligibility).toEqual(saveLens.eligibility);
    // The whole cross-plan component is present — BOTH entries, never a subset.
    expect(saveLens.members.map((m) => m.entryId).sort()).toEqual(['e1', 'e2']);
    expect(planLens.members.map((m) => m.entryId).sort()).toEqual(['e1', 'e2']);
  });

  it('the plan lens can never split a cross-plan component into a proper subset', () => {
    const ctx = context();
    // Carving one entry of the cross-plan component out as an independent atom is a
    // proper subset — buildCandidate (the sole topology authority) refuses it, so no
    // lens can present a sub-candidate of a component that connects to other plans.
    const carved = buildCandidate(
      { selectedComponentIds: [], selectedUnattributedEntryIds: ['e1'], finalizationIds: ['fin-1'] },
      ctx,
    ) as CommitCandidate;
    // Since bb823b15, normalized Git closure governs the selection. This entry
    // lacks finalized package closure, so acknowledgement cannot make it eligible.
    expect(carved.eligibility).toEqual({ eligible: false, reason: 'package-not-finalized' });
  });
});

// ── property 2: PlanSurfaceView uses the plan-owned preview ────────────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(el: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  // Flush PlanCandidatePreview's async preview load.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return container;
}

function previewResponse(): PlanCandidatePreviewResponse {
  const ctx = context();
  const candidate = buildCandidate(
    { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] },
    ctx,
  );
  return {
    candidate,
    isCandidate: true,
    selection: { selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] },
  };
}

describe('SC-WP-3I PlanSurfaceView candidate preview reuse', () => {
  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      plans: {
        previewCandidate: vi.fn(async () => previewResponse()),
        boardList: vi.fn(async () => []),
      },
    };
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    container = null;
    root = null;
    delete (window as unknown as { api?: unknown }).api;
  });

  it('renders the plan-owned candidate preview when a selection is resolved', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        planId="plan-A"
        candidateSelection={{ selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] }}
      />,
    );
    expect(c.querySelector('[data-testid="plan-candidate-preview"]')).not.toBeNull();
    const preview = c.querySelector('[data-testid="candidate-preview"]');
    expect(preview).not.toBeNull();
    expect(c.querySelector('[data-testid="candidate-preview-save"]')).toBeNull();
    expect(c.querySelector('[data-testid="plan-save-disabled"]')?.textContent)
      .toBe('Review and undo now replace Save.');
    // Both member verdicts render.
    expect(c.querySelectorAll('[data-testid="candidate-member"]').length).toBe(2);
    expect((window as unknown as { api: { plans: { previewCandidate: ReturnType<typeof vi.fn> } } }).api.plans.previewCandidate)
      .toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', planId: 'plan-A', selectedComponentIds: ['c1'] }));
  });

  it('does not render Save-only message or trailer controls', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        planId="plan-A"
        candidateSelection={{ selectedComponentIds: ['c1'], selectedUnattributedEntryIds: [], finalizationIds: ['fin-1'] }}
      />,
    );
    expect(c.querySelector('[data-testid="candidate-preview-message"]')).toBeNull();
    expect(c.querySelector('[data-testid="candidate-preview-trailers"]')).toBeNull();
    expect(c.querySelector('[data-testid="candidate-preview-save"]')).toBeNull();
  });

  it('omits the preview when no candidate selection is resolved (unwired / nothing to save)', async () => {
    const c = await render(
      <PlanSurfaceView
        workspaceId="ws-1"
        planId="plan-A"
        candidateSelection={null}
      />,
    );
    expect(c.querySelector('[data-testid="plan-candidate-preview"]')).toBeNull();
    expect(c.querySelector('[data-testid="candidate-preview"]')).toBeNull();
  });
});
