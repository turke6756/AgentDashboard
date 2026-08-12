import type { SaveRefusal } from '../../../shared/commit-candidates';
import type {
  CommitCoordinatorConsumeResponse,
  SaveCardInventoryResponse,
  SaveCardMintResponse,
} from '../../../shared/types';

export type SaveCardComputeState =
  | 'complete' | 'complete-summarized' | 'partial' | 'protection-incomplete'
  | 'assessment-unavailable';

export function saveCardComputeState(
  response: Pick<SaveCardInventoryResponse, 'computeState' | 'onboarding'>
    & Partial<Pick<SaveCardInventoryResponse,
      'intentUnits' | 'fallbackUnits' | 'unwitnessed' | 'witnessedUngroupable'>>,
): SaveCardComputeState {
  const compute = response.computeState;
  if (!compute) return 'complete';
  const hasActiveUnit = (response.intentUnits ?? []).some((unit) =>
    unit.state !== 'committed' && unit.state !== 'superseded')
    || (response.fallbackUnits?.length ?? 0) > 0;
  const hasUnassessedWork = (response.unwitnessed?.length ?? 0) > 0
    || (response.witnessedUngroupable?.length ?? 0) > 0;
  if (!hasActiveUnit && (hasUnassessedWork
      || compute.protection.assessment.evaluation === 'incomplete')) {
    return 'assessment-unavailable';
  }
  if (compute.inventory.completeness === 'partial') return 'partial';
  if (compute.protection.assessment.evaluation === 'incomplete') return 'protection-incomplete';
  return response.onboarding?.recommendations.length ? 'complete-summarized' : 'complete';
}

const DIRTY_BUDGET_COPY: Record<string, string> = {
  entries: 'change-count budget',
  'status-bytes': 'Git status output budget',
  'path-bytes': 'path-data budget',
  deadline: 'inventory time budget',
};
const PROTECTION_BUDGET_COPY: Record<string, string> = {
  pairs: 'checkpoint membership-pair budget',
  'estimated-stdin': 'checkpoint query-memory budget',
  deadline: 'checkpoint coverage time budget',
};

export function degradedSaveCopy(
  response: Pick<SaveCardInventoryResponse, 'computeState' | 'onboarding'>
    & Partial<Pick<SaveCardInventoryResponse,
      'intentUnits' | 'fallbackUnits' | 'unwitnessed' | 'witnessedUngroupable'>>,
  changedCount: number,
): { title: string; body: string; budgetLine: string | null } | null {
  const state = saveCardComputeState(response);
  const firstContact = response.onboarding?.presentation === 'first-contact';
  if (state === 'complete') return null;
  if (state === 'assessment-unavailable') {
    return {
      title: 'Save status could not be assessed',
      body: 'Lares found work that it could not place in a save unit, or it could not finish checking protection. Nothing here is being reported as already saved.',
      budgetLine: null,
    };
  }
  if (state === 'complete-summarized') {
    return {
      title: firstContact ? 'Save tracking setup is summarized' : 'Large directories are summarized',
      body: 'The inventory and checkpoint coverage checks completed. Large untracked directories are collapsed below.',
      budgetLine: null,
    };
  }
  if (state === 'partial') {
    const compute = response.computeState!;
    const budgets = compute.inventory.dirtyCorpusStopReasons.map((reason) => DIRTY_BUDGET_COPY[reason]);
    return {
      title: firstContact ? 'Save tracking setup needs a smaller scope' : 'Save progress needs a smaller scope',
      body: `Lares counted at least ${compute.inventory.observedEntries.toLocaleString('en-US')} changes before the workspace scan stopped. The results below are bounded lower bounds. Review a smaller scope or exclude directories you do not want included in save tracking.`,
      budgetLine: budgets.length ? `Reached: ${budgets.join(', ')}.` : 'The bounded workspace inventory did not complete.',
    };
  }
  const compute = response.computeState!;
  const budgets = compute.protection.checkpointStopReasons.map((reason) => PROTECTION_BUDGET_COPY[reason]);
  return {
    title: firstContact ? 'Save tracking coverage needs review' : 'Checkpoint coverage needs review',
    body: changedCount === 0
      ? 'Lares did not modify any files, but it could not finish checking checkpoint coverage. Review a smaller scope or exclude directories you do not want included in save tracking.'
      : 'Lares found changes, but it could not finish checking checkpoint coverage. Proven protection is preserved, and unresolved entries are shown as unknown. Review a smaller scope or exclude directories you do not want included in save tracking.',
    budgetLine: budgets.length ? `Reached: ${budgets.join(', ')}.` : null,
  };
}

