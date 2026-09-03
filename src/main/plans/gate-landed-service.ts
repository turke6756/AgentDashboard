import {
  findGateLandedWitnessTurn,
  getDb,
  getPlanDispatchAttempt,
  getPlanPackageEvidenceProjection,
  getPlanPackageGateAttempt,
  getPlanWorkPackage,
  getWorkspace,
  nextPlanPackageGateAttemptNo,
  reconcilePlanDispatchAttempts,
  type PlanDispatchAttempt,
  type PlanWorkPackage,
  type TurnRecord,
} from '../database';
import type { GateLandedResult, GateLandedWorkPackageArgs } from '../../shared/types';
import {
  createGitOracle,
  verifyLandedCommit,
  type LandedCommitGitOracle,
  type LandedCommitVerification,
} from './landed-commit-verifier';
import {
  evaluateCompletionReadiness,
  transitionPlanPackage,
  type CompletionDeclaration,
  type CompletionReadinessFinding,
  type PlanPackageCommand,
  type PlanPackageWitness,
  type TransitionResult,
} from './package-ledger';
import { resolveLandedFinalizeRequest } from './landed-finalize-enrichment';
import { finalizePlanItemDone } from './plan-ipc';
import type { FinalizePackageResult } from '../commit-candidates/finalization-service';

const ACCEPTANCE_GATE = 'supervisor-acceptance';
const ACCEPTANCE_GATE_REVISION = 1;

type PlanAuthority = {
  id: string;
  workspaceId: string;
  artifactId: string | null;
  responsibleSupervisorId: string | null;
};

export interface GateLandedServiceDeps {
  getAttempt?: (id: string) => PlanDispatchAttempt | null;
  getPackage?: (id: string) => PlanWorkPackage | null;
  getPlanAuthority?: (id: string) => PlanAuthority | null;
  getRepositoryRoot?: (workspaceId: string) => string | null;
  findWitness?: (input: Parameters<typeof findGateLandedWitnessTurn>[0]) => TurnRecord | null;
  gitOracle?: (repoRoot: string) => LandedCommitGitOracle;
  verify?: typeof verifyLandedCommit;
  transition?: (command: PlanPackageCommand, witness: PlanPackageWitness) => TransitionResult;
  evaluate?: typeof evaluateCompletionReadiness;
  reconcile?: typeof reconcilePlanDispatchAttempts;
  resolveFinalize?: typeof resolveLandedFinalizeRequest;
  finalize?: typeof finalizePlanItemDone;
  now?: () => number;
}

function defaultPlanAuthority(id: string): PlanAuthority | null {
  const row = getDb().prepare(
    `SELECT id, workspace_id, artifact_id, responsible_supervisor_id
       FROM plans WHERE id = ? AND deleted_at IS NULL`,
  ).get(id) as {
    id: string; workspace_id: string; artifact_id: string | null;
    responsible_supervisor_id: string | null;
  } | undefined;
  return row ? {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    responsibleSupervisorId: row.responsible_supervisor_id,
  } : null;
}

function identity(pkg: PlanWorkPackage, plan: PlanAuthority, key: string) {
  return {
    idempotencyKey: key,
    workspaceId: pkg.workspaceId,
    planId: pkg.planId,
    planArtifactId: plan.artifactId!,
    intentId: pkg.intentId!,
    packageId: pkg.id,
    packageRevision: pkg.revision,
  };
}

/** Mirror the declaration that finalizePlanItemDone derives at the real boundary.
 * This prospective form only asks the shared evaluator whether finalization may
 * be attempted; the ready-boundary guard remains authoritative inside finalize. */
