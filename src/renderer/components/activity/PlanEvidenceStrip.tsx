import React, { useEffect, useState } from 'react';
import type { ActivityCounts } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';

export default function PlanEvidenceStrip({ workspaceId, planId }: { workspaceId: string; planId: string }): React.ReactElement {
  const showActivity = useDashboardStore((state) => state.showActivity);
  const loadActivity = useDashboardStore((state) => state.loadActivity);
  const [counts, setCounts] = useState<ActivityCounts | null>(null);

  useEffect(() => {
    let current = true;
    const list = window.api.activity?.list;
    if (typeof list !== 'function') return () => { current = false; };
    void list({ workspaceId, planId, preview: 'sync', limit: 50, fileActivityLimit: 50 })
      .then((page) => { if (current) setCounts(page.pageCounts); })
      .catch(() => { if (current) setCounts(null); });
    return () => { current = false; };
  }, [planId, workspaceId]);

  const openEvidence = () => {
    showActivity({ planId });
    void loadActivity(workspaceId, { planId });
  };

  return (
    <button type="button" onClick={openEvidence} className="ui-card w-full p-3 text-left hover:bg-white/[0.03]" data-testid="plan-evidence-strip">
      <div className="text-[10px] uppercase tracking-wider text-accent-purple">Observed evidence</div>
      <div className="mt-1 text-[12px] text-gray-400">
        {counts
          ? `${counts.turnCount} turns · ${counts.agentCount} agents · ${counts.fileCount} files · ${counts.commitCount} commits · ${counts.noCheckpointCount} without restore points · ${counts.blockedOverlapCount.status === 'complete' ? counts.blockedOverlapCount.value : 'checking'} overlaps`
          : 'Loading plan activity…'}
      </div>
      <div className="mt-1 text-[10px] text-gray-600">Observed activity points to what to review; it does not verify the outcome.</div>
    </button>
  );
}
