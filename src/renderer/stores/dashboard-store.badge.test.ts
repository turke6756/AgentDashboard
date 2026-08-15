// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentPlanBadge, Workspace } from '../../shared/types';
import { useDashboardStore } from './dashboard-store';

const workspace = { id: 'ws-1', path: 'C:\\repo', pathType: 'windows' } as Workspace;
const agent = { id: 'agent-1', workspaceId: workspace.id, status: 'idle' } as Agent;
const empty: Record<string, AgentPlanBadge> = {};
const destinations = [{
  kind: 'promoted-plan' as const,
  planId: 'plan-row-one',
  planArtifactId: 'plan-one',
  title: 'Plan One',
  relationships: ['carrying' as const],
}];
const populated = { [agent.id]: destinations as unknown as AgentPlanBadge };

let getBadges: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getBadges = vi.fn(async () => empty);
  (window as any).api = {
    agents: {
      getAgentPlanBadgeSummary: getBadges,
      list: vi.fn(async () => [agent]),
    },
  };
  useDashboardStore.setState({
    selectedWorkspaceId: workspace.id,
    agents: [agent],
    agentPlanBadges: {},
  });
});

describe('agent plan badge refresh rule', () => {
  it('loads once for an initial workspace badge load and stores the result', async () => {
    getBadges.mockResolvedValueOnce(populated);

    await useDashboardStore.getState().loadAgentPlanBadges(workspace.id);

    expect(getBadges).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(populated);
    expect(useDashboardStore.getState().agentPlanBadges[agent.id].authored).toEqual([]);
    expect(useDashboardStore.getState().agentPlanBadges[agent.id].carrying).toEqual(['plan-one']);
    expect(Object.keys(useDashboardStore.getState().agentPlanBadges[agent.id])).toEqual(['0']);
  });

  it('reapplies the compatibility view to the same destination array reference', async () => {
    getBadges.mockResolvedValue(populated);

    await expect(useDashboardStore.getState().loadAgentPlanBadges(workspace.id)).resolves.toBeUndefined();
    await expect(useDashboardStore.getState().loadAgentPlanBadges(workspace.id)).resolves.toBeUndefined();

    expect(getBadges).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().agentPlanBadges[agent.id]).toBe(destinations);
    expect(useDashboardStore.getState().agentPlanBadges[agent.id].authored).toEqual([]);
    expect(useDashboardStore.getState().agentPlanBadges[agent.id].carrying).toEqual(['plan-one']);
  });

  it('does not fetch badges when an agent status refresh calls loadAgents', async () => {
    await useDashboardStore.getState().loadAgentPlanBadges(workspace.id);
    const beforeStatusChange = getBadges.mock.calls.length;

    await useDashboardStore.getState().loadAgents(workspace.id);

    // This observes the bridge invocation count across the real loadAgents seam;
    // it does not infer absence from source structure.
    expect(getBadges).toHaveBeenCalledTimes(beforeStatusChange);
  });

  it('re-selecting the ALREADY-current workspace still refreshes badges (early-return gap)', async () => {
    // The whole app boots with a workspace already current (or the user clicks
    // the highlighted workspace again). selectWorkspace short-circuits on
    // id === outgoing, so before the fix that path never pulled badges and the
    // grid rendered no plan roles — exactly Edward's symptom.
    (window as any).api.teams = { list: vi.fn(async () => []) };
    getBadges.mockResolvedValue(populated);
    useDashboardStore.setState({ selectedWorkspaceId: workspace.id, agentPlanBadges: {} });

    useDashboardStore.getState().selectWorkspace(workspace.id); // same id = re-selection
    await new Promise((r) => setTimeout(r, 0));

    expect(getBadges).toHaveBeenCalledWith(workspace.id);
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(populated);
  });

  it('REACHABILITY:badge-refresh-rule recovers when the initial fetch races boot reconciliation and a pane refresh finds the plan', async () => {
    getBadges.mockResolvedValueOnce(empty).mockResolvedValueOnce(populated);

    await useDashboardStore.getState().loadAgentPlanBadges(workspace.id);
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(empty);

    // Models the existing plans-pane refresh cycle re-pulling badges after the
    // detached plan-folder reconciliation has settled.
    await useDashboardStore.getState().loadAgentPlanBadges(workspace.id);

    expect(getBadges).toHaveBeenCalledTimes(2);
    expect(useDashboardStore.getState().agentPlanBadges).toEqual(populated);
  });
});
