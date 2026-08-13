import React, { useState } from 'react';
import type { SaveIntentUnitDto } from '../../../shared/types';

export function hasCaptureConcern(unit: SaveIntentUnitDto): boolean {
  return unit.topologyEvidence.captureHealth.captureOutage
    || unit.topologyEvidence.captureHealth.turns.some((turn) => turn.failureClass !== 'none');
}

export function isQuietlySaved(unit: SaveIntentUnitDto): boolean {
  return unit.state === 'committed' || unit.state === 'superseded';
}

export default function SaveBundle({
  unit,
  pinned = false,
  pinning = false,
  onPin,
  pinDisabled = false,
  pinReason,
}: {
  unit: SaveIntentUnitDto;
  pinned?: boolean;
  pinning?: boolean;
  onPin?: () => void;
  pinDisabled?: boolean;
  pinReason?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const health = unit.topologyEvidence.captureHealth;
  return (
    <div className="sc-bundle" data-testid="save-bundle" data-intent-id={unit.intentId}>
      <div className="sc-bundle-head">
        <div>
          <strong>{unit.title}</strong>
          <span> · {unit.members.length} file{unit.members.length === 1 ? '' : 's'}</span>
        </div>
        {onPin && (
          <>
          <button type="button" className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
            data-testid="save-bundle-pin" disabled={pinning || pinned || pinDisabled}
            aria-describedby={pinDisabled && pinReason ? `save-reason-${unit.intentId}` : undefined}
            onClick={onPin}>
            {pinning ? 'Preparing…' : pinned ? 'Prepared' : 'Prepare'}
          </button>
          {pinDisabled && pinReason && <span id={`save-reason-${unit.intentId}`} className="sc-meta">{pinReason}</span>}
          </>
        )}
      </div>
      <div className="sc-meta">
        {unit.planItem?.title ?? unit.plan?.title ?? 'Unplanned task'}
        {unit.membershipStale ? ' · Membership stale — review required' : ''}
      </div>
      <div className="sc-meta" data-testid="save-contributor-roster">
        <strong>Contributors</strong>
        <ul>
          {unit.contributors.length > 0 ? unit.contributors.map((contributor) => (
            <li key={contributor.agentId ?? contributor.name}>
              {contributor.name}: {contributor.fileCount} of {unit.members.length} files
              ({contributor.fileSharePercent}%)
            </li>
          )) : <li>No agent identity recorded</li>}
        </ul>
      </div>
      {hasCaptureConcern(unit) && (
        <div className="sc-meta" data-testid="save-bundle-capture-concern">
          Capture evidence is incomplete; review before saving.
        </div>
      )}
      <button type="button" className="sc-link" aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}>
        {expanded ? 'Hide evidence' : 'Attribution evidence'}
      </button>
      {expanded && (
        <div className="sc-meta" data-testid="save-bundle-detail">
          {unit.contributors.map((contributor) => contributor.name).join(', ') || 'No agent identity recorded'}
          {unit.topologyEvidence.componentIds.length > 0
            ? ` · ${unit.topologyEvidence.componentIds.length} topology component(s)` : ''}
          {health.pathsWithoutFinalizationEdge.length > 0
            ? ` · ${health.pathsWithoutFinalizationEdge.length} path(s) not yet finalized` : ''}
        </div>
      )}
    </div>
  );
}
