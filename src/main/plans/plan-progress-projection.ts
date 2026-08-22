import type { PlanWorkPackage } from '../database';
import type { PromotedPlanFolder } from '../../shared/types';
import { derivePackageRollup, type PackageStateCounts } from '../../shared/package-rollup';
import { createHash } from 'node:crypto';

export type PlanProgressDetail = 'card' | 'packages';

export interface PlanProgressProjectionInput {
  detail: PlanProgressDetail;
  plan: { id: string; slug: string | null; runState: string | null; updatedAt: string };
  card: PromotedPlanFolder | null;
  /** Must already be in the database's stable package order. */
  packages: readonly PlanWorkPackage[];
  /** Test clock; production reads use the wall clock. */
  nowMs?: number;
}

const CARD_MAX_BYTES = 2 * 1024;
const PACKAGES_MAX_BYTES = 4 * 1024;
const PACKAGES_MAX_ROWS = 40;
const TITLE_MAX_BYTES = 120;
const PACKAGE_STATES = ['blocked', 'executing', 'ready', 'done', 'archived'] as const;

type PackageState = typeof PACKAGE_STATES[number];

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** UTF-8-safe truncation. The ellipsis is included in the byte budget. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') + suffixBytes > maxBytes) break;
    result += character;
  }
  return result + suffix;
}

function stateCounts(packages: readonly PlanWorkPackage[]): PackageStateCounts {
  const counts: PackageStateCounts = { ready: 0, executing: 0, blocked: 0, done: 0, archived: 0 };
  for (const pkg of packages) counts[pkg.state] += 1;
  return counts;
}

function snapshotVersion(planUpdatedAt: string, packages: readonly PlanWorkPackage[]): string {
  const digest = createHash('sha256');
  digest.update(planUpdatedAt);
  for (const pkg of packages) {
    digest.update('\0');
    digest.update(pkg.id);
    digest.update(`:${pkg.revision}:${pkg.updatedAt}`);
  }
  return `sha256:${digest.digest('hex')}`;
}

interface SnapshotFreshness {
  db_snapshot_version: string;
  snapshot_age_s: number | null;
  fresh: boolean;
}

function timestampMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  // SQLite's datetime('now') omits a timezone suffix but is UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotFreshness(input: PlanProgressProjectionInput): SnapshotFreshness {
  const planUpdatedAt = timestampMs(input.plan.updatedAt);
  const packageUpdatedAts = input.packages
    .map((pkg) => timestampMs(pkg.updatedAt))
    .filter((value): value is number => value !== null);
  const dbUpdatedAt = planUpdatedAt === null && packageUpdatedAts.length === 0
    ? null
    : Math.max(...(planUpdatedAt === null ? packageUpdatedAts : [planUpdatedAt, ...packageUpdatedAts]));
  const sourceUpdatedAt = timestampMs(input.card?.updatedAt);
  const projectionsSynced = input.packages.every((pkg) => pkg.projectionStatus === 'synced');
  const nowMs = input.nowMs ?? Date.now();
  return {
    db_snapshot_version: snapshotVersion(input.plan.updatedAt, input.packages),
    snapshot_age_s: dbUpdatedAt === null ? null : Math.max(0, Math.floor((nowMs - dbUpdatedAt) / 1_000)),
    fresh: sourceUpdatedAt !== null
      && dbUpdatedAt !== null
      && sourceUpdatedAt <= dbUpdatedAt
      && projectionsSynced,
  };
}

