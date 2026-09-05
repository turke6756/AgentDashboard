import { getDb } from '../database';
import type { AssertedCommitCandidate, AssertedDispatchEvidence } from '../../shared/types';
import { planningWorktreesEnabled } from './planning-worktree-flag';
import {
  changedPathsMatchFrozen,
  createGitOracle,
  type LandedCommitGitOracle,
} from './landed-commit-verifier';
import { briefedWorkPackageId } from './work-package-id';

export interface AssertedAttemptSource {
  packageId: string;
  dispatchAttemptId: string;
  packageRevision: number;
  repositoryKey: string | null;
  branchRef: string | null;
  dispatchTipOid: string | null;
  frozenPaths: string[] | null;
  captureStatus: 'captured' | 'unavailable';
  planArtifactId: string | null;
  repositoryRoot: string | null;
}

export interface AssertedTierDeps {
  listAttempts(planId: string): AssertedAttemptSource[];
  oracleFor(attempt: AssertedAttemptSource): LandedCommitGitOracle;
  scanCap?: number;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function trailerValues(trailers: readonly { key: string; value: string }[], key: string): string[] {
  return trailers.filter((entry) => entry.key === key).map((entry) => entry.value);
}

function listAttempts(planId: string): AssertedAttemptSource[] {
  const rows = getDb().prepare(
    `SELECT d.*, p.artifact_id, a.path AS activity_root, ws.path AS workspace_root
       FROM plan_dispatch_attempts d
       JOIN plan_work_packages wp ON wp.id = d.package_id
       JOIN plans p ON p.id = d.plan_id
       JOIN workspaces ws ON ws.id = wp.workspace_id
       LEFT JOIN planning_activity_worktrees a ON a.execution_run_id = d.execution_run_id
      WHERE d.plan_id = ? AND d.state IN ('delivered','reconciled')
        AND d.package_revision = wp.revision
      ORDER BY d.created_at, d.id`,
  ).all(planId) as any[];
  return rows.map((row) => {
    let frozenPaths: string[] | null = null;
    try {
      const value = JSON.parse(row.frozen_paths_json);
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) frozenPaths = value;
    } catch { /* unavailable below */ }
    return {
      packageId: row.package_id,
      dispatchAttemptId: row.id,
      packageRevision: row.package_revision,
      repositoryKey: row.repository_key ?? null,
      branchRef: row.branch_ref ?? null,
      dispatchTipOid: row.dispatch_tip_oid ?? null,
      frozenPaths,
      captureStatus: row.capture_status === 'captured' ? 'captured' : 'unavailable',
      planArtifactId: row.artifact_id ?? null,
      repositoryRoot: planningWorktreesEnabled()
        ? row.activity_root ?? row.workspace_root ?? null
        : row.workspace_root ?? null,
    };
  });
}

export async function discoverAssertedDispatchEvidence(
  planId: string,
  deps: AssertedTierDeps = {
    listAttempts,
    oracleFor: (attempt) => createGitOracle(attempt.repositoryRoot ?? ''),
  },
): Promise<AssertedDispatchEvidence[]> {
  let attempts: AssertedAttemptSource[];
  try { attempts = deps.listAttempts(planId); } catch { return []; }
  const output: AssertedDispatchEvidence[] = [];
  for (const attempt of attempts) {
    const base = { packageId: attempt.packageId, dispatchAttemptId: attempt.dispatchAttemptId };
    if (attempt.captureStatus !== 'captured' || !attempt.repositoryKey || !attempt.branchRef
        || !attempt.dispatchTipOid || !attempt.frozenPaths || !attempt.planArtifactId || !attempt.repositoryRoot) {
      output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: 'dispatch-evidence-missing' });
      continue;
    }
    try {
      const git = deps.oracleFor(attempt);
      const gateTipOid = await git.resolveCommit(attempt.repositoryKey, `${attempt.branchRef}^{commit}`);
      if (!gateTipOid) {
        output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: 'branch-unresolvable' });
        continue;
      }
      if (!await git.isAncestor(attempt.repositoryKey, attempt.dispatchTipOid, gateTipOid)) {
        output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: 'dispatch-tip-not-ancestor' });
        continue;
      }
      const scan = await git.listFirstParentRange(
        attempt.repositoryKey, attempt.dispatchTipOid, gateTipOid, deps.scanCap,
      );
      const expectedWp = briefedWorkPackageId(attempt.packageId, attempt.planArtifactId);
      const candidates = new Map<string, AssertedCommitCandidate>();
      for (const commitOid of scan.commitOids) {
        const commit = await git.readCommit(attempt.repositoryKey, commitOid);
        if (commit.parentOids.length !== 1) continue;
        const trailers = await git.interpretTrailers(attempt.repositoryKey, commit.message);
        const plans = trailerValues(trailers, 'Plan');
        const workPackages = trailerValues(trailers, 'WP');
        const labelsMatch = plans.length === 1 && plans[0] === attempt.planArtifactId
          && workPackages.length === 1
          && asciiLower(workPackages[0]) === asciiLower(expectedWp);
        let pathsMatch: boolean | null = null;
        try {
          pathsMatch = await changedPathsMatchFrozen(
            attempt.repositoryKey,
            {
              commitOid,
              parentOid: commit.parentOids[0],
              subject: commit.subject,
              verifiedTrailer: null,
              scopeOmittedTrailer: null,
            },
            attempt.frozenPaths,
            git,
          );
        } catch { /* a labels-only candidate remains visible with an unknown path verdict */ }
        const sources: AssertedCommitCandidate['sources'] = [];
        if (labelsMatch) sources.push('labels');
        if (pathsMatch === true) sources.push('changed-paths');
        if (sources.length === 0) continue;
        candidates.set(commitOid, {
          commitOid,
          parentOid: commit.parentOids[0],
          subject: commit.subject,
          sources,
          labelsMatch,
          changedPathsMatchFrozen: pathsMatch,
          planTrailer: plans.length === 1 ? plans[0] : null,
          wpTrailer: workPackages.length === 1 ? workPackages[0] : null,
          verifiedTrailers: trailerValues(trailers, 'Verified'),
          scopeOmittedTrailers: trailerValues(trailers, 'Scope-omitted'),
        });
      }
      output.push({
        ...base,
        scanStatus: scan.truncated ? 'truncated' : 'complete',
        candidates: [...candidates.values()],
      });
    } catch {
      output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: 'branch-unresolvable' });
    }
  }
  return output;
}
