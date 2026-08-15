import React from 'react';
import type { AgentPlanNavigation } from './useAgentPlanNavigation';

const VISIBLE_BADGE_LIMIT = 2;

export default function AgentPlanBadges({ navigation }: { navigation: AgentPlanNavigation }) {
  const { destinations, notice, dismissNotice } = navigation;
  if (destinations.length === 0 && !notice) return null;

  const visible = destinations.slice(0, VISIBLE_BADGE_LIMIT);
  const overflow = destinations.length - visible.length;

  return (
    <div className="flex items-center gap-1 min-w-0" aria-label="Owned plans">
      {visible.map((destination) => (
        <span
          key={destination.planArtifactId}
          className="inline-flex min-w-0 max-w-40 items-center gap-1 rounded bg-accent-blue/10 px-1.5 py-0.5 text-[10px] text-accent-blue"
          title={`${destination.title} · ${destination.planArtifactId}`}
          data-testid="agent-plan-badge"
          tabIndex={0}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigation.openPopover(event.clientX, event.clientY, event.currentTarget);
          }}
        >
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" className="shrink-0">
            <path d="M2 2.5h3l1 1H10v6H2z" strokeWidth="1.25" strokeLinejoin="round" />
          </svg>
          <span className="truncate">{destination.title}</span>
        </span>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          className="shrink-0 rounded bg-accent-blue/10 px-1.5 py-0.5 text-[10px] text-accent-blue"
          title={`${overflow} more owned ${overflow === 1 ? 'plan' : 'plans'}`}
          aria-label={`${overflow} more owned ${overflow === 1 ? 'plan' : 'plans'}`}
          data-testid="agent-plan-overflow"
          onClick={(event) => {
            event.stopPropagation();
            navigation.openPicker(event.currentTarget);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigation.openPopover(event.clientX, event.clientY, event.currentTarget);
          }}
        >
          +{overflow}
        </button>
      )}
      {notice && (
        <span role="status" className="text-[10px] text-accent-red">
          {notice}
          <button type="button" onClick={dismissNotice} aria-label="Dismiss plan notice">×</button>
        </span>
      )}
    </div>
  );
}
