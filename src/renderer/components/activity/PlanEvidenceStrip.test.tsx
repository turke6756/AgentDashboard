// @vitest-environment jsdom
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanEvidenceStrip from './PlanEvidenceStrip';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (window as unknown as { api: unknown }).api = {
    activity: {
      list: vi.fn(async () => ({
        pageCounts: {
          turnCount: 3, agentCount: 2, fileCount: 5, planCount: 1, commitCount: 1, noCheckpointCount: 1,
          blockedOverlapCount: { value: 1, status: 'complete' }, unavailableCount: { value: 0, status: 'complete' }, checkingCount: { value: 0, status: 'complete' },
        },
      })),
    },
  };
});

afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('PlanEvidenceStrip', () => {
  it('labels counts as observed evidence without certifying the outcome', async () => {
    await act(async () => { root.render(<PlanEvidenceStrip workspaceId="ws" planId="plan" />); });
    expect(container.textContent).toContain('Observed evidence');
    expect(container.textContent).toContain('3 turns · 2 agents · 5 files · 1 commits · 1 without restore points · 1 overlaps');
    expect(container.textContent).toContain('does not verify the outcome');
  });
});
