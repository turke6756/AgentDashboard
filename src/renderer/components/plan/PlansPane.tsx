import React, { useState } from 'react';
import ProposalCardGallery from './ProposalCardGallery';
import PromotedPlansList from './PromotedPlansList';
import ResearchCardGallery from './ResearchCardGallery';
import { usePlansPaneState } from './plans-pane-state';

/** First-class Plans center pane. WP-UX-B/C populate the two reserved regions. */
export default function PlansPane(): React.ReactElement {
  const proposalExpanded = usePlansPaneState((state) => state.expandedProposalId !== null);
  const setExpandedProposalId = usePlansPaneState((state) => state.setExpandedProposalId);
  const [galleryTab, setGalleryTab] = useState<'proposals' | 'research'>('proposals');
  const selectTab = (tab: 'proposals' | 'research'): void => {
    if (tab === 'research') setExpandedProposalId(null);
    setGalleryTab(tab);
  };
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-0 scrollbar-thin ${proposalExpanded && galleryTab === 'proposals' ? '' : 'gap-4 p-6'}`}
      data-testid="plans-pane"
      data-proposal-expanded={proposalExpanded && galleryTab === 'proposals' ? 'true' : 'false'}
    >
      <div className="flex shrink-0 gap-1" role="tablist" aria-label="Plans gallery">
        {(['proposals', 'research'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={galleryTab === tab}
            className={`rounded px-3 py-1.5 text-[12px] font-medium ${galleryTab === tab ? 'bg-accent-blue/15 text-accent-blue' : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'}`}
            onClick={() => selectTab(tab)}
            data-testid={`plans-tab-${tab}`}
          >
            {tab === 'proposals' ? 'Proposals' : 'Research'}
          </button>
        ))}
      </div>
      {galleryTab === 'proposals' ? <ProposalCardGallery /> : <ResearchCardGallery />}
      {(galleryTab === 'research' || !proposalExpanded) && <PromotedPlansList />}
    </div>
  );
}
