import { useCallback, useMemo, useState } from 'react';
import type { PlanBadgeDestination } from '../../../shared/types';

export interface AgentPlanNavigation {
  destinations: readonly PlanBadgeDestination[];
  notice: string | null;
  dismissNotice: () => void;
}

/** One controller instance per card route; later packages add its commands. */
export function useAgentPlanNavigation(
  destinations: readonly PlanBadgeDestination[],
): AgentPlanNavigation {
  const [notice, setNotice] = useState<string | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return useMemo(() => ({ destinations, notice, dismissNotice }), [destinations, notice, dismissNotice]);
}
