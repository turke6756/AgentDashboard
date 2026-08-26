import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDashboardStore } from '../../stores/dashboard-store';
import { usePlanFactualRegister, type PlanFactualRegisterRead } from '../../stores/mission-board-store';
import { planArcFindingText } from './MissionBoard';

interface PlanOverviewBarProps {
  body: string | null;
  pendingMessage: string;
  canEdit: boolean;
  onEdit: () => void;
}

/** Compact read presentation for a tab's plain-language overview.
 *
 * Expansion is deliberately local, ephemeral UI state: each mounted bar starts
 * collapsed and nothing is written to storage. The editor remains owned by
 * PlanDocumentTabs so collapsing this read view cannot gate authoring.
 */
export default function PlanOverviewBar({
  body,
  pendingMessage,
  canEdit,
  onEdit,
}: PlanOverviewBarProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hasOverview = Boolean(body && body.trim().length > 0);
  const activePlanId = useDashboardStore((state) => {
    const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind === 'plan' ? activeTab.planId : null;
  });
  const readRegister: PlanFactualRegisterRead = React.useCallback((planId) => {
    const factualRegister = window.api.plans.factualRegister;
    return factualRegister ? factualRegister(planId) : Promise.resolve(null);
  }, []);
  const factual = usePlanFactualRegister(activePlanId, Boolean(activePlanId), readRegister);

  return (
    <div data-testid="plan-overview-bar">
      <div className="flex min-h-8 items-center justify-between gap-3 px-6 py-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="plan-overview-bar-content"
          onClick={() => setExpanded((value) => !value)}
          data-testid="plan-overview-toggle"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] font-medium text-gray-300 hover:text-gray-100"
        >
          <span aria-hidden="true" className="w-3 text-[10px] text-gray-500">
            {expanded ? 'v' : '>'}
          </span>
          <span>Simple overview</span>
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            data-testid="plan-overview-edit"
            className="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-200"
          >
            {hasOverview ? 'Edit' : 'Add overview'}
          </button>
        )}
      </div>
      <div id="plan-overview-bar-content" hidden={!expanded} className="px-6 pb-3 pt-1">
        {(factual.register?.arcFindings ?? []).map((finding) => (
          <div
            className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200"
            data-testid={`overview-factual-finding-${finding.kind}`}
            data-finding={finding.kind}
            role="status"
            key={finding.kind}
          >
            {planArcFindingText(finding)}
          </div>
        ))}
        {factual.error && (
          <div className="mb-2 text-[11px] text-amber-300" role="status">
            Factual register unavailable: {factual.error}
          </div>
        )}
        {hasOverview ? (
          <div className="prose-custom min-w-0 max-w-3xl text-[13px] text-gray-300" data-testid="plan-tab-overview-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{body!}</ReactMarkdown>
          </div>
        ) : (
          <div className="text-[12px] italic text-gray-500" data-testid="plan-overview-pending">
            {pendingMessage}
          </div>
        )}
      </div>
    </div>
  );
}
