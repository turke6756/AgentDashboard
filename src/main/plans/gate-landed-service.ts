import {
  findGateLandedPositiveWitnessTurn,
  getDb,
  getPlanDispatchAttempt,
  getPlanPackageEvidenceProjection,
  getPlanPackageGateAttempt,
  getPlanWorkPackage,
  getWorkspace,
  getTurnRecord,
  listCommitGlobalTurnLinks,
  listCurrentRevisionSuccessorDispatches,
  listPlanPackageGateCommitLinks,
  nextPlanPackageGateAttemptNo,
  reconcilePlanDispatchAttempts,
  type PlanDispatchAttempt,
  type PlanWorkPackage,
  type TurnRecord,
  type CurrentRevisionSuccessorDispatch,
} from '../database';
import type {
  GateDecisionEvidenceV2,
  GateLandedRefusal,
  GateLandedResult,
  GateLandedWorkPackageArgs,
  GateWitnessEvidence,
  LandedCommitEvidenceV2,
  ManualGateObservation,
  PostClaimTouchClassificationV2,
} from '../../shared/types';
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
import { briefedWorkPackageId } from './work-package-id';
import type { FinalizePackageResult } from '../commit-engine/finalization-service';

const ACCEPTANCE_GATE = 'supervisor-acceptance';
const ACCEPTANCE_GATE_REVISION = 2;
const FULL_OID = /^[0-9a-f]{40}$/i;

type PlanAuthority = {
  id: string;
  workspaceId: string;
  artifactId: string | null;
  responsibleSupervisorId: string | null;
  landedGateMode: string | null;
};

export interface GateLandedServiceDeps {
  getAttempt?: (id: string) => PlanDispatchAttempt | null;
  getPackage?: (id: string) => PlanWorkPackage | null;
  getPlanAuthority?: (id: string) => PlanAuthority | null;
  getRepositoryRoot?: (workspaceId: string) => string | null;
  findWitness?: (input: Parameters<typeof findGateLandedPositiveWitnessTurn>[0]) => TurnRecord | null;
  listCommitLinks?: typeof listCommitGlobalTurnLinks;
  listSuccessors?: typeof listCurrentRevisionSuccessorDispatches;
  listGateCommitLinks?: typeof listPlanPackageGateCommitLinks;
  getTurn?: (id: string) => TurnRecord | null;
  gitOracle?: (repoRoot: string) => LandedCommitGitOracle;
  verify?: typeof verifyLandedCommit;
  transition?: (command: PlanPackageCommand, witness: PlanPackageWitness) => TransitionResult;
  evaluate?: typeof evaluateCompletionReadiness;
  reconcile?: typeof reconcilePlanDispatchAttempts;
  resolveTargetSessionId?: (attemptId: string) => string | null;
  resolveFinalize?: typeof resolveLandedFinalizeRequest;
  finalize?: typeof finalizePlanItemDone;
  now?: () => number;
}

