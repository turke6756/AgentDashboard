import { create } from 'zustand';
import type { Agent, Workspace, HealthCheck, FileActivity, QueryResult, ContextStats, PathType, FileTab, PanelLayout, GroupThinkSession, Team, TeamMessage, CreateTeamInput } from '../../shared/types';

interface WorkspaceHeat {
  activeCount: number;
  workingCount: number;
}

const DEFAULT_LAYOUT: PanelLayout = {
  sidebarWidth: 256,
  detailPanelWidth: 384,
  terminalHeight: 300,
  directoryTreeWidth: 250,
  sidebarCollapsed: false,
  detailPanelCollapsed: false,
  terminalCollapsed: false,
  directoryTreeCollapsed: false,
};

function loadLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem('panelLayout');
    if (stored) return { ...DEFAULT_LAYOUT, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT };
}

function saveLayout(layout: PanelLayout) {
  localStorage.setItem('panelLayout', JSON.stringify(layout));
}

let tabIdCounter = 0;
function nextTabId(): string {
  return `tab-${++tabIdCounter}`;
}

interface DashboardState {
  workspaces: Workspace[];
  agents: Agent[];
  supervisorAgent: Agent | null;
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  terminalPinned: boolean;
  health: HealthCheck | null;
  loading: boolean;
  detailPane: 0 | 1 | 2;
  fileActivities: FileActivity[];
  workspaceHeat: Record<string, WorkspaceHeat>;
  contextStats: Record<string, ContextStats>;
  groupThinkSessions: GroupThinkSession[];

  // Teams
  teams: Team[];
  teamMessages: Record<string, TeamMessage[]>;

  // Panel layout
  panelLayout: PanelLayout;
  setPanelSize: (key: keyof PanelLayout, value: number) => void;
  togglePanelCollapsed: (key: keyof PanelLayout) => void;
  resetLayout: () => void;

  // Tabbed file viewer
  openTabs: FileTab[];
  activeTabId: string | null;
  fileViewerOpen: boolean;

  // Actions
  loadWorkspaces: () => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  loadAgents: (workspaceId: string) => Promise<void>;
  loadAllAgents: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  selectAgent: (id: string | null) => void;
  setTerminalAgent: (id: string | null) => void;
  toggleTerminalPinned: () => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  deleteAgent: (id: string) => Promise<void>;
  checkHealth: () => Promise<void>;
  setDetailPane: (pane: 0 | 1 | 2) => void;
  setFileActivities: (activities: FileActivity[]) => void;
  addFileActivity: (activity: FileActivity) => void;
  updateWorkspaceHeat: () => void;
  updateContextStats: (stats: ContextStats) => void;
  forkAgent: (id: string) => Promise<Agent | null>;
  queryAgent: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult | null>;
  loadSupervisor: (workspaceId: string) => Promise<void>;
  launchSupervisor: (workspaceId: string) => Promise<Agent | null>;

  // Group Think actions
  loadGroupThinkSessions: (workspaceId: string) => Promise<void>;
  startGroupThink: (workspaceId: string, topic: string, agentIds: string[], maxRounds?: number) => Promise<GroupThinkSession | null>;
  cancelGroupThink: (sessionId: string) => Promise<void>;
  updateGroupThinkSession: (session: GroupThinkSession) => void;

  // Team actions
  loadTeams: (workspaceId: string) => Promise<void>;
  createTeam: (input: CreateTeamInput) => Promise<Team | null>;
  disbandTeam: (teamId: string) => Promise<void>;
  updateTeam: (team: Team) => void;
  loadTeamMessages: (teamId: string) => Promise<void>;
  addTeamMessage: (message: TeamMessage) => void;

  // Tab actions
  openTab: (filePath: string, rootDirectory: string, pathType: PathType, agentId?: string) => void;
  openDirectoryTab: (rootDirectory: string, pathType: PathType) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  closeAllTabs: () => void;
  hideFileViewer: () => void;
  showFileViewer: () => void;
  toggleFileViewer: () => void;

  // Backward-compat shims
  openFileViewer: (filePath: string, agentId: string) => void;
  closeFileViewer: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
  supervisorAgent: null,
  selectedWorkspaceId: null,
  selectedAgentId: null,
  terminalAgentId: null,
  terminalPinned: false,
  health: null,
  loading: false,
  detailPane: 2,
  fileActivities: [],
  workspaceHeat: {},
  contextStats: {},
  groupThinkSessions: [],
  teams: [],
  teamMessages: {},

  // Panel layout
  panelLayout: loadLayout(),

  setPanelSize: (key, value) => {
    set((state) => {
      const layout = { ...state.panelLayout, [key]: value };
      saveLayout(layout);
      return { panelLayout: layout };
    });
  },

