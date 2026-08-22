import * as nodePath from 'path';
import { getDb } from '../database';

interface ExecutingSupervisorPlan {
  planId: string;
  title: string;
}

/**
 * WP-P5D runtime source of truth. `supervisor_focus` is deliberately absent: a
 * retained focus is orientation history, not authority to bind future turns.
 * Requiring both plan state and the durable active-run row makes archive/close
 * immediately remove the default even if `supervisor_active_plan` is retained.
 */
export function getExecutingSupervisorPlan(supervisorId: string | null): ExecutingSupervisorPlan | null {
  if (!supervisorId) return null;
  try {
    const row = getDb().prepare(
      `SELECT p.id AS plan_id, p.slug AS slug, p.path AS path
         FROM supervisor_active_plan sap
         JOIN plans p ON p.id = sap.plan_id
        WHERE sap.supervisor_id = ?
          AND p.responsible_supervisor_id = ?
          AND p.deleted_at IS NULL
          AND p.run_state = 'executing'
          AND EXISTS (
            SELECT 1 FROM plan_execution_runs per
             WHERE per.plan_id = p.id AND per.lifecycle_state = 'active'
          )
        LIMIT 1`,
    ).get(supervisorId, supervisorId) as { plan_id?: unknown; slug?: unknown; path?: unknown } | undefined;
    if (!row || typeof row.plan_id !== 'string') return null;
    const path = typeof row.path === 'string' ? row.path : row.plan_id;
    const title = typeof row.slug === 'string' && row.slug.length > 0
      ? row.slug
      : nodePath.basename(path).replace(/\.(?:html?|md)$/i, '');
    return { planId: row.plan_id, title: title || row.plan_id };
  } catch {
    // Dispatch defaults and orientation text fail closed when DB state is unavailable.
    return null;
  }
}

export function resolveOwnerFocusPlanId(ownerAgentId: string): string | null {
  return getExecutingSupervisorPlan(ownerAgentId)?.planId ?? null;
}
