import { create } from 'zustand';
import type { Agent, Workspace, HealthCheck, FileActivity, QueryResult, ContextStats, PathType, FileTab, PanelLayout } from '../../shared/types';

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
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  health: HealthCheck | null;
  loading: boolean;
  detailPane: 0 | 1 | 2;
  fileActivities: FileActivity[];
  workspaceHeat: Record<string, WorkspaceHeat>;
  contextStats: Record<string, ContextStats>;

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

  // Tab actions
  openTab: (filePath: string, rootDirectory: string, pathType: PathType, agentId?: string) => void;
  openDirectoryTab: (rootDirectory: string, pathType: PathType) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  closeAllTabs: () => void;

  // Backward-compat shims
  openFileViewer: (filePath: string, agentId: string) => void;
  closeFileViewer: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
  selectedWorkspaceId: null,
  selectedAgentId: null,
  terminalAgentId: null,
  health: null,
  loading: false,
  detailPane: 2,
  fileActivities: [],
  workspaceHeat: {},
  contextStats: {},

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
    const { openTabs } = get();
    // Check if a directory-only tab already exists for this root
    const existing = openTabs.find(
      (t) => t.filePath === '' && t.rootDirectory === rootDirectory
    );
    if (existing) {
      set({ activeTabId: existing.id, fileViewerOpen: true });
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
    set({ selectedWorkspaceId: id, selectedAgentId: null, terminalAgentId: null });
    if (id) get().loadAgents(id);
  },

  selectAgent: (id) => set({ selectedAgentId: id }),

  setTerminalAgent: (id) => set({ terminalAgentId: id }),

  updateAgent: (agent) => {
    set((state) => ({
      agents: state.agents.map((a) => (a.id === agent.id ? agent : a)),
    }));
  },

  removeAgent: (id) => {
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
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

  updateContextStats: (stats: ContextStats) => {
    set((state) => ({
      contextStats: { ...state.contextStats, [stats.agentId]: stats },
    }));
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
