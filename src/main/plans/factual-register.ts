import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getDb,
  getPlanPackageEvidenceProjection,
  getWorkspace,
  listPackageFinalizations,
  listPlanWorkPackagesOrdered,
  type PackageFinalization,
  type PlanPackageEvidenceProjection,
  type PlanWorkPackage,
} from '../database';
import type {
  AssertedDispatchEvidence,
  FactualFinding,
  LandedFact,
  MissionBoardPackageState,
  PackageFactualRegister,
  PlanFactualRegister,
} from '../../shared/types';
import { discoverAssertedDispatchEvidence } from './asserted-tier';
import { checkArcAgainstLedger, type ArcStatusCheckResult } from './arc-status-check';
import { createGitOracle } from './landed-commit-verifier';
import {
  evaluateCompletionReadiness,
  type CompletionDeclaration,
  type CompletionReadinessFinding,
  type PlanPackageWitness,
} from './package-ledger';

export interface FactualRegisterDeps {
  listPackages(planId: string): PlanWorkPackage[];
  discoverAsserted(planId: string): Promise<AssertedDispatchEvidence[]>;
  getProjection(packageId: string, revision: number): PlanPackageEvidenceProjection | null;
  listFinalizations(packageId: string): PackageFinalization[];
  countStampedTurns(planId: string, packageId: string): number;
  resolveArcPath(planId: string): string | null;
  checkArc(planId: string, arcPath: string, states: ReadonlyMap<string, MissionBoardPackageState>): Promise<ArcStatusCheckResult>;
  evaluateReadiness: typeof evaluateCompletionReadiness;
  cacheKey(planId: string, arcPath: string | null): Promise<string>;
}

const cache = new Map<string, { key: string; value: PlanFactualRegister }>();

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveArcPath(planId: string): string | null {
  const row = getDb().prepare(
    'SELECT workspace_id, folder_rel_path FROM plans WHERE id = ? AND deleted_at IS NULL',
  ).get(planId) as { workspace_id: string; folder_rel_path: string | null } | undefined;
  if (!row?.folder_rel_path) return null;
  const workspace = getWorkspace(row.workspace_id);
  if (!workspace) return null;
  const folder = path.resolve(workspace.path, ...row.folder_rel_path.split('/'));
  const relative = path.relative(path.resolve(workspace.path), folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(folder, 'ARC.md');
}

function countStampedTurns(planId: string, packageId: string): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) AS count FROM turn_records WHERE plan_id = ? AND plan_item_id = ?',
  ).get(planId, packageId) as { count: number };
  return Number(row.count);
}

async function defaultCacheKey(planId: string, arcPath: string | null): Promise<string> {
  const db = getDb();
  // These append-only maxima/counts are evidence high-water marks. State-bearing
  // rows include their mutable terminal columns so reconciliation updates also
  // invalidate without relying on plan_work_packages.updated_at.
  const queries = [
    [`SELECT COUNT(*) n, COALESCE(MAX(rowid),0) r, COALESCE(MAX(confirmed_at),0) a,
        COALESCE(MAX(reconciled_at),0) b, GROUP_CONCAT(state || ':' || capture_status) s
       FROM plan_dispatch_attempts WHERE plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(rowid),0) r, COALESCE(MAX(created_at),0) a,
        COALESCE(MAX(decided_at),0) b, GROUP_CONCAT(outcome || ':' || gate_key) s
       FROM plan_package_gate_attempts WHERE plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(l.rowid),0) r, COALESCE(MAX(l.created_at),0) a
       FROM plan_package_gate_commit_links l JOIN plan_package_gate_attempts g
         ON g.id = l.gate_attempt_id WHERE g.plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(rowid),0) r, COALESCE(MAX(occurred_at),0) a
       FROM plan_package_deployment_events WHERE plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(f.rowid),0) r, COALESCE(MAX(f.finalized_at),0) a,
        GROUP_CONCAT(f.boundary_status || ':' || f.lifecycle_status) s
       FROM package_finalizations f JOIN plan_work_packages p ON p.id=f.package_id
       WHERE p.plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(e.rowid),0) r, COALESCE(MAX(e.verified_at),0) a
       FROM plan_wp_reachability_evidence e JOIN plan_wp_reachability_obligations o
         ON o.id=e.obligation_id JOIN plan_work_packages p ON p.id=o.package_id
       WHERE p.plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(turn_seq),0) r, COALESCE(MAX(ended_at),0) a
       FROM turn_records WHERE plan_id = ?`, [planId]],
    [`SELECT COUNT(*) n, COALESCE(MAX(rowid),0) r, COALESCE(MAX(updated_at),0) a,
        GROUP_CONCAT(id || ':' || revision || ':' || state) s
       FROM plan_work_packages WHERE plan_id = ?`, [planId]],
  ] as const;
  const marks = queries.map(([sql, params]) => db.prepare(sql).get(...params));
  const attempts = db.prepare(
    `SELECT d.repository_key, d.branch_ref, a.path AS repository_root
       FROM plan_dispatch_attempts d
       LEFT JOIN planning_activity_worktrees a ON a.execution_run_id=d.execution_run_id
      WHERE d.plan_id=? AND d.state IN ('delivered','reconciled')
      ORDER BY d.id`,
  ).all(planId) as Array<{ repository_key: string | null; branch_ref: string | null; repository_root: string | null }>;
  const tips: Array<string | null> = [];
  for (const attempt of attempts) {
    if (!attempt.repository_key || !attempt.branch_ref || !attempt.repository_root) { tips.push(null); continue; }
    try { tips.push(await createGitOracle(attempt.repository_root).resolveCommit(attempt.repository_key, attempt.branch_ref)); }
    catch { tips.push(null); }
  }
  let arcDigest = 'absent';
  if (arcPath) {
    try { arcDigest = digest(await readFile(arcPath)); } catch { arcDigest = 'unavailable'; }
  }
  return digest(JSON.stringify({ marks, tips, arcDigest }));
}

