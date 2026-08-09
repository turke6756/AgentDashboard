import React, { useEffect, useMemo, useState } from 'react';
import type {
  MissionBoardCard,
  MissionBoardPackageState,
  MissionBoardPackageTimeline,
  PlanDocumentsModel,
} from '../../../shared/types';
import { derivePackageRollup, type PackageStateCounts } from '../../../shared/package-rollup';

// Contract: `plan_work_package_paths` is progress/reachability evidence, not a
// dispatch source. This read-only checklist intentionally never accepts or
// renders package paths as scope.

export interface PlanPackageChecklistRow extends Omit<MissionBoardCard, 'plannedPaths'> {
  sortOrder?: number;
  gloss?: string | null;
  outcome?: string | null;
  projectionStatus?: string | null;
}

export interface PlanPackageChecklistProps {
  planId: string;
  listPackages?: (planId: string) => Promise<PlanPackageChecklistRow[] | null>;
  listTimeline?: (planId: string) => Promise<MissionBoardPackageTimeline[] | null>;
  inspectProjection?: (planId: string) => Promise<'synced' | 'invalid'>;
}

const STATE_PRESENTATION: Record<MissionBoardPackageState, { glyph: string; label: string }> = {
  done: { glyph: '✓', label: 'done' },
  executing: { glyph: '◐', label: 'executing' },
  ready: { glyph: '○', label: 'ready' },
  blocked: { glyph: '▲', label: 'blocked' },
  archived: { glyph: '⌫', label: 'archived' },
};

type ChecklistPlansApi = typeof window.api.plans & {
  boardList?: (planId: string) => Promise<MissionBoardCard[] | null>;
  boardTimeline?: (planId: string) => Promise<MissionBoardPackageTimeline[] | null>;
};

const defaultListPackages = async (planId: string): Promise<PlanPackageChecklistRow[] | null> => {
  const list = (window.api.plans as ChecklistPlansApi).boardList;
  if (!list) throw new Error('Package progress is unavailable.');
  // `plan:board:list` is backed by listPlanWorkPackagesOrdered. Preserve that
  // authoritative order; sortOrder is accepted only for direct/test projections.
  return list(planId);
};

const defaultListTimeline = async (planId: string): Promise<MissionBoardPackageTimeline[] | null> => {
  const list = (window.api.plans as ChecklistPlansApi).boardTimeline;
  return list ? list(planId) : [];
};

async function defaultInspectProjection(planId: string): Promise<'synced' | 'invalid'> {
  const model: PlanDocumentsModel | null = await window.api.plans.documents(planId);
  const invalid = model?.tabs.some((tab) => tab.documents.some(
    (document) => document.machine?.kind === 'work-packages' && document.machine.status === 'invalid',
  ));
  return invalid ? 'invalid' : 'synced';
}

function messageFromError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Package progress is unavailable.';
}

function landedAt(row: PlanPackageChecklistRow, timeline: MissionBoardPackageTimeline[]): number | null {
  if (row.state !== 'done') return null;
  const events = timeline.find((entry) => entry.packageId === row.packageId)?.events ?? [];
  const landed = events.filter((event) => event.toState === 'done').at(-1);
  return landed?.occurredAt ?? null;
}

function landedLabel(timestamp: number | null): string {
  if (timestamp === null) return 'Landed time unavailable';
  return `Landed ${new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(timestamp))}`;
}

export default function PlanPackageChecklist({
  planId,
  listPackages = defaultListPackages,
  listTimeline = defaultListTimeline,
  inspectProjection = defaultInspectProjection,
}: PlanPackageChecklistProps): React.ReactElement {
  const [packages, setPackages] = useState<PlanPackageChecklistRow[]>([]);
  const [timeline, setTimeline] = useState<MissionBoardPackageTimeline[]>([]);
  const [projectionStatus, setProjectionStatus] = useState<'loading' | 'synced' | 'invalid'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setPackages([]);
    setTimeline([]);
    setProjectionStatus('loading');
    setError(null);
    void Promise.all([listPackages(planId), listTimeline(planId), inspectProjection(planId)]).then(
      ([nextPackages, nextTimeline, status]) => {
        if (!active) return;
        setPackages(nextPackages ?? []);
        setTimeline(nextTimeline ?? []);
        setProjectionStatus(status);
      },
      (reason: unknown) => {
        if (!active) return;
        setProjectionStatus('synced');
        setError(messageFromError(reason));
      },
    );
    return () => { active = false; };
  }, [inspectProjection, listPackages, listTimeline, planId]);

  const ordered = useMemo(() => [...packages].sort((left, right) => {
    if (left.sortOrder === undefined && right.sortOrder === undefined) return 0;
    if (left.sortOrder === undefined) return 1;
    if (right.sortOrder === undefined) return -1;
    return left.sortOrder - right.sortOrder;
  }), [packages]);

  const rollup = useMemo(() => {
    const counts: PackageStateCounts = { ready: 0, executing: 0, blocked: 0, done: 0, archived: 0 };
    for (const row of ordered) counts[row.state] += 1;
    return derivePackageRollup(counts);
  }, [ordered]);

  const rowInvalid = ordered.some((row) => row.projectionStatus === 'invalid');
  if (projectionStatus === 'invalid' || rowInvalid) {
    return (
      <section className="plan-package-checklist" data-testid="plan-package-checklist">
        <div role="alert" data-testid="plan-package-checklist-invalid" className="plan-package-checklist__invalid">
          <strong>Packaging invalid</strong>
          <span>Repair the work-package source before using its projected progress.</span>
        </div>
      </section>
    );
  }

  return (
    <section className="plan-package-checklist" data-testid="plan-package-checklist" aria-label="Work-package progress">
      <header className="plan-package-checklist__header">
        <div>
          <h2>Progress</h2>
          <p>Work-package checklist</p>
        </div>
        <span data-testid="plan-package-checklist-rollup" aria-label={`${rollup.landed} of ${rollup.total} landed`}>
          {rollup.landed} of {rollup.total} landed · {rollup.remaining} remaining · {rollup.archived} archived
        </span>
      </header>

      {projectionStatus === 'loading' && <p className="plan-package-checklist__empty">Loading progress…</p>}
      {error && <div role="alert" className="plan-package-checklist__invalid">{error}</div>}
      {projectionStatus === 'synced' && !error && ordered.length === 0 && (
        <p className="plan-package-checklist__empty">No work packages yet.</p>
      )}
      {projectionStatus === 'synced' && !error && ordered.length > 0 && (
        <ol className="plan-package-checklist__rows">
          {ordered.map((row) => {
            const presentation = STATE_PRESENTATION[row.state];
            const when = landedAt(row, timeline);
            const summary = row.gloss?.trim() || row.outcome?.trim()
              || row.acceptanceCondition?.split('\n')[0]?.trim() || 'Outcome unavailable.';
            return (
              <li key={row.packageId} data-testid="plan-package-checklist-row" data-state={row.state}>
                <span
                  className={`plan-package-checklist__glyph plan-package-checklist__glyph--${row.state}`}
                  aria-label={presentation.label}
                  data-testid="plan-package-checklist-glyph"
                >
                  {presentation.glyph}
                </span>
                <div className="plan-package-checklist__copy">
                  <strong>{row.title}</strong>
                  <span data-testid="plan-package-checklist-gloss">{summary}</span>
                </div>
                <time data-testid="plan-package-checklist-landed" dateTime={when === null ? undefined : new Date(when).toISOString()}>
                  {row.state === 'done' ? landedLabel(when) : '—'}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
