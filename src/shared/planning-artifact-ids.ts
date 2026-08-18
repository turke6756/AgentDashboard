export const PROPOSAL_ARTIFACT_ID_RE = /^prop_[0-9a-f]{8}$/;
export const PLAN_ARTIFACT_ID_RE = /^plan_[0-9a-f]{8}$/;
export const PLANNING_INTENT_ID_RE = /^int_[0-9a-f]{8}$/;
/** Canonical stored uuidv4() shape used by the plans.id identity contract. */
export const PLAN_ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PLAN_REF_ERROR_CODES = [
  'plan_ref_malformed',
  'plan_not_found',
  'plan_deleted',
  'plan_wrong_workspace',
  'planning_intent_not_found',
  'planning_intent_not_active',
  'plan_ref_resume_mismatch',
] as const;

export type PlanRefErrorCode = typeof PLAN_REF_ERROR_CODES[number];

export function isProposalArtifactId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ARTIFACT_ID_RE.test(value);
}

export function isPlanArtifactId(value: unknown): value is string {
  return typeof value === 'string' && PLAN_ARTIFACT_ID_RE.test(value);
}

export function isPlanningIntentId(value: unknown): value is string {
  return typeof value === 'string' && PLANNING_INTENT_ID_RE.test(value);
}

export function isCanonicalPlanRowId(value: unknown): value is string {
  return typeof value === 'string' && PLAN_ROW_ID_RE.test(value);
}
