// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PlanCandidatePreviewResponse } from '../../../shared/types';
import PlanSurfaceView from './PlanSurfaceView';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const selection = {
  selectedComponentIds: ['component-1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['finalization-1'],
};

const preview: PlanCandidatePreviewResponse = {
  isCandidate: true,
  candidate: {
    candidateId: 'candidate-shared-1', contractVersion: 1,
    repository: {
      repositoryKey: 'repo-1', objectDatabaseKey: 'objects-1', gitObjectFormat: 'sha1',
      bareRepo: false, workspaces: [{ workspaceId: 'workspace-1', workspacePrefix: '' }],
    },
    componentIds: ['component-1'], selectedUnattributedEntryIds: [],
    members: [{
      entryId: 'entry-1',
      path: { pathBytesBase64: 'c3JjL3BsYW4udHM=', displayPath: 'src/plan.ts', utf8Clean: true },
      expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-1', expectedCommitBlobOid: 'commit-1',
      expectedCommitMode: '100644', checkpointMode: '100644', coveringFinalizationIds: ['finalization-1'],
      packageVerification: 'verified-match', protection: 'checkpoint-protected',
    }],
    finalizations: [{
      finalizationId: 'finalization-1', packageId: 'package-1', packageRevision: 1, boundaryStatus: 'ready',
    }],
    eligibility: { eligible: true }, token: null,
  },
  selection,
};

let container: HTMLDivElement;
let root: Root;

async function renderReviewOnly() {
  (window as unknown as { api: unknown }).api = {
    plans: {
      previewCandidate: vi.fn(async () => preview),
      boardList: vi.fn(async () => []),
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PlanSurfaceView workspaceId="workspace-1" planId="plan-1" candidateSelection={selection} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('WP-N5 Plan-lens retired Save gesture', () => {
  it('keeps an eligible preview visible while omitting the Save action', async () => {
    await renderReviewOnly();
    expect(container.querySelector('[data-testid="plan-candidate-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="candidate-preview-save"]')).toBeNull();
  });

  it('explains that review and undo replace Save', async () => {
    await renderReviewOnly();
    expect(container.querySelector('[data-testid="plan-save-disabled"]')?.textContent)
      .toBe('Review and undo now replace Save.');
  });

  const retiredOutcomes = ['saved', 'stale-refused', 'integrity-incident', 'repository-uncertain'] as const;
  it.each(retiredOutcomes)('cannot reach the retired %s commit outcome', async () => {
    await renderReviewOnly();
    expect(container.querySelector('[data-testid="candidate-preview-save"]')).toBeNull();
  });
});
