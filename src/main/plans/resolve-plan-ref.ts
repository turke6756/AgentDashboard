import {
  getPlan,
  getPlanByWorkspaceArtifactId,
  getPlanIntentRow,
} from '../database';
import {
  isCanonicalPlanRowId,
  isPlanArtifactId,
  type PlanRefErrorCode,
} from '../../shared/planning-artifact-ids';

export class PlanRefError extends Error {
  readonly statusCode: number;
  readonly code: PlanRefErrorCode;

  constructor(statusCode: number, code: PlanRefErrorCode, message: string) {
    super(message);
    this.name = 'PlanRefError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ResolvedPlanRow {
  id: string;
  workspaceId: string;
  path: string | null;
  deletedAt: string | null;
  artifactId: string | null;
}

export interface ResolvedPlanRef {
  planId: string;
  plan: ResolvedPlanRow;
}

export interface ResolvedActivePlanRef extends ResolvedPlanRef {
  intent: { intentId: string; status: string };
}

function malformed(ref: string): PlanRefError {
  return new PlanRefError(
    400,
    'plan_ref_malformed',
    `plan_id '${ref}' must be a plan row UUID or a portable plan artifact id matching plan_<8hex>.`,
  );
}

export function resolvePlanRef(workspaceId: string, ref: string): ResolvedPlanRef {
  let plan: ResolvedPlanRow | null;

  if (isCanonicalPlanRowId(ref)) {
    const row = getPlan(ref);
    plan = row
      ? {
          id: row.id,
          workspaceId: row.workspaceId,
          path: row.path,
          deletedAt: row.deletedAt,
          artifactId: (row as typeof row & { artifactId?: string | null }).artifactId ?? null,
        }
      : null;
  } else if (isPlanArtifactId(ref)) {
    const row = getPlanByWorkspaceArtifactId(workspaceId, ref);
    plan = row
      ? {
          id: row.id,
          workspaceId: row.workspaceId,
          path: row.path,
          deletedAt: row.deletedAt,
          artifactId: row.artifactId,
        }
      : null;
  } else {
    throw malformed(ref);
  }

  if (!plan) {
    throw new PlanRefError(
      404,
      'plan_not_found',
      `No plan matching plan_id '${ref}' exists in the requested workspace scope.`,
    );
  }
  if (plan.deletedAt !== null) {
    throw new PlanRefError(
      409,
      'plan_deleted',
      `Plan '${ref}' resolves to a deleted plan row; deleted plans are not a valid target.`,
    );
  }
  if (plan.workspaceId !== workspaceId) {
    throw new PlanRefError(
      403,
      'plan_wrong_workspace',
      `Plan '${ref}' does not belong to workspace '${workspaceId}'.`,
    );
  }

  return { planId: plan.id, plan };
}

export function resolveActivePlanRef(
  workspaceId: string,
  ref: string,
  intentId: string,
): ResolvedActivePlanRef {
  const resolved = resolvePlanRef(workspaceId, ref);
  const intent = getPlanIntentRow(workspaceId, resolved.planId, intentId);
  if (!intent) {
    throw new PlanRefError(
      404,
      'planning_intent_not_found',
      `Planning intent '${intentId}' is not recorded for plan '${resolved.planId}' (resolved from '${ref}').`,
    );
  }
  if (intent.status !== 'active') {
    throw new PlanRefError(
      409,
      'planning_intent_not_active',
      `Planning intent '${intentId}' for plan '${resolved.planId}' has status '${intent.status}'; expected 'active'.`,
    );
  }

  return { ...resolved, intent: { intentId, status: intent.status } };
}
