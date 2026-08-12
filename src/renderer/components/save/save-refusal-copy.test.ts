import { describe, expect, it } from 'vitest';

import type { SaveRefusal } from '../../../shared/commit-candidates';
import { degradedSaveCopy, renderSaveRefusal, saveCardComputeState } from './save-refusal-copy';

const refusalVectors: SaveRefusal[] = [
  { stage: 'saveability', code: 'save-card-no-repository', message: 'Mint stage rejected a candidate token.' },
  { stage: 'boundary-capture', code: 'boundary-capture-failed', message: 'Pin stage rejected a foreign candidate.' },
  { stage: 'freeze', code: 'freeze-boundary-unavailable', message: 'Re-pin the token.' },
  { stage: 'preview-verify', code: 'preview-ineligible', message: 'Candidate pin moved.' },
  { stage: 'mint', code: 'unattributed-ack-incomplete', message: 'Mint token missing.' },
  { stage: 'mint', code: 'unattributed-ack-stale', message: 'Pinned candidate changed.' },
  { stage: 'mint', code: 'candidate-ack-stale', message: 'Candidate pin changed.' },
  { stage: 'mint', code: 'mint-ack-race', message: 'Mint token changed.' },
  { stage: 'mint', code: 'acknowledgement-stale', message: 'Candidate acknowledgement expired.' },
  { stage: 'mint', code: 'mint-refused', message: 'Mint stage refused.' },
  { stage: 'token-consume', code: 'token-unresolved-or-expired', message: 'Token-consume stage refused.' },
  { stage: 'commit', code: 'coordinator-stale', message: 'The package could not be saved: candidate token moved.' },
  { stage: 'reconciliation', code: 'tree-mismatch', message: 'Reconciliation stage rejected the token.' },
];

describe('save refusal copy', () => {
  it('renders every real refusal shape as one plain sentence without internal vocabulary', () => {
    for (const refusal of refusalVectors) {
      const copy = renderSaveRefusal(refusal);
      expect(copy).not.toMatch(/\b(?:mint|candidate|pin(?:ned|ning)?|token)\b/i);
      expect(copy.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
    }
  });

  it('describes unattributed acknowledgement refusals truthfully', () => {
    const acknowledgementVectors = refusalVectors.filter((refusal) => [
      'unattributed-ack-incomplete',
      'unattributed-ack-stale',
      'acknowledgement-stale',
    ].includes(refusal.code));

    for (const refusal of acknowledgementVectors) {
      const copy = renderSaveRefusal(refusal);
      expect(copy).toMatch(/unattributed work/i);
      expect(copy).not.toMatch(/another agent's|foreign/i);
    }
  });

  it('keeps compute behavior independent of presentation while copy changes', () => {
    const computeState = {
      scope: 'global' as const,
      inventory: {
        completeness: 'partial' as const, dirtyCorpusStopReasons: ['path-bytes' as const],
        observedEntries: 10_000, observedStatusBytes: 1, observedPathBytes: 2, totalsExact: false,
      },
      protection: { assessment: { evaluation: 'incomplete' as const }, checkpointStopReasons: [] },
    };
    const recommendation = [{ pathBytesBase64: 'eA==', displayPath: 'x', countLabel: '>=10,000' }];
    const first = { computeState, onboarding: { presentation: 'first-contact' as const, recommendations: recommendation },
      intentUnits: [{ state: 'open' } as never] };
    const established = { computeState, onboarding: { presentation: 'established' as const, recommendations: recommendation },
      intentUnits: [{ state: 'open' } as never] };
    expect(saveCardComputeState(first)).toBe('partial');
    expect(saveCardComputeState(established)).toBe('partial');
    expect(degradedSaveCopy(first, 1)?.title).not.toBe(degradedSaveCopy(established, 1)?.title);
    expect(degradedSaveCopy(first, 1)?.body).toBe(degradedSaveCopy(established, 1)?.body);
  });

  it('ships the approved ASCII-safe zero-changed protection copy', () => {
    const copy = degradedSaveCopy({
      computeState: {
        scope: 'global',
        inventory: { completeness: 'complete', dirtyCorpusStopReasons: [], observedEntries: 0,
          observedStatusBytes: 0, observedPathBytes: 0, totalsExact: true },
        protection: { assessment: { evaluation: 'incomplete' }, checkpointStopReasons: [] },
      },
      onboarding: null,
      intentUnits: [{ state: 'open' } as never],
    }, 0)?.body;
    expect(copy).toBe('Lares did not modify any files, but it could not finish checking checkpoint coverage. Review a smaller scope or exclude directories you do not want included in save tracking.');
    expect(copy).toMatch(/^[\x00-\x7F]+$/);
  });

  it('classifies unresolved work before everyday partial/protection degradation', () => {
    const response = {
      computeState: {
        scope: 'global' as const,
        inventory: { completeness: 'partial' as const, dirtyCorpusStopReasons: ['deadline' as const],
          observedEntries: 1, observedStatusBytes: 1, observedPathBytes: 1, totalsExact: false },
        protection: { assessment: { evaluation: 'incomplete' as const },
          checkpointStopReasons: ['deadline' as const] },
      },
      onboarding: null,
      intentUnits: [], fallbackUnits: [],
      unwitnessed: [{} as never], witnessedUngroupable: [],
    };
    expect(saveCardComputeState(response)).toBe('assessment-unavailable');
    expect(degradedSaveCopy(response, 1)?.title).toBe('Save status could not be assessed');
  });
});
