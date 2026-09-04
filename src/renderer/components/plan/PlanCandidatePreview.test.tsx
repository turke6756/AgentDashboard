// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanCandidatePreviewResponse } from '../../../shared/types';
import PlanCandidatePreview from './PlanCandidatePreview';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const selection = {
  selectedComponentIds: ['component-1'],
  selectedUnattributedEntryIds: [],
  finalizationIds: ['finalization-1'],
};

const response: PlanCandidatePreviewResponse = {
  isCandidate: true,
  selection,
  candidate: {
    componentIds: ['component-1'],
    selectedUnattributedEntryIds: [],
    members: [{
      entryId: 'entry-1',
      path: { pathBytesBase64: 'c3JjL3BsYW4udHM=', displayPath: 'src/plan.ts', utf8Clean: true },
      expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-1', expectedCommitBlobOid: 'commit-1',
      expectedCommitMode: '100644', checkpointMode: '100644', coveringFinalizationIds: ['finalization-1'],
      packageVerification: 'verified-match', protection: 'checkpoint-protected',
    }],
    eligibility: { eligible: true },
  },
};

let container: HTMLDivElement;
let root: Root;

async function render(previewCandidate: ReturnType<typeof vi.fn>) {
  (window as unknown as { api: unknown }).api = { plans: { previewCandidate } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PlanCandidatePreview workspaceId="ws-1" planId="plan-1" selection={selection} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('PlanCandidatePreview', () => {
  it('renders member paths and verification verdicts from the plan response', async () => {
    const previewCandidate = vi.fn(async () => response);
    await render(previewCandidate);
    expect(previewCandidate).toHaveBeenCalledWith({ workspaceId: 'ws-1', planId: 'plan-1', ...selection });
    expect(container.querySelector('[data-testid="candidate-member"]')?.textContent)
      .toContain('Verified src/plan.ts');
    expect(container.querySelector('[data-testid="candidate-preview-verdict"]')?.textContent)
      .toContain('Finalized candidate');
  });

  it('renders a thrown error message', async () => {
    await render(vi.fn(async () => { throw new Error('preview exploded'); }));
    expect(container.querySelector('[data-testid="candidate-preview-error"]')?.textContent)
      .toContain('preview exploded');
  });
});
