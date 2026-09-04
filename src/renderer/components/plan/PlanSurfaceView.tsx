import React, { useCallback, useEffect, useRef, useState } from 'react';
import './planSurface.css';
import PlanCandidatePreview, { type PlanCandidatePreviewSelection } from './PlanCandidatePreview';
import type { PlanReviewProjection } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import MissionBoard from './MissionBoard';
import PlanReviewView from './PlanReviewView';
import PlanPackageChecklist from './PlanPackageChecklist';
import PlanEvidenceStrip from '../activity/PlanEvidenceStrip';

/** Right-hand rail for the folder-native plan surface. Its evidence comes from
 * the review/package ledgers; the retired HTML section/activity projection is
 * intentionally absent. */
function PlanSurfaceView({
  workspaceId,
  planId,
  candidateSelection,
}: {
  workspaceId?: string;
  planId?: string;
  candidateSelection?: PlanCandidatePreviewSelection | null;
}): React.ReactElement {
  const [reviewProjection, setReviewProjection] = useState<PlanReviewProjection | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewRequestKeyRef = useRef<string | null>(null);
  const currentReviewKeyRef = useRef<string | null>(null);
  const selectedPlanId = useDashboardStore((state) => {
    const activeTab = state.openTabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind === 'plan' ? activeTab.planId : null;
  });
  const activePlanId = planId ?? selectedPlanId;

  const reviewKey = activePlanId && workspaceId ? `${workspaceId}\0${activePlanId}` : null;
  currentReviewKeyRef.current = reviewKey;

  useEffect(() => {
    reviewRequestKeyRef.current = null;
    setReviewProjection(null);
    setReviewError(null);
  }, [reviewKey]);

  const loadReviewEvidence = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || !activePlanId || !workspaceId || !reviewKey) return;
    if (reviewRequestKeyRef.current === reviewKey) return;
    reviewRequestKeyRef.current = reviewKey;
    setReviewProjection(null);
    setReviewError(null);
    const getReviewProjection = window.api.plans.getReviewProjection;
    if (typeof getReviewProjection !== 'function') {
      setReviewError('Plan review is unavailable.');
      return;
    }
    void getReviewProjection({ workspaceId, planId: activePlanId })
      .then((next) => {
        if (currentReviewKeyRef.current !== reviewKey) return;
        setReviewProjection(next);
        setReviewError(null);
      })
      .catch((error: unknown) => {
        if (currentReviewKeyRef.current !== reviewKey) return;
        setReviewProjection(null);
        setReviewError(error instanceof Error ? error.message : 'Plan review is unavailable.');
      });
  }, [activePlanId, reviewKey, workspaceId]);

  return (
    <div className="plan-surface" data-testid="plan-surface">
      {workspaceId && activePlanId && <PlanEvidenceStrip workspaceId={workspaceId} planId={activePlanId} />}
      {workspaceId && activePlanId && candidateSelection && (
        <div className="plan-surface__candidate" data-testid="plan-candidate-preview">
          <PlanCandidatePreview
            workspaceId={workspaceId}
            planId={activePlanId}
            selection={candidateSelection}
            title="Save this plan's work"
          />
          <p data-testid="plan-save-disabled">Review and undo now replace Save.</p>
        </div>
      )}
      {activePlanId ? (
        <PlanPackageChecklist planId={activePlanId} />
      ) : (
        <div className="mission-board__empty" data-testid="mission-board-no-plan">No active plan selected.</div>
      )}
      {activePlanId && (
        <details data-testid="plan-package-operations">
          <summary>Advanced package operations</summary>
          <MissionBoard planId={activePlanId} paneVisible />
        </details>
      )}
      <details data-testid="plan-review-evidence" onToggle={loadReviewEvidence}>
        <summary>Change evidence (diff)</summary>
        {reviewProjection ? (
          <PlanReviewView projection={reviewProjection} />
        ) : (
          <div className="mission-board__empty" data-testid="plan-review-unavailable">
            {reviewError ?? 'Loading plan review…'}
          </div>
        )}
      </details>
    </div>
  );
}

export default PlanSurfaceView;
