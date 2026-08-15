import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlanBadgeDestination } from '../../../shared/types';
import { useDashboardStore, type PlanNavOutcome } from '../../stores/dashboard-store';

export interface PlanDestinationReachability {
  proposalDisabledReason?: string;
}

export interface AgentPlanNavigation {
  destinations: readonly PlanBadgeDestination[];
  reachability: Readonly<Record<string, PlanDestinationReachability>>;
  notice: string | null;
  dismissNotice: () => void;
  goToPlan: (destination: PlanBadgeDestination) => Promise<void>;
  goToProposal: (destination: PlanBadgeDestination) => Promise<void>;
  popover: { x: number; y: number } | null;
  pickerOpen: boolean;
  openPopover: (x: number, y: number, opener: HTMLElement) => void;
  openPicker: (opener: HTMLElement, returnFocusTarget?: HTMLElement) => void;
  dismiss: () => void;
}

function outcomeNotice(outcome: PlanNavOutcome): string | null {
  return outcome.kind === 'opened-main' || outcome.kind === 'revealed-detached'
    ? null
    : outcome.reason;
}

function proposalReason(reason: 'missing' | 'outside-workspace' | 'unreadable'): string {
  if (reason === 'missing') return 'Proposal file is missing.';
  if (reason === 'outside-workspace') return 'Proposal file is outside this workspace.';
  return 'Proposal file is unreadable.';
}

/** One stateful navigation controller is created by each card route and shared by its badges and menus. */
export function useAgentPlanNavigation(
  rawDestinations: readonly PlanBadgeDestination[],
): AgentPlanNavigation {
  const destinations = useMemo(() => {
    const byArtifact = new Map<string, PlanBadgeDestination>();
    for (const destination of rawDestinations) {
      const existing = byArtifact.get(destination.planArtifactId);
      if (!existing) {
        byArtifact.set(destination.planArtifactId, destination);
        continue;
      }
      byArtifact.set(destination.planArtifactId, {
        ...existing,
        relationships: Array.from(new Set([...existing.relationships, ...destination.relationships])),
        proposalPath: existing.proposalPath ?? destination.proposalPath,
        proposalArtifactId: existing.proposalArtifactId ?? destination.proposalArtifactId,
      });
    }
    return Array.from(byArtifact.values());
  }, [rawDestinations]);

  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspace = useDashboardStore((state) => state.workspaces.find((item) => item.id === state.selectedWorkspaceId));
  const openPlanTab = useDashboardStore((state) => state.openPlanTab);
  const openTab = useDashboardStore((state) => state.openTab);
  const [notice, setNotice] = useState<string | null>(null);
  const [reachability, setReachability] = useState<Record<string, PlanDestinationReachability>>({});
  const [popover, setPopover] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismiss = useCallback(() => {
    setPopover(null);
    setPickerOpen(false);
    const opener = openerRef.current;
    openerRef.current = null;
    opener?.focus();
  }, []);
  const openPopover = useCallback((x: number, y: number, opener: HTMLElement) => {
    openerRef.current = opener;
    setPickerOpen(false);
    setPopover({ x, y });
  }, []);
  const openPicker = useCallback((opener: HTMLElement, returnFocusTarget?: HTMLElement) => {
    const rect = opener.getBoundingClientRect();
    // A Plans (N) row is replaced by the picker (and embedded rows unmount with
    // their parent menu), so retain an explicitly surviving card target. For a
    // chip popover, preserve the chip that originally opened the popover.
    openerRef.current = returnFocusTarget ?? (popover ? openerRef.current : opener);
    setPopover({ x: Math.min(rect.left, window.innerWidth - 320), y: Math.min(rect.bottom + 4, window.innerHeight - 280) });
    setPickerOpen(true);
  }, [popover]);

  useEffect(() => {
    if (destinations.length === 0) {
      setReachability((current) => Object.keys(current).length === 0 ? current : {});
      return;
    }
    let cancelled = false;
    void Promise.all(destinations.map(async (destination) => {
      try {
        const model = await window.api.plans.documents(destination.planId);
        if (model?.tabs.some((tab) => tab.key === 'proposal')) return [destination.planArtifactId, {}] as const;
        if (!destination.proposalPath) {
          return [destination.planArtifactId, {
            proposalDisabledReason: model ? 'This plan has no proposal document.' : 'Plan no longer exists and no proposal file is available.',
          }] as const;
        }
        if (!selectedWorkspaceId) return [destination.planArtifactId, { proposalDisabledReason: 'No workspace is selected.' }] as const;
        const resolved = await window.api.files.resolveOpenableWorkspacePath({
          workspaceId: selectedWorkspaceId,
          path: destination.proposalPath,
        });
        return [destination.planArtifactId, resolved.ok ? {} : { proposalDisabledReason: proposalReason(resolved.reason) }] as const;
      } catch {
        // Unknown reachability stays actionable; invocation will report the typed/runtime failure.
        return [destination.planArtifactId, {}] as const;
      }
    })).then((entries) => {
      if (!cancelled) setReachability(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [destinations, selectedWorkspaceId]);

  const goToPlan = useCallback(async (destination: PlanBadgeDestination) => {
    dismiss();
    try {
      const outcome = await openPlanTab(destination.planId, destination.title, selectedWorkspaceId ?? undefined, { tab: 'overview' });
      setNotice(outcomeNotice(outcome));
    } catch (error) {
      setNotice(`Plan navigation failed: ${String(error)}`);
    }
  }, [dismiss, openPlanTab, selectedWorkspaceId]);

  const goToProposal = useCallback(async (destination: PlanBadgeDestination) => {
    dismiss();
    let model = null;
    try {
      model = await window.api.plans.documents(destination.planId);
    } catch {
      // A registered proposal path remains a valid fallback when the plan projection fails.
    }
    if (model?.tabs.some((tab) => tab.key === 'proposal')) {
      try {
        const outcome = await openPlanTab(destination.planId, destination.title, selectedWorkspaceId ?? undefined, { tab: 'proposal' });
        setNotice(outcomeNotice(outcome));
      } catch (error) {
        setNotice(`Proposal navigation failed: ${String(error)}`);
      }
      return;
    }
    if (!destination.proposalPath) {
      setNotice(model ? 'This plan has no proposal document.' : 'Plan no longer exists and no proposal file is available.');
      return;
    }
    if (!selectedWorkspaceId || !workspace) {
      setNotice('No workspace is selected.');
      return;
    }
    try {
      const resolved = await window.api.files.resolveOpenableWorkspacePath({
        workspaceId: selectedWorkspaceId,
        path: destination.proposalPath,
      });
      if (!resolved.ok) {
        setNotice(proposalReason(resolved.reason));
        return;
      }
      openTab(resolved.canonicalPath, workspace.path, workspace.pathType, undefined, selectedWorkspaceId);
      setNotice(null);
    } catch (error) {
      setNotice(`Proposal navigation failed: ${String(error)}`);
    }
  }, [dismiss, openPlanTab, openTab, selectedWorkspaceId, workspace]);

  return useMemo(() => ({
    destinations, reachability, notice, dismissNotice, goToPlan, goToProposal,
    popover, pickerOpen, openPopover, openPicker, dismiss,
  }), [destinations, reachability, notice, dismissNotice, goToPlan, goToProposal, popover, pickerOpen, openPopover, openPicker, dismiss]);
}