function buildCard(input: PlanProgressProjectionInput): Record<string, unknown> {
  const { card, plan, packages } = input;
  const freshness = snapshotFreshness(input);
  const fallbackRollup = packages.length > 0 ? derivePackageRollup(stateCounts(packages)) : null;
  const rollup = card?.rollup ?? fallbackRollup;
  const owner = card?.responsibleSupervisor
    ? {
        display: card.responsibleSupervisor.display ?? null,
        agentId: card.responsibleSupervisor.agentId ?? null,
      }
    : null;
  const projection: Record<string, unknown> = {
    planId: plan.id,
    planArtifactId: card?.planArtifactId ?? null,
    title: card?.title ?? plan.slug ?? null,
    badge: card?.lifecycle ?? plan.runState ?? 'unknown',
    latestLifecycleKind: card?.latestLifecycleKind ?? null,
    complete: freshness.fresh ? rollup?.completed ?? null : null,
    owner,
    activityTier: card?.activityTier ?? 'unknown',
    rollup: freshness.fresh ? rollup : 'unknown',
    ...freshness,
  };
  if (jsonBytes(projection) > CARD_MAX_BYTES) {
    projection.title = typeof projection.title === 'string'
      ? truncateUtf8(projection.title, 256)
      : projection.title;
  }
  if (jsonBytes(projection) > CARD_MAX_BYTES) {
    // Owner display is presentation-only; retain its stable id when a pathological
    // title/display would otherwise violate the Stage-0 hard ceiling.
    projection.owner = owner ? { display: null, agentId: owner.agentId } : null;
  }
  if (jsonBytes(projection) > CARD_MAX_BYTES) {
    projection.title = typeof projection.title === 'string'
      ? truncateUtf8(projection.title, 64)
      : projection.title;
  }
  if (jsonBytes(projection) > CARD_MAX_BYTES) {
    projection.title = null;
    projection.planArtifactId = null;
    projection.owner = null;
  }
  if (jsonBytes(projection) > CARD_MAX_BYTES) {
    // Legacy plan ids predate today's UUID contract. A pathological historical
    // value must not break the hard transport ceiling; null is the honest
    // bounded representation when identity itself cannot fit.
    projection.planId = null;
  }
  return projection;
}

function priorityOrdered(packages: readonly PlanWorkPackage[]): PlanWorkPackage[] {
  return [
    ...packages.filter((pkg) => pkg.state === 'blocked'),
    ...packages.filter((pkg) => pkg.state === 'executing'),
    ...packages.filter((pkg) => pkg.state !== 'blocked' && pkg.state !== 'executing'),
  ];
}

function omittedByState(all: readonly PlanWorkPackage[], included: readonly PlanWorkPackage[]): Record<PackageState, number> {
  const omitted: Record<PackageState, number> = { blocked: 0, executing: 0, ready: 0, done: 0, archived: 0 };
  const includedIds = new Set(included.map((pkg) => pkg.id));
  for (const pkg of all) if (!includedIds.has(pkg.id)) omitted[pkg.state] += 1;
  return omitted;
}

function buildPackages(input: PlanProgressProjectionInput): Record<string, unknown> {
  const ordered = priorityOrdered(input.packages);
  const included = ordered.slice(0, PACKAGES_MAX_ROWS);
  const counts = stateCounts(input.packages);
  const freshness = snapshotFreshness(input);
  const render = (): Record<string, unknown> => {
    const omissions = omittedByState(input.packages, included);
    return {
      rollup: freshness.fresh ? derivePackageRollup(counts) : 'unknown',
      packages: included.map((pkg) => ({ id: pkg.id, title: truncateUtf8(pkg.title, TITLE_MAX_BYTES), state: pkg.state })),
      packages_omitted: input.packages.length - included.length,
      packages_omitted_by_state: omissions,
      ...freshness,
    };
  };

  let projection = render();
  while (included.length > 0 && jsonBytes(projection) > PACKAGES_MAX_BYTES) {
    included.pop();
    projection = render();
  }
  return projection;
}

/** REACHABILITY:wp13-plan-progress-construct */
export function buildPlanProgressProjection(input: PlanProgressProjectionInput): Record<string, unknown> {
  return input.detail === 'card' ? buildCard(input) : buildPackages(input);
}

export const PLAN_PROGRESS_LIMITS = {
  cardBytes: CARD_MAX_BYTES,
  packagesBytes: PACKAGES_MAX_BYTES,
  packageRows: PACKAGES_MAX_ROWS,
  titleBytes: TITLE_MAX_BYTES,
} as const;