function codeDeclaration(packageId: string, revision: number): CompletionDeclaration {
  const projection = getPlanPackageEvidenceProjection(packageId, revision);
  if (!projection) throw new Error('gate-landed: package evidence unavailable');
  const latestGateIds = new Set(projection.latestGateAttempts.map((gate) => gate.id));
  const commits = projection.gateCommitLinks
    .filter((link) => latestGateIds.has(link.gateAttemptId))
    .map((link) => ({ repositoryKey: link.repositoryKey, commitOid: link.commitOid }));
  return {
    kind: 'code',
    requiredGateKeys: projection.latestGateAttempts.map((gate) => gate.gateKey),
    implementationCommits: [...new Map(
      commits.map((ref) => [`${ref.repositoryKey}:${ref.commitOid}`, ref]),
    ).values()],
    boundary: 'ready',
    deploymentEnvironments: projection.latestDeploymentEvents.map((event) => event.environment),
    behavior: true,
  };
}

function refused(reason: Extract<GateLandedResult, { outcome: 'refused' }>['reason']): GateLandedResult {
  return { outcome: 'refused', reason };
}

/** Supervisor declaration service. Every identity/git/witness refusal happens
 * before the first ledger transition, so refused results are provably zero-write. */
export async function gateLandedWorkPackage(
  args: GateLandedWorkPackageArgs,
  supervisorId: string,
  deps: GateLandedServiceDeps = {},
): Promise<GateLandedResult> {
  const getAttempt = deps.getAttempt ?? getPlanDispatchAttempt;
  const getPackage = deps.getPackage ?? getPlanWorkPackage;
  const getPlanAuthority = deps.getPlanAuthority ?? defaultPlanAuthority;
  const findWitness = deps.findWitness ?? findGateLandedWitnessTurn;
  const transition = deps.transition ?? transitionPlanPackage;
  const evaluate = deps.evaluate ?? evaluateCompletionReadiness;

  const plan = getPlanAuthority(args.plan_id);
  if (!plan || plan.responsibleSupervisorId !== supervisorId) {
    return refused('not-responsible-supervisor');
  }
  // Gate invocation is also a convergence edge: retry a turn that landed after
  // prompt delivery before classifying the durable attempt as unconfirmed.
  (deps.reconcile ?? reconcilePlanDispatchAttempts)();
  const attempt = getAttempt(args.dispatch_attempt_id);
  if (!attempt) return refused('dispatch-attempt-not-found');
  if (attempt.planId !== args.plan_id) return refused('attempt-plan-mismatch');
  if ((attempt.state !== 'delivered' && attempt.state !== 'reconciled') || !attempt.confirmedTurnId) {
    return refused('attempt-unconfirmed');
  }
  const pkg = getPackage(attempt.packageId);
  if (!pkg || pkg.planId !== plan.id || attempt.packageRevision !== pkg.revision) {
    return refused('stale-attempt-revision');
  }
  if (attempt.captureStatus !== 'captured' || !attempt.repositoryKey || !attempt.branchRef
      || !attempt.dispatchTipOid || !attempt.frozenPaths?.length || !attempt.targetAgentId
      || !attempt.targetSessionId || !pkg.intentId || attempt.intentId !== pkg.intentId || !plan.artifactId) {
    return refused('dispatch-evidence-unavailable');
  }
  const repositoryRoot = deps.getRepositoryRoot?.(pkg.workspaceId)
    ?? getWorkspace(pkg.workspaceId)?.path ?? null;
  if (!repositoryRoot) return refused('dispatch-evidence-unavailable');
  const repositoryKey = attempt.repositoryKey;

  const verify = deps.verify ?? verifyLandedCommit;
  const verification: LandedCommitVerification = await verify({
    repositoryKey,
    branchRef: attempt.branchRef,
    dispatchTipOid: attempt.dispatchTipOid,
    frozenPaths: attempt.frozenPaths,
    planArtifactId: plan.artifactId,
    wpId: pkg.id,
    commitOid: args.commit_oid,
  }, (deps.gitOracle ?? createGitOracle)(repositoryRoot));
  if (verification.outcome === 'refused') return refused(verification.reason);

  const witnessTurn = findWitness({
    planId: plan.id,
    packageId: pkg.id,
    intentId: pkg.intentId,
    targetAgentId: attempt.targetAgentId,
    targetSessionId: attempt.targetSessionId,
    repositoryKey,
    commitOid: verification.commitOid,
    frozenPaths: attempt.frozenPaths,
  });
  if (!witnessTurn) return refused('commit-witness-unavailable');

  // Idempotency digests include the nested commit-record timestamp. Anchor it to
  // the immutable confirmed dispatch rather than retry wall-clock time.
  const observedAt = attempt.confirmedAt ?? attempt.reconciledAt ?? attempt.createdAt;
  transition({
    type: 'commits-observed',
    ...identity(pkg, plan, `gate-landed-observed:${attempt.id}:${verification.commitOid}`),
  }, {
    kind: 'git', actor: supervisorId, observedAt, turnId: witnessTurn.id,
    commits: [{
      repositoryKey,
      commitOid: verification.commitOid,
      parentOid: verification.parentOid,
      observedAt,
      source: 'external',
      pushedRemoteCount: 0,
      lastReconciledAt: null,
    }],
  });

  const gateKey = `gate-landed:${attempt.id}:${verification.commitOid}`;
  const gateAttemptId = `package-ledger:${gateKey}`;
  if (!getPlanPackageGateAttempt(gateAttemptId)) {
    getDb().transaction(() => {
      if (getPlanPackageGateAttempt(gateAttemptId)) return;
      const attemptNo = nextPlanPackageGateAttemptNo(pkg.id, pkg.revision, ACCEPTANCE_GATE);
      transition({
        type: 'gate-decided',
        ...identity(pkg, plan, gateKey),
        gateKey: ACCEPTANCE_GATE,
        gateRevision: ACCEPTANCE_GATE_REVISION,
        attemptNo,
      }, {
        kind: 'gate', actor: supervisorId, observedAt, outcome: 'passed',
        witnessAgentId: witnessTurn.agentId,
        witnessSessionId: witnessTurn.sessionId,
        witnessTurnId: witnessTurn.id,
        verifiedCommits: [{ repositoryKey, commitOid: verification.commitOid }],
        evidence: {
          verified: verification.verifiedTrailer,
          scopeOmitted: verification.scopeOmittedTrailer,
        },
      });
    })();
  }

  const enrichment = await (deps.resolveFinalize ?? resolveLandedFinalizeRequest)({
    dispatchAttemptId: attempt.id,
    commitOid: verification.commitOid,
    repoRoot: repositoryRoot,
    finalizedBy: supervisorId,
    checkpointTurnId: witnessTurn.id,
    createdFromWorkspaceId: pkg.workspaceId,
  });
  if (!enrichment.ok) {
    return {
      outcome: 'accepted-not-landed', packageId: pkg.id, commitOid: verification.commitOid,
      gateAttemptId, unmet: [{ kind: 'finalization-boundary-unavailable' }],
    };
  }
  const declaration = codeDeclaration(pkg.id, pkg.revision);
  const completionWitness: Extract<PlanPackageWitness, { kind: 'completion' }> = {
    kind: 'completion', actor: supervisorId, observedAt,
    candidateTreeOid: enrichment.request.candidateTreeOid,
    verificationTargetVersion: enrichment.request.verificationTargetVersion,
    mutationBlobOidByObligationId: enrichment.request.mutationBlobOidByObligationId,
  };
  const unmet: CompletionReadinessFinding[] = evaluate(
    pkg.id, pkg.revision, declaration, completionWitness, { boundary: 'prospective' },
  );
  if (unmet.length > 0) {
    return {
      outcome: 'accepted-not-landed', packageId: pkg.id,
      commitOid: verification.commitOid, gateAttemptId, unmet,
    };
  }
  let finalized: FinalizePackageResult;
  try {
    finalized = await (deps.finalize ?? finalizePlanItemDone)(enrichment.request);
  } catch {
    return {
      outcome: 'accepted-not-landed', packageId: pkg.id, commitOid: verification.commitOid,
      gateAttemptId, unmet: [{ kind: 'finalization-boundary-unavailable' }],
    };
  }
  return {
    outcome: 'landed', packageId: pkg.id, commitOid: verification.commitOid,
    gateAttemptId, finalizationId: finalized.finalization.id,
  };
}
