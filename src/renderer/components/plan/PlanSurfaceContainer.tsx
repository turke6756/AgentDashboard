import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import PlanSurfaceView from './PlanSurfaceView';
import PlanDocumentTabs from './PlanDocumentTabs';
import type { PlanCandidatePreviewSelection } from './PlanCandidatePreview';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { PlanDocumentNavigationRequest } from '../../stores/dashboard-store';

/** Folder-native plan surface. Legacy HTML panes and their activity projection
 * were retired in P8; the document tabs and DB/Git-backed review/package rails
 * are the only surviving surfaces. */
interface PlanSurfaceContainerProps {
  planId: string;
  navigationRequest?: PlanDocumentNavigationRequest;
}

export default function PlanSurfaceContainer({
  planId,
  navigationRequest,
}: PlanSurfaceContainerProps): React.ReactElement {
  const [candidateSelection, setCandidateSelection] = useState<PlanCandidatePreviewSelection | null>(null);
  const closeTab = useDashboardStore((s) => s.closeTab);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const resolvePlanNavigation = useDashboardStore((s) => s.resolvePlanNavigation);

  const handleNavigationResolved = useCallback((result: Parameters<typeof resolvePlanNavigation>[1] & { requestId: string }) => {
    const { requestId, ...resolution } = result;
    resolvePlanNavigation(requestId, resolution);
  }, [resolvePlanNavigation]);

  const dismiss = useCallback(() => {
    const { openTabs, selectedWorkspaceId: workspaceId } = useDashboardStore.getState();
    const tab = openTabs.find(
      (t) => t.kind === 'plan' && t.planId === planId && t.workspaceId === workspaceId,
    ) ?? openTabs.find((t) => t.kind === 'plan' && t.planId === planId);
    if (tab) closeTab(tab.id);
  }, [planId, closeTab]);

  useEffect(() => {
    if (!selectedWorkspaceId) {
      setCandidateSelection(null);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const res = await window.api.plans.previewCandidate({
          workspaceId: selectedWorkspaceId,
          planId,
          selectedComponentIds: [],
          selectedUnattributedEntryIds: [],
          finalizationIds: [],
        });
        if (active) setCandidateSelection(res.candidate.members.length > 0 ? res.selection : null);
      } catch {
        if (active) setCandidateSelection(null);
      }
    })();
    return () => { active = false; };
  }, [planId, selectedWorkspaceId]);

  return (
    <div className="h-full flex min-h-0" data-testid="plan-surface-container">
      <div className="flex-1 min-w-0 min-h-0" data-testid="plan-doc-region">
        <PlanDocumentTabs
          planId={planId}
          navigationRequest={navigationRequest}
          onNavigationResolved={handleNavigationResolved}
        />
      </div>
      <div className="w-[384px] shrink-0 min-h-0 flex flex-col border-l dark:border-white/10 light:border-black/10">
        <div className="shrink-0 flex items-center justify-between px-3 py-1.5 border-b dark:border-white/10 light:border-black/10">
          <span className="text-[11px] uppercase tracking-wide text-gray-400">Work packages</span>
          <button
            onClick={dismiss}
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-gray-200"
            title="Close plan"
            aria-label="Close plan"
            data-testid="plan-surface-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <PlanSurfaceView
          workspaceId={selectedWorkspaceId ?? undefined}
          planId={planId}
          candidateSelection={candidateSelection}
        />
      </div>
    </div>
  );
}