  togglePanelCollapsed: (key) => {
    set((state) => {
      const layout = { ...state.panelLayout, [key]: !state.panelLayout[key] };
      saveLayout(layout);
      return { panelLayout: layout };
    });
  },

  resetLayout: () => {
    const layout = { ...DEFAULT_LAYOUT };
    saveLayout(layout);
    set({ panelLayout: layout });
  },

  // Tabbed file viewer
  openTabs: [],
  activeTabId: null,
  fileViewerOpen: false,

  openTab: (filePath, rootDirectory, pathType, agentId?) => {
    const { openTabs } = get();
    // Check if tab already exists for this file+root combo
    const existing = openTabs.find(
      (t) => t.filePath === filePath && t.rootDirectory === rootDirectory
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const label = segments[segments.length - 1] || filePath;

    const tab: FileTab = {
      id: nextTabId(),
      filePath,
      rootDirectory,
      pathType,
      agentId,
      label,
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
    }));
  },

  openDirectoryTab: (rootDirectory, pathType) => {
    const { openTabs, activeTabId } = get();
    // If any tabs already exist for this root, just re-show the file viewer
    // and keep the current active tab if it belongs to this root
    const tabsForRoot = openTabs.filter((t) => t.rootDirectory === rootDirectory);
    if (tabsForRoot.length > 0) {
      const currentActive = tabsForRoot.find((t) => t.id === activeTabId);
      set({ activeTabId: currentActive?.id || tabsForRoot[0].id, fileViewerOpen: true });
      return;
    }

    const normalized = rootDirectory.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const label = (segments[segments.length - 1] || rootDirectory) + '/';

    const tab: FileTab = {
      id: nextTabId(),
      filePath: '',
      rootDirectory,
      pathType,
      label,
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
    }));
  },

  closeTab: (tabId) => {
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return state;
      const newTabs = state.openTabs.filter((t) => t.id !== tabId);
      let newActive = state.activeTabId;
      if (state.activeTabId === tabId) {
        // Activate neighbor
        if (newTabs.length === 0) {
          newActive = null;
        } else if (idx < newTabs.length) {
          newActive = newTabs[idx].id;
        } else {
          newActive = newTabs[newTabs.length - 1].id;
        }
      }
      return {
        openTabs: newTabs,
        activeTabId: newActive,
        fileViewerOpen: newTabs.length > 0,
      };
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  closeAllTabs: () => set({ openTabs: [], activeTabId: null, fileViewerOpen: false }),

  // Hide file viewer without destroying tabs (for back navigation)
  hideFileViewer: () => set({ fileViewerOpen: false }),

  // Show file viewer — restore existing tabs or open workspace directory
  showFileViewer: () => {
    const { openTabs, selectedWorkspaceId, workspaces } = get();
    if (openTabs.length > 0) {
      set({ fileViewerOpen: true });
    } else {
      const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
      if (workspace) {
        get().openDirectoryTab(workspace.path, workspace.pathType);
      }
    }
  },

  toggleFileViewer: () => {
    if (get().fileViewerOpen) {
      get().hideFileViewer();
    } else {
      get().showFileViewer();
    }
  },

  // Backward-compat shim: openFileViewer calls openTab
  openFileViewer: (filePath, agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent) return;
    const workspace = get().workspaces.find((w) => w.id === agent.workspaceId);
    const pathType = workspace?.pathType || 'wsl';
    get().openTab(filePath, agent.workingDirectory, pathType, agentId);
  },

  closeFileViewer: () => get().closeAllTabs(),

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
    const allAgents = await window.api.agents.list(workspaceId);
    const agents = allAgents.filter((a) => !a.isSupervisor);
    const supervisorAgent = allAgents.find((a) => a.isSupervisor) || null;
    set({ agents, supervisorAgent });
    get().updateWorkspaceHeat();
  },

  loadAllAgents: async () => {
    const allAgents = await window.api.agents.listAll();
    const agents = allAgents.filter((a) => !a.isSupervisor);
    set({ agents });
    get().updateWorkspaceHeat();
  },

  selectWorkspace: (id) => {
    if (!get().terminalPinned) {
      set({ selectedWorkspaceId: id, selectedAgentId: null, terminalAgentId: null });
    } else {
      set({ selectedWorkspaceId: id, selectedAgentId: null });
    }
    if (id) {
      get().loadAgents(id);
      get().loadGroupThinkSessions(id);
      get().loadTeams(id);
    }
  },

  selectAgent: (id) => set({ selectedAgentId: id }),

  setTerminalAgent: (id) => set({ terminalAgentId: id }),
  
  toggleTerminalPinned: () => set((state) => ({ terminalPinned: !state.terminalPinned })),

  updateAgent: (agent) => {
    if (agent.isSupervisor) {
      set({ supervisorAgent: agent });
    } else {
      set((state) => {
        const exists = state.agents.some((a) => a.id === agent.id);
        return {
          agents: exists
            ? state.agents.map((a) => (a.id === agent.id ? agent : a))
            : [...state.agents, agent],
        };
      });
    }
  },

  removeAgent: (id) => {
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      supervisorAgent: state.supervisorAgent?.id === id ? null : state.supervisorAgent,
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

  loadSupervisor: async (workspaceId: string) => {
    try {
      const sup = await window.api.agents.getSupervisor(workspaceId);
      set({ supervisorAgent: sup });
    } catch (err) {
      console.error('Failed to load supervisor:', err);
    }
  },

  launchSupervisor: async (workspaceId: string) => {
    // If one already exists and is alive, just select it
    const existing = get().supervisorAgent;
    if (existing && !['done', 'crashed'].includes(existing.status)) {
      get().selectAgent(existing.id);
      get().setTerminalAgent(existing.id);
      return existing;
    }

    try {
      const agent = await window.api.agents.launch({
        workspaceId,
        title: 'Supervisor',
        roleDescription: 'Autonomous supervisor agent — coordinates workers, approves continuations, manages context.',
        isSupervisor: true,
        provider: 'claude',
        autoRestartEnabled: true,
      });
      set({ supervisorAgent: agent });
      return agent;
    } catch (err) {
      console.error('Failed to launch supervisor:', err);
      // Refresh in case it was already running but our state was stale
      await get().loadSupervisor(workspaceId);
      return null;
    }
  },

  updateContextStats: (stats: ContextStats) => {
    set((state) => ({
      contextStats: { ...state.contextStats, [stats.agentId]: stats },
    }));
  },

  loadGroupThinkSessions: async (workspaceId: string) => {
    try {
      const sessions = await window.api.groupthink.list(workspaceId);
      set({ groupThinkSessions: sessions });
    } catch (err) {
      console.error('Failed to load group think sessions:', err);
    }
  },

  startGroupThink: async (workspaceId, topic, agentIds, maxRounds?) => {
    try {
      const session = await window.api.groupthink.start(workspaceId, topic, agentIds, maxRounds);
      set((state) => ({
        groupThinkSessions: [session, ...state.groupThinkSessions],
      }));
      return session;
    } catch (err) {
      console.error('Failed to start group think:', err);
      return null;
    }
  },

  cancelGroupThink: async (sessionId) => {
    try {
      await window.api.groupthink.cancel(sessionId);
      set((state) => ({
        groupThinkSessions: state.groupThinkSessions.map((s) =>
          s.id === sessionId ? { ...s, status: 'cancelled' as const } : s
        ),
      }));
    } catch (err) {
      console.error('Failed to cancel group think:', err);
    }
  },

  updateGroupThinkSession: (session) => {
    set((state) => {
      const exists = state.groupThinkSessions.some((s) => s.id === session.id);
      if (exists) {
        return {
          groupThinkSessions: state.groupThinkSessions.map((s) =>
            s.id === session.id ? session : s
          ),
        };
      }
      return { groupThinkSessions: [session, ...state.groupThinkSessions] };
    });
  },

  // ── Team actions ───────────────────────────────────────────────────────

  loadTeams: async (workspaceId: string) => {
    try {
      const teams = await window.api.teams.list(workspaceId);
      set({ teams });
    } catch (err) {
      console.error('Failed to load teams:', err);
    }
  },

  createTeam: async (input: CreateTeamInput) => {
    try {
      const team = await window.api.teams.create(input);
      set((state) => ({ teams: [team, ...state.teams] }));
      return team;
    } catch (err) {
      console.error('Failed to create team:', err);
      return null;
    }
  },

  disbandTeam: async (teamId: string) => {
    try {
      await window.api.teams.disband(teamId);
      set((state) => ({
        teams: state.teams.map((t) =>
          t.id === teamId ? { ...t, status: 'disbanded' as const } : t
        ),
      }));
    } catch (err) {
      console.error('Failed to disband team:', err);
    }
  },

  updateTeam: (team: Team) => {
    set((state) => {
      const exists = state.teams.some((t) => t.id === team.id);
      if (exists) {
        return { teams: state.teams.map((t) => (t.id === team.id ? team : t)) };
      }
      return { teams: [team, ...state.teams] };
    });
  },

  loadTeamMessages: async (teamId: string) => {
    try {
      const messages = await window.api.teams.getMessages(teamId);
      set((state) => ({
        teamMessages: { ...state.teamMessages, [teamId]: messages },
      }));
    } catch (err) {
      console.error('Failed to load team messages:', err);
    }
  },

  addTeamMessage: (message: TeamMessage) => {
    set((state) => {
      const existing = state.teamMessages[message.teamId] || [];
      return {
        teamMessages: {
          ...state.teamMessages,
          [message.teamId]: [message, ...existing],
        },
      };
    });
  },

  updateWorkspaceHeat: () => {
    const agents = get().agents;
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