function defaultPlanAuthority(id: string): PlanAuthority | null {
  const row = getDb().prepare(
    `SELECT id, workspace_id, artifact_id, responsible_supervisor_id, landed_gate_mode
       FROM plans WHERE (id = ? OR artifact_id = ?) AND deleted_at IS NULL`,
  ).get(id, id) as {
    id: string; workspace_id: string; artifact_id: string | null;
    responsible_supervisor_id: string | null; landed_gate_mode: string | null;
  } | undefined;
  return row ? {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id,
    responsibleSupervisorId: row.responsible_supervisor_id,
    landedGateMode: row.landed_gate_mode,
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

function refuseWithOverride(args: GateLandedWorkPackageArgs, reason: GateLandedRefusal): GateLandedResult {
  return refused(args.override ? 'override-invalid' : reason);
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = new Set(left); const b = new Set(right);
  return a.size === left.length && b.size === right.length
    && a.size === b.size && [...a].every((value) => b.has(value));
}

function validOverrideReason(reason: string): string | null {
  const trimmed = reason.trim();
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  return bytes >= 1 && bytes <= 1000 ? trimmed : null;
}

function validManualObservation(
  observation: ManualGateObservation | undefined,
  args: GateLandedWorkPackageArgs,
  attempt: PlanDispatchAttempt,
  pkg: PlanWorkPackage,
  planArtifactId: string,
): observation is ManualGateObservation {
  return !!observation
    && FULL_OID.test(observation.gateTipOid)
    && FULL_OID.test(observation.namedCommitOid)
    && FULL_OID.test(observation.parentOid)
    && observation.namedCommitOid.toLowerCase() === args.commit_oid.toLowerCase()
    && observation.planLabel === planArtifactId
    && asciiLower(observation.wpLabel) === asciiLower(briefedWorkPackageId(pkg.id, planArtifactId))
    && samePathSet(observation.changedPaths, attempt.frozenPaths ?? []);
}

function classifyPostClaimTouches(
  evidence: LandedCommitEvidenceV2,
  successors: readonly CurrentRevisionSuccessorDispatch[],
  planArtifactId: string,
  listGateLinks: typeof listPlanPackageGateCommitLinks,
): PostClaimTouchClassificationV2[] | null {
  const touches = evidence.postClaimTouches;
  const knownOlderTip = (touchIndex: number, dispatchTipOid: string): boolean => {
    if (dispatchTipOid === evidence.dispatchTipOid || dispatchTipOid === evidence.namedCommit.commitOid) return true;
    return touches.slice(touchIndex + 1).some((touch) => touch.commitOid === dispatchTipOid);
  };
  const classified: PostClaimTouchClassificationV2[] = [];
  for (let touchIndex = 0; touchIndex < touches.length; touchIndex += 1) {
    const touch = touches[touchIndex];
    if (touch.parentOids.length !== 1) return null;
    const qualifying = successors.filter(({ attempt }) => !!attempt.dispatchTipOid
      && knownOlderTip(touchIndex, attempt.dispatchTipOid)
      && touch.planTrailers.length === 1 && touch.planTrailers[0] === planArtifactId
      && touch.wpTrailers.length === 1
      && asciiLower(touch.wpTrailers[0]) === asciiLower(briefedWorkPackageId(attempt.packageId, planArtifactId))
      && samePathSet(touch.paths, attempt.frozenPaths ?? []));
    if (qualifying.length === 0) return null;
    const qualifyingDispatchAttemptIds = qualifying.map(({ attempt }) => attempt.id).sort();
    const successorGateAttemptIds = [...new Set(qualifying.flatMap(({ passedGateAttemptIds }) =>
      passedGateAttemptIds.filter((gateAttemptId) => listGateLinks(gateAttemptId)
        .some((link) => link.repositoryKey === evidence.repositoryKey && link.commitOid === touch.commitOid))))].sort();
    const successorPackageIds = [...new Set(qualifying.map(({ attempt }) => attempt.packageId))].sort();
    classified.push({
      commitOid: touch.commitOid,
      parentOid: touch.parentOids[0],
      paths: [...touch.paths],
      disposition: successorGateAttemptIds.length > 0
        ? 'accounted-successor-gated' : 'accounted-successor-dispatch',
      successorPackageId: successorPackageIds[0],
      qualifyingDispatchAttemptIds,
      successorGateAttemptIds,
    });
  }
  return classified;
}

function evaluateWitness(
  attempt: PlanDispatchAttempt,
  repositoryKey: string,
  commitOid: string,
  witnessTurn: TurnRecord | null,
  links: ReturnType<typeof listCommitGlobalTurnLinks>,
  getTurn: (id: string) => TurnRecord | null,
): GateWitnessEvidence {
  const conflict = links.map((link) => getTurn(link.turnId)).find((turn) => !!turn
    && (turn.agentId !== attempt.targetAgentId || turn.sessionId !== attempt.targetSessionId));
  if (conflict) return {
    state: 'conflicting', turnId: conflict.id, agentId: conflict.agentId,
    sessionId: conflict.sessionId, captureFailure: null, observedAt: conflict.endedAt ?? conflict.startedAt,
  };
  if (!attempt.targetAgentId || !attempt.targetSessionId) return {
    state: 'degraded', turnId: null, agentId: attempt.targetAgentId,
    sessionId: attempt.targetSessionId, captureFailure: 'target attribution unavailable', observedAt: null,
  };
  if (!witnessTurn) return {
    state: 'absent', turnId: null, agentId: attempt.targetAgentId,
    sessionId: attempt.targetSessionId, captureFailure: null, observedAt: null,
  };
  const commitLinked = links.some((link) => link.turnId === witnessTurn.id
    && link.repositoryKey === repositoryKey && link.commitOid === commitOid);
  if (commitLinked) return {
    state: 'commit-linked', turnId: witnessTurn.id, agentId: witnessTurn.agentId,
    sessionId: witnessTurn.sessionId, captureFailure: null,
    observedAt: witnessTurn.endedAt ?? witnessTurn.startedAt,
  };
  const captureFailure = witnessTurn.failureReason
    ?? (!witnessTurn.beforeReady || !witnessTurn.afterReady ? 'checkpoint capture not ready' : null);
  if (captureFailure) return {
    state: 'degraded', turnId: null, agentId: witnessTurn.agentId,
    sessionId: witnessTurn.sessionId, captureFailure,
    observedAt: witnessTurn.endedAt ?? witnessTurn.startedAt,
  };
  return {
    state: 'paths-witnessed', turnId: witnessTurn.id, agentId: witnessTurn.agentId,
    sessionId: witnessTurn.sessionId, captureFailure: null,
    observedAt: witnessTurn.endedAt ?? witnessTurn.startedAt,
  };
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
  const findWitness = deps.findWitness ?? findGateLandedPositiveWitnessTurn;
  const transition = deps.transition ?? transitionPlanPackage;
  const evaluate = deps.evaluate ?? evaluateCompletionReadiness;

  const plan = getPlanAuthority(args.plan_id);
  if (!plan || plan.responsibleSupervisorId !== supervisorId) {
    return refuseWithOverride(args, 'not-responsible-supervisor');
  }
  const mode = plan.landedGateMode === null ? 'light'
    : plan.landedGateMode === 'light' || plan.landedGateMode === 'strict' ? plan.landedGateMode : null;
  if (!mode) return refuseWithOverride(args, 'gate-mode-invalid');
  const overrideReason = args.override ? validOverrideReason(args.override.reason) : null;
  if (args.override && !overrideReason) return refused('override-invalid');
  // Gate invocation is also a convergence edge: retry a turn that landed after
  // prompt delivery before classifying the durable attempt as unconfirmed.
  (deps.reconcile ?? reconcilePlanDispatchAttempts)();
  const attempt = getAttempt(args.dispatch_attempt_id);
  if (!attempt) return refuseWithOverride(args, 'dispatch-attempt-not-found');
  if (attempt.planId !== plan.id) return refuseWithOverride(args, 'attempt-plan-mismatch');
  if ((attempt.state !== 'delivered' && attempt.state !== 'reconciled') || !attempt.confirmedTurnId) {
    return refuseWithOverride(args, 'attempt-unconfirmed');
  }
  const pkg = getPackage(attempt.packageId);
  if (!pkg || pkg.planId !== plan.id || attempt.packageRevision !== pkg.revision) {
    return refuseWithOverride(args, 'stale-attempt-revision');
  }
  if (attempt.captureStatus !== 'captured' || !attempt.repositoryKey || !attempt.branchRef
      || !attempt.dispatchTipOid || !attempt.frozenPaths?.length
      || !pkg.intentId || attempt.intentId !== pkg.intentId || !plan.artifactId) {
    return refuseWithOverride(args, 'dispatch-evidence-unavailable');
  }
  const repositoryRoot = deps.getRepositoryRoot?.(pkg.workspaceId)
    ?? getWorkspace(pkg.workspaceId)?.path ?? null;
  if (!repositoryRoot) return refuseWithOverride(args, 'dispatch-evidence-unavailable');
  const repositoryKey = attempt.repositoryKey;

  const verify = deps.verify ?? verifyLandedCommit;
  const verification: LandedCommitVerification = await verify({
    repositoryKey,
    branchRef: attempt.branchRef,
    dispatchTipOid: attempt.dispatchTipOid,
    frozenPaths: attempt.frozenPaths,
    planArtifactId: plan.artifactId,
    wpId: briefedWorkPackageId(pkg.id, plan.artifactId),
    commitOid: args.commit_oid,
  }, (deps.gitOracle ?? createGitOracle)(repositoryRoot));
  let git: GateDecisionEvidenceV2['git'];
  let commitOid: string;
  let parentOid: string;
  let postClaimClassification: PostClaimTouchClassificationV2[] = [];
  let decision: GateDecisionEvidenceV2['decision'] = 'passed';
  let appliedOverride: GateDecisionEvidenceV2['override'] = null;
  if (verification.outcome === 'refused') {
    const reason = verification.reason;
    const manualOverride = reason === 'branch-unresolvable' || reason === 'verifier-unavailable';
    if (!args.override || args.override.refusal !== reason || !manualOverride
        || !validManualObservation(args.override.manualObservation, args, attempt, pkg, plan.artifactId)) {
      return args.override ? refused('override-invalid') : refused(reason);
    }
    git = { source: 'manual-testimony', observation: args.override.manualObservation,
      unverifiedBecause: reason };
    commitOid = args.override.manualObservation.namedCommitOid.toLowerCase();
    parentOid = args.override.manualObservation.parentOid.toLowerCase();
    decision = 'passed-by-override';
    appliedOverride = { refusal: reason, reason: overrideReason! };
  } else {
    if (!verification.evidence) return refuseWithOverride(args, 'verifier-unavailable');
    const evidence = verification.evidence;
    const classified = classifyPostClaimTouches(
      evidence,
      (deps.listSuccessors ?? listCurrentRevisionSuccessorDispatches)({
        planId: plan.id, excludePackageId: pkg.id, repositoryKey, branchRef: attempt.branchRef,
      }),
      plan.artifactId,
      deps.listGateCommitLinks ?? listPlanPackageGateCommitLinks,
    );
    if (!classified) return refuseWithOverride(args, 'post-claim-touch-unaccounted');
    postClaimClassification = classified;
    git = { source: 'app-verifier', evidence };
    commitOid = evidence.namedCommit.commitOid;
    parentOid = evidence.namedCommit.parentOid;
  }

  const links = (deps.listCommitLinks ?? listCommitGlobalTurnLinks)(repositoryKey, commitOid);
  const witnessTurn = attempt.targetAgentId && attempt.targetSessionId ? findWitness({
    dispatchAttemptId: attempt.id, repositoryKey, commitOid, frozenPaths: attempt.frozenPaths,
  }) : null;
  const witness = evaluateWitness(
    attempt, repositoryKey, commitOid, witnessTurn, links, deps.getTurn ?? getTurnRecord,
  );
  const witnessRefusal: GateLandedRefusal | null = witness.state === 'conflicting'
    ? 'commit-witness-conflict' : witness.state === 'absent' ? 'commit-witness-unavailable' : null;
  if (mode === 'strict' && witnessRefusal) {
    if (witnessRefusal !== 'commit-witness-unavailable' || !args.override
        || args.override.refusal !== witnessRefusal || git.source !== 'app-verifier'
        || args.override.manualObservation !== undefined) {
      return args.override ? refused('override-invalid') : refused(witnessRefusal);
    }
    decision = 'passed-by-override';
    appliedOverride = { refusal: witnessRefusal, reason: overrideReason! };
  } else if (args.override && !appliedOverride) {
    return refused('override-invalid');
  }

  if (git.source === 'app-verifier') {
    const reread = await (deps.gitOracle ?? createGitOracle)(repositoryRoot)
      .resolveCommit(repositoryKey, `${attempt.branchRef}^{commit}`);
    if (reread !== git.evidence.gateTipOid) return refuseWithOverride(args, 'branch-tip-moved');
  }

  // Idempotency digests include the nested commit-record timestamp. Anchor it to
  // the immutable confirmed dispatch rather than retry wall-clock time.
  const observedAt = attempt.confirmedAt ?? attempt.reconciledAt ?? attempt.createdAt;
  const gateKey = `gate-landed:${attempt.id}:${commitOid}`;
  const gateAttemptId = `package-ledger:${gateKey}`;
  if (!getPlanPackageGateAttempt(gateAttemptId)) {
    const ledgerTurnId = witness.state === 'commit-linked' || witness.state === 'paths-witnessed'
      ? witness.turnId : null;
    transition({
      type: 'commits-observed',
      ...identity(pkg, plan, `gate-landed-observed:${attempt.id}:${commitOid}`),
    }, {
      kind: 'git', actor: supervisorId, observedAt, turnId: ledgerTurnId,
      commits: [{
        repositoryKey,
        commitOid,
        parentOid,
        observedAt,
        source: 'external',
        pushedRemoteCount: 0,
        lastReconciledAt: null,
      }],
    });
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
        witnessAgentId: ledgerTurnId ? witness.agentId : null,
        witnessSessionId: ledgerTurnId ? witness.sessionId : null,
        witnessTurnId: ledgerTurnId,
        verifiedCommits: [{ repositoryKey, commitOid }],
        evidence: {
          schemaVersion: 2, mode, decision, git, postClaimClassification,
          witness, override: appliedOverride,
        } satisfies GateDecisionEvidenceV2,
      });
    })();
  }

  const enrichment = await (deps.resolveFinalize ?? resolveLandedFinalizeRequest)({
    dispatchAttemptId: attempt.id,
    commitOid,
    repoRoot: repositoryRoot,
    finalizedBy: supervisorId,
    checkpointTurnId: witness.state === 'commit-linked' || witness.state === 'paths-witnessed'
      ? witness.turnId : null,
    createdFromWorkspaceId: pkg.workspaceId,
  });
  if (!enrichment.ok) {
    return {
      outcome: 'accepted-not-landed', packageId: pkg.id, commitOid,
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
      commitOid, gateAttemptId, unmet,
    };
  }
  let finalized: FinalizePackageResult;
  try {
    finalized = await (deps.finalize ?? finalizePlanItemDone)(enrichment.request);
  } catch {
    return {
      outcome: 'accepted-not-landed', packageId: pkg.id, commitOid,
      gateAttemptId, unmet: [{ kind: 'finalization-boundary-unavailable' }],
    };
  }
  return {
    outcome: 'landed', packageId: pkg.id, commitOid,
    gateAttemptId, finalizationId: finalized.finalization.id,
  };
}
