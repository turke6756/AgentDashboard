import React from 'react';
import ProposalCardGallery from './ProposalCardGallery';
import PromotedPlansList from './PromotedPlansList';
import { usePlansPaneState } from './plans-pane-state';
import { useDashboardStore } from '../../stores/dashboard-store';

/** First-class Plans center pane. WP-UX-B/C populate the two reserved regions. */
export default function PlansPane(): React.ReactElement {
  const proposalExpanded = usePlansPaneState((state) => state.expandedProposalId !== null);
  const setExpandedProposalId = usePlansPaneState((state) => state.setExpandedProposalId);
  const openResearchInLibrary = (): void => {
    setExpandedProposalId(null);
    useDashboardStore.getState().openToolTab('library', 'Library', { params: { type: 'research' } });
  };
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-0 scrollbar-thin ${proposalExpanded ? '' : 'gap-4 p-6'}`}
      data-testid="plans-pane"
      data-proposal-expanded={proposalExpanded ? 'true' : 'false'}
    >
      <div className="flex shrink-0 gap-1" aria-label="Plans gallery actions">
        <span className="rounded bg-accent-blue/15 px-3 py-1.5 text-[12px] font-medium text-accent-blue" data-testid="plans-tab-proposals">Proposals</span>
        <button type="button" className="rounded px-3 py-1.5 text-[12px] font-medium text-gray-400 hover:bg-white/5 hover:text-gray-200" onClick={openResearchInLibrary}>Open in Library</button>
      </div>
      <ProposalCardGallery />
      {!proposalExpanded && <PromotedPlansList />}
    </div>
  );
}