function latestAcceptedLinks(projection: PlanPackageEvidenceProjection) {
  const acceptance = projection.latestGateAttempts.filter(
    (gate) => gate.gateKey === 'supervisor-acceptance' && gate.outcome === 'passed',
  );
  return acceptance.flatMap((gate) => projection.gateCommitLinks
    .filter((link) => link.gateAttemptId === gate.id)
    .map((link) => ({ gate, link })));
}

function readiness(
  projection: PlanPackageEvidenceProjection,
  evaluate: typeof evaluateCompletionReadiness,
): CompletionReadinessFinding[] {
  const latestIds = new Set(projection.latestGateAttempts.map((gate) => gate.id));
  const commits = projection.gateCommitLinks.filter((link) => latestIds.has(link.gateAttemptId));
  const declaration: CompletionDeclaration = {
    kind: 'code',
    requiredGateKeys: projection.latestGateAttempts.map((gate) => gate.gateKey),
    implementationCommits: [...new Map(commits.map((link) => [
      `${link.repositoryKey}:${link.commitOid}`,
      { repositoryKey: link.repositoryKey, commitOid: link.commitOid },
    ])).values()],
    boundary: 'ready',
    deploymentEnvironments: projection.latestDeploymentEvents.map((event) => event.environment),
    behavior: true,
  };
  const witness: Extract<PlanPackageWitness, { kind: 'completion' }> = {
    kind: 'completion', actor: 'factual-register', observedAt: Date.now(),
  };
  try { return evaluate(projection.package.id, projection.package.revision, declaration, witness, { boundary: 'prospective' }); }
  catch (error) {
    return [{ kind: 'finalization-boundary-unavailable' }];
  }
}

function projectLanded(
  pkg: PlanWorkPackage,
  projection: PlanPackageEvidenceProjection,
  finalizations: PackageFinalization[],
): LandedFact | null {
  if (pkg.state !== 'done') return null;
  const finalization = finalizations.find((item) => item.packageRevision === pkg.revision
    && item.finalizationKind === 'plan-package' && item.planId === pkg.planId
    && item.planItemId === pkg.id && item.boundaryStatus === 'ready'
    && (item.lifecycleStatus === 'active' || item.lifecycleStatus === 'committed'));
  if (!finalization) return null;
  const latestIds = new Set(projection.latestGateAttempts
    .filter((gate) => gate.outcome === 'passed').map((gate) => gate.id));
  const links = projection.gateCommitLinks.filter((link) => latestIds.has(link.gateAttemptId));
  if (links.length === 0) return null;
  return {
    state: 'done', finalizationId: finalization.id,
    finalizedAt: finalization.finalizedAt, finalizedBy: finalization.finalizedBy,
    declarationCommitOids: [...new Set(links.map((link) => link.commitOid))],
    gateAttemptIds: [...new Set(links.map((link) => link.gateAttemptId))],
  };
}