/** One plain-language renderer vocabulary for every Save/Plan surface. */
export function renderSaveRefusal(refusal: SaveRefusal): string {
  switch (refusal.stage) {
    case 'saveability':
      return 'This package cannot be saved from this workspace.';
    case 'boundary-capture':
      return refusal.paths?.length
        ? `Lares could not gather the current work for ${refusal.paths.join(', ')}.`
        : "Lares could not gather this package's current work.";
    case 'freeze':
      return 'This package is not ready to save.';
    case 'preview-verify':
      return 'This package changed since it was reviewed.';
    case 'mint': {
      const acknowledgementCopy: Record<string, string> = {
        'unattributed-ack-incomplete': 'This package contains unattributed work that needs your review.',
        'unattributed-ack-stale': 'The unattributed work changed and needs another review.',
        'candidate-ack-stale': 'This package changed since it was reviewed.',
        'mint-ack-race': 'This package changed, so review it and confirm the work again.',
      };
      if (acknowledgementCopy[refusal.code]) return acknowledgementCopy[refusal.code];
      if (refusal.code === 'acknowledgement-stale') {
        return "This package's unattributed work needs your review.";
      }
      return 'This package changed before Lares could save it.';
    }
    case 'token-consume':
      return 'This save is no longer current.';
    case 'commit': {
      const detail = refusal.message.startsWith('The package could not be saved: ')
        ? refusal.message.slice(32)
        : '';
      return detail && !/\b(?:mint|candidate|pin(?:ned|ning)?|token|stage|topology|acknowledgement)\b/i.test(detail)
        ? `Lares could not save this package because ${detail}`
        : 'Lares could not save this package.';
    }
    case 'reconciliation':
      return 'Lares saved this package but could not verify the result.';
  }
}

/** Compatibility derivation for renderer fixtures/older main instances. Current
 * main always supplies `refusal`; this keeps the unknown fallback stage-specific. */
export function mintRefusal(response: SaveCardMintResponse): SaveRefusal | null {
  if (response.refusal) return response.refusal;
  if (!response.isCandidate) {
    return { stage: 'mint', code: 'mint-refused', message: 'The package changed before it could be saved.' };
  }
  const eligibility = response.candidate.eligibility;
  if (!eligibility.eligible) {
    const acknowledgement = eligibility.reason === 'unattributed-not-acknowledged';
    return {
      stage: 'mint',
      code: acknowledgement ? 'acknowledgement-stale' : 'mint-refused',
      message: `The package is not ready to save: ${eligibility.reason}.`,
    };
  }
  if (!('token' in response.candidate) || !response.candidate.token) {
    return { stage: 'mint', code: 'mint-token-missing', message: 'The package could not be prepared for saving.' };
  }
  return null;
}

export function coordinatorRefusal(response: CommitCoordinatorConsumeResponse): SaveRefusal | null {
  if (response.kind === 'saved') return null;
  if (response.refusal) return response.refusal;
  if (response.kind === 'token-unresolved' || response.kind === 'compose-in-flight') {
    return { stage: 'token-consume', code: response.kind, message: 'This save is no longer current.' };
  }
  if (response.kind === 'reconciliation-error') {
    return { stage: 'reconciliation', code: response.error.code, message: 'The save could not be verified.' };
  }
  const detail = response.kind === 'invalid-message'
    ? response.reason
    : 'reason' in response.outcome ? response.outcome.reason : response.outcome.status;
  return { stage: 'commit', code: 'coordinator-stale', message: `The package could not be saved: ${detail}.` };
}
