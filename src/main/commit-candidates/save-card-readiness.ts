import type { DirtyEntry } from '../../shared/commit-candidates';
import type { SaveUnitReadiness } from '../../shared/types';

const DISPLAY_PATH_SAMPLE_LIMIT = 5;

/**
 * Decide whether every present member of a projected save unit has raw-byte
 * evidence. An absent member intentionally has no worktree blob and is ready.
 */
export function assessSaveUnitReadiness(
  entries: readonly DirtyEntry[],
): SaveUnitReadiness {
  const unhashed = entries.filter((entry) =>
    entry.expectedWorktreeState === 'present' && entry.rawWorktreeBlobOid === null);
  if (unhashed.length === 0) return { ready: true };
  return {
    ready: false,
    reason: 'members-unhashed',
    unhashedMemberCount: unhashed.length,
    sampleDisplayPaths: unhashed
      .slice(0, DISPLAY_PATH_SAMPLE_LIMIT)
      .map((entry) => entry.path.displayPath),
  };
}
