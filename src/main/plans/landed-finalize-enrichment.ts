import {
  getPlanDispatchAttempt,
  getPlanWorkPackage,
  listPlanWpReachabilityEvidence,
  listPlanWpReachabilityObligations,
  type PlanDispatchAttempt,
  type PlanWorkPackage,
  type PlanWpReachabilityEvidence,
  type PlanWpReachabilityObligation,
} from '../database';
import {
  runGit as realRunGit,
  runGitBytes as realRunGitBytes,
  type GitRunBytesResult,
  type GitRunResult,
  type RunGitOptions,
} from '../git-checkpoints/git-command';
import type { EncodedGitPath } from '../../shared/commit-candidates';
import type { CommitRepresentationEntry } from '../commit-candidates/commit-representation';
import type { FinalizePlanItemDoneRequest } from './plan-ipc';
import { REACHABILITY_TARGET_REGISTRY } from './reachability-targets';

const FULL_OID = /^[0-9a-f]{40}$/i;
const MAX_GIT_OUTPUT = 8 << 20;

export interface ResolveLandedFinalizeRequestInput {
  dispatchAttemptId: string;
  commitOid: string;
  repoRoot: string;
  finalizedBy: string;
  checkpointTurnId?: string | null;
  createdFromWorkspaceId?: string | null;
  contractVersion?: number;
  gitExe?: string;
  deadlineAt?: number;
}

export type ResolveLandedFinalizeRequestResult =
  | { ok: true; request: FinalizePlanItemDoneRequest }
  | { ok: false; reason: 'dispatch-envelope-unavailable' | 'package-unavailable' | 'accepted-commit-unavailable' | 'members-unresolvable'; message: string };

export interface LandedFinalizeEnrichmentDeps {
  getAttempt?: (id: string) => PlanDispatchAttempt | null;
  getPackage?: (id: string) => PlanWorkPackage | null;
  listObligations?: (packageId: string, contentHash?: string) => PlanWpReachabilityObligation[];
  listEvidence?: (obligationId: string) => PlanWpReachabilityEvidence[];
  runGit?: (cwd: string, args: string[], options: RunGitOptions) => Promise<GitRunResult>;
  runGitBytes?: (cwd: string, args: string[], options: RunGitOptions) => Promise<GitRunBytesResult>;
  verificationTargetVersion?: string;
}

function encodedPath(path: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(path, 'utf8').toString('base64'),
    displayPath: path,
    utf8Clean: true,
  };
}

function parseSingleTreeEntry(stdout: Buffer, path: string): { mode: string; oid: string } | null {
  if (stdout.length === 0) return null;
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] === 0) {
      records.push(stdout.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== stdout.length || records.length !== 1) {
    throw new Error(`ls-tree returned an ambiguous member for ${path}`);
  }
  const record = records[0];
  const tab = record.indexOf(0x09);
  if (tab < 0 || !record.subarray(tab + 1).equals(Buffer.from(path, 'utf8'))) {
    throw new Error(`ls-tree returned the wrong member for ${path}`);
  }
  const header = record.subarray(0, tab).toString('ascii').split(' ');
  if (header.length !== 3 || header[1] !== 'blob' || !/^(100644|100755|120000)$/.test(header[0])
      || !FULL_OID.test(header[2])) {
    throw new Error(`ls-tree returned an unsupported member for ${path}`);
  }
  return { mode: header[0], oid: header[2].toLowerCase() };
}