function defaults(): FactualRegisterDeps {
  return {
    listPackages: listPlanWorkPackagesOrdered,
    discoverAsserted: discoverAssertedDispatchEvidence,
    getProjection: getPlanPackageEvidenceProjection,
    listFinalizations: listPackageFinalizations,
    countStampedTurns,
    resolveArcPath,
    checkArc: checkArcAgainstLedger,
    evaluateReadiness: evaluateCompletionReadiness,
    cacheKey: defaultCacheKey,
  };
}

export async function projectPlanFactualRegister(
  planId: string,
  deps: FactualRegisterDeps = defaults(),
): Promise<PlanFactualRegister> {
  const arcPath = deps.resolveArcPath(planId);
  const key = await deps.cacheKey(planId, arcPath);
  const prior = cache.get(planId);
  if (prior?.key === key) return prior.value;

  const packages = deps.listPackages(planId);
  const asserted = await deps.discoverAsserted(planId);
  const byPackage = new Map<string, AssertedDispatchEvidence[]>();
  for (const evidence of asserted) {
    byPackage.set(evidence.packageId, [...(byPackage.get(evidence.packageId) ?? []), evidence]);
  }
  const states = new Map(packages.map((pkg) => [pkg.id, pkg.state as MissionBoardPackageState]));
  const arc = arcPath
    ? await deps.checkArc(planId, arcPath, states)
    : { arcFindings: [{ kind: 'arc-status-not-declared' }], packageFindings: new Map() } as ArcStatusCheckResult;

  const resultPackages: PackageFactualRegister[] = packages.map((pkg) => {
    const packageAsserted = byPackage.get(pkg.id) ?? [];
    const findings: FactualFinding[] = [];
    const projection = deps.getProjection(pkg.id, pkg.revision);
    if (!projection) {
      findings.push({ kind: 'evidence-unavailable', scope: 'asserted', detail: 'ledger projection unavailable' });
      return { packageId: pkg.id, asserted: packageAsserted, landed: null, findings };
    }
    const landed = projectLanded(pkg, projection, deps.listFinalizations(pkg.id));
    const accepted = latestAcceptedLinks(projection);
    const acceptedByOid = new Map(accepted.map((item) => [item.link.commitOid, item]));
    const assertedOids = [...new Set(packageAsserted.flatMap((item) => item.candidates.map((candidate) => candidate.commitOid)))];

    for (const item of packageAsserted) {
      if (item.scanStatus !== 'complete') findings.push({
        kind: 'evidence-unavailable', scope: 'asserted',
        detail: item.scanStatus === 'truncated' ? `dispatch ${item.dispatchAttemptId} scan truncated`
          : `dispatch ${item.dispatchAttemptId}: ${item.refusal ?? 'unavailable'}`,
      });
    }
    if (!landed) {
      for (const commitOid of assertedOids) {
        const declaration = acceptedByOid.get(commitOid);
        if (declaration && pkg.state !== 'done') findings.push({
          kind: 'accepted-not-landed', commitOid,
          gateAttemptId: declaration.gate.id,
          unmet: readiness(projection, deps.evaluateReadiness),
        });
        else if (!declaration) findings.push({ kind: 'commit-without-declaration', commitOid });
      }
    } else {
      for (const declared of landed.declarationCommitOids) for (const shown of assertedOids) {
        if (declared !== shown) findings.push({ kind: 'declaration-commit-mismatch', declared, asserted: shown });
      }
    }
    if (pkg.state === 'done' && !landed) findings.push({ kind: 'done-without-finalization-citation' });
    if (pkg.state === 'done' && deps.countStampedTurns(planId, pkg.id) === 0) {
      findings.push({ kind: 'declaration-without-witness' });
    }
    findings.push(...(arc.packageFindings.get(pkg.id) ?? []));
    if (arc.unavailableDetail) findings.push({
      kind: 'evidence-unavailable', scope: 'arc', detail: arc.unavailableDetail,
    });
    return { packageId: pkg.id, asserted: packageAsserted, landed, findings };
  });
  const value = { packages: resultPackages, arcFindings: arc.arcFindings };
  cache.set(planId, { key, value });
  return value;
}

export function clearFactualRegisterCache(): void { cache.clear(); }
