import { getDb } from '../database';
import type { AssertedCommitCandidate, AssertedDispatchEvidence } from '../../shared/types';
import {
  changedPathsMatchFrozen,
  createGitOracle,
  scanMatchingCommits,
  type LandedCommitGitOracle,
} from './landed-commit-verifier';

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

function listAttempts(planId: string): AssertedAttemptSource[] {
  const rows = getDb().prepare(
    `SELECT d.*, p.artifact_id, a.path AS repository_root
       FROM plan_dispatch_attempts d
       JOIN plan_work_packages wp ON wp.id = d.package_id
       JOIN plans p ON p.id = d.plan_id
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
      repositoryRoot: row.repository_root ?? null,
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
      const scan = await scanMatchingCommits({
        repositoryKey: attempt.repositoryKey,
        branchRef: attempt.branchRef,
        dispatchTipOid: attempt.dispatchTipOid,
        planArtifactId: attempt.planArtifactId,
        wpId: attempt.packageId,
      }, git, deps.scanCap);
      if (scan.outcome === 'refused') {
        output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: scan.reason });
        continue;
      }
      const candidates: AssertedCommitCandidate[] = [];
      for (const match of scan.matches) {
        let changedPathsMatch: boolean | null = null;
        try {
          changedPathsMatch = await changedPathsMatchFrozen(
            attempt.repositoryKey, match, attempt.frozenPaths, git,
          );
        } catch { /* candidate remains visible with unknown path status */ }
        candidates.push({
          commitOid: match.commitOid,
          subject: match.subject,
          verifiedTrailer: match.verifiedTrailer,
          scopeOmittedTrailer: match.scopeOmittedTrailer,
          changedPathsMatchFrozen: changedPathsMatch,
        });
      }
      output.push({ ...base, scanStatus: scan.truncated ? 'truncated' : 'complete', candidates });
    } catch {
      output.push({ ...base, scanStatus: 'unavailable', candidates: [], refusal: 'branch-unresolvable' });
    }
  }
  return output;
}