/** Build finalization inputs solely from the accepted commit and current proof rows. */
export async function resolveLandedFinalizeRequest(
  input: ResolveLandedFinalizeRequestInput,
  deps: LandedFinalizeEnrichmentDeps = {},
): Promise<ResolveLandedFinalizeRequestResult> {
  const getAttempt = deps.getAttempt ?? getPlanDispatchAttempt;
  const getPackage = deps.getPackage ?? getPlanWorkPackage;
  const listObligations = deps.listObligations ?? listPlanWpReachabilityObligations;
  const listEvidence = deps.listEvidence ?? listPlanWpReachabilityEvidence;
  const runGit = deps.runGit ?? realRunGit;
  const runGitBytes = deps.runGitBytes ?? realRunGitBytes;
  const version = deps.verificationTargetVersion ?? REACHABILITY_TARGET_REGISTRY.version;
  const attempt = getAttempt(input.dispatchAttemptId);
  if (!attempt || attempt.captureStatus !== 'captured' || !attempt.repositoryKey
      || !attempt.frozenPaths || attempt.frozenPaths.length === 0) {
    return { ok: false, reason: 'dispatch-envelope-unavailable', message: 'The dispatch envelope is unavailable.' };
  }
  const pkg = getPackage(attempt.packageId);
  if (!pkg || !pkg.contentHash || pkg.revision !== attempt.packageRevision || pkg.planId !== attempt.planId) {
    return { ok: false, reason: 'package-unavailable', message: 'The dispatched package revision is unavailable.' };
  }
  if (!FULL_OID.test(input.commitOid)) {
    return { ok: false, reason: 'accepted-commit-unavailable', message: 'The accepted commit must be a full Git OID.' };
  }
  const commitOid = input.commitOid.toLowerCase();
  const gitOptions: RunGitOptions = {
    gitExe: input.gitExe,
    deadlineAt: input.deadlineAt,
    timeoutMs: 30_000,
    maxBytes: MAX_GIT_OUTPUT,
  };
  try {
    const treeResult = await runGit(input.repoRoot, ['rev-parse', '--verify', `${commitOid}^{tree}`], gitOptions);
    const candidateTreeOid = treeResult.stdout.trim().toLowerCase();
    if (!FULL_OID.test(candidateTreeOid)) throw new Error('commit tree is not a full oid');

    const members: CommitRepresentationEntry[] = [];
    for (const frozenPath of attempt.frozenPaths) {
      if (!frozenPath || /[\n\0]/.test(frozenPath)) throw new Error('invalid frozen path');
      const result = await runGitBytes(
        input.repoRoot, ['ls-tree', '-r', '-z', commitOid, '--', frozenPath], gitOptions,
      );
      const treeEntry = parseSingleTreeEntry(result.stdout, frozenPath);
      const path = encodedPath(frozenPath);
      members.push({
        path,
        commitPathspecs: [path],
        expectedWorktreeState: treeEntry ? 'present' : 'absent',
        rawWorktreeBlobOid: treeEntry?.oid ?? null,
      });
    }

    const mutationBlobOidByObligationId: Record<string, string> = {};
    for (const obligation of listObligations(pkg.id, pkg.contentHash)) {
      const fresh = listEvidence(obligation.id)
        .filter((row) => row.verdict === 'pass'
          && row.packageContentHash === pkg.contentHash
          && row.specimenTreeOid.toLowerCase() === candidateTreeOid
          && row.verificationTargetVersion === version
          && FULL_OID.test(row.mutationBlobOid))
        .sort((a, b) => b.verifiedAt - a.verifiedAt || b.id.localeCompare(a.id))[0];
      if (fresh) mutationBlobOidByObligationId[obligation.id] = fresh.mutationBlobOid.toLowerCase();
    }

    return {
      ok: true,
      request: {
        planItemId: pkg.id,
        repositoryKey: attempt.repositoryKey,
        boundaryOid: commitOid,
        members,
        checkpointTurnId: input.checkpointTurnId ?? attempt.confirmedTurnId,
        finalizedBy: input.finalizedBy,
        createdFromWorkspaceId: input.createdFromWorkspaceId,
        contractVersion: input.contractVersion ?? 1,
        repoRoot: input.repoRoot,
        pinnedHeadOid: commitOid,
        gitExe: input.gitExe,
        deadlineAt: input.deadlineAt,
        candidateTreeOid,
        verificationTargetVersion: version,
        mutationBlobOidByObligationId,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'members-unresolvable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
