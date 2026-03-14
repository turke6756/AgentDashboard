import { create } from 'zustand';
import type { Agent, Workspace, HealthCheck, FileActivity, QueryResult } from '../../shared/types';

interface WorkspaceHeat {
  activeCount: number;
  workingCount: number;
}

interface DashboardState {
  workspaces: Workspace[];
  agents: Agent[];
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  health: HealthCheck | null;
  loading: boolean;
  detailPane: 0 | 1 | 2;
  fileActivities: FileActivity[];
  workspaceHeat: Record<string, WorkspaceHeat>;

  // Actions
  loadWorkspaces: () => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  loadAgents: (workspaceId: string) => Promise<void>;
  loadAllAgents: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  selectAgent: (id: string | null) => void;
  setTerminalAgent: (id: string | null) => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  deleteAgent: (id: string) => Promise<void>;
  checkHealth: () => Promise<void>;
  setDetailPane: (pane: 0 | 1 | 2) => void;
  setFileActivities: (activities: FileActivity[]) => void;
  addFileActivity: (activity: FileActivity) => void;
  updateWorkspaceHeat: () => void;
  forkAgent: (id: string) => Promise<Agent | null>;
  queryAgent: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult | null>;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
  selectedWorkspaceId: null,
  selectedAgentId: null,
  terminalAgentId: null,
  health: null,
  loading: false,
  detailPane: 2, // Default to Log tab
  fileActivities: [],
  workspaceHeat: {},

  loadWorkspaces: async () => {
    const workspaces = await window.api.workspaces.list();
    set({ workspaces });
  },

  deleteWorkspace: async (id: string) => {
    await window.api.workspaces.delete(id);
    const { selectedWorkspaceId } = get();
    if (selectedWorkspaceId === id) {
      set({ selectedWorkspaceId: null, agents: [], selectedAgentId: null, terminalAgentId: null });
    }
    await get().loadWorkspaces();
    get().updateWorkspaceHeat();
  },

  loadAgents: async (workspaceId: string) => {
    const agents = await window.api.agents.list(workspaceId);
    set({ agents });
    get().updateWorkspaceHeat();
  },

  loadAllAgents: async () => {
    const agents = await window.api.agents.listAll();
    set({ agents });
    get().updateWorkspaceHeat();
  },

  selectWorkspace: (id) => {
    set({ selectedWorkspaceId: id, selectedAgentId: null });
    if (id) get().loadAgents(id);
  },

  selectAgent: (id) => set({ selectedAgentId: id }),

  setTerminalAgent: (id) => set({ terminalAgentId: id }),

  updateAgent: (agent) => {
    set((state) => ({
      agents: state.agents.map(a => a.id === agent.id ? agent : a),
    }));
  },

  removeAgent: (id) => {
    set((state) => ({
      agents: state.agents.filter(a => a.id !== id),
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
      terminalAgentId: state.terminalAgentId === id ? null : state.terminalAgentId,
    }));
  },

  deleteAgent: async (id) => {
    await window.api.agents.delete(id);
    get().removeAgent(id);
    get().updateWorkspaceHeat();
  },

  checkHealth: async () => {
    const health = await window.api.system.healthCheck();
    set({ health });
  },

  setDetailPane: (pane) => set({ detailPane: pane }),

  setFileActivities: (activities) => set({ fileActivities: activities }),

  addFileActivity: (activity) => {
    set((state) => ({
      fileActivities: [activity, ...state.fileActivities],
    }));
  },

  forkAgent: async (id) => {
    try {
      const forked = await window.api.agents.fork(id);
      set((state) => ({ agents: [forked, ...state.agents] }));
      get().updateWorkspaceHeat();
      return forked;
    } catch (err) {
      console.error('Fork failed:', err);
      return null;
    }
  },

  queryAgent: async (targetAgentId, question, sourceAgentId?) => {
    try {
      return await window.api.agents.query(targetAgentId, question, sourceAgentId);
    } catch (err) {
      console.error('Query failed:', err);
      return null;
    }
  },

  updateWorkspaceHeat: () => {
    const agents = get().agents;
    // Also compute from all agents we know about
    const heat: Record<string, WorkspaceHeat> = {};
    for (const agent of agents) {
      if (agent.status === 'done' || agent.status === 'crashed') continue;
      if (!heat[agent.workspaceId]) {
        heat[agent.workspaceId] = { activeCount: 0, workingCount: 0 };
      }
      heat[agent.workspaceId].activeCount++;
      if (agent.status === 'working') {
        heat[agent.workspaceId].workingCount++;
      }
    }
    set({ workspaceHeat: heat });
  },
}));
