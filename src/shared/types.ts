export type PathType = 'windows' | 'wsl';
export type AgentProvider = 'claude' | 'gemini' | 'codex';
export type GroupThinkStatus = 'active' | 'synthesizing' | 'completed' | 'cancelled';

// ── Team types ──────────────────────────────────────────────────────────
export type TeamStatus = 'active' | 'paused' | 'disbanded';
export type TeamTemplate = 'groupthink' | 'pipeline' | 'custom';
export type TeamTaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type TeamMessageStatus = 'request' | 'question' | 'complete' | 'blocked' | 'update';

export type AgentStatus =
  | 'launching'
  | 'working'
  | 'idle'
  | 'waiting'
  | 'done'
  | 'crashed'
  | 'restarting';

export interface Workspace {
  id: string;
  title: string;
  path: string;
  pathType: PathType;
  description: string;
  defaultCommand: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface Agent {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  roleDescription: string;
  workingDirectory: string;
  command: string;
  provider: AgentProvider;
  isSupervisor: boolean;
  isSupervised: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  resumeSessionId: string | null;
  status: AgentStatus;
  isAttached: boolean;
  restartCount: number;
  lastExitCode: number | null;
  pid: number | null;
  logPath: string | null;
  templateId: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string | null;
  lastAttachedAt: string | null;
}

export interface AgentEvent {
  id: number;
  agentId: string;
  eventType: string;
  payload: string | null;
  createdAt: string;
}

export type FileOperation = 'read' | 'write' | 'create';

export interface FileActivity {
  id: number;
  agentId: string;
  filePath: string;
  operation: FileOperation;
  timestamp: string;
}

export interface CreateWorkspaceInput {
  title: string;
  path: string;
  pathType: PathType;
  description?: string;
  defaultCommand?: string;
}

export interface LaunchAgentInput {
  workspaceId: string;
  title: string;
  roleDescription?: string;
  workingDirectory?: string;
  command?: string;
  provider?: AgentProvider;
  autoRestartEnabled?: boolean;
  isSupervisor?: boolean;
  isSupervised?: boolean;
  templateId?: string;
  systemPrompt?: string;
  persona?: string;
}

export interface AgentPersona {
  name: string;          // subdirectory name, e.g. "researcher"
  directory: string;     // full path to the persona directory
  hasMemory: boolean;    // whether memory/MEMORY.md exists
  isSupervisor: boolean; // true if name matches SUPERVISOR_AGENT_NAME
}

export interface AgentTemplate {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  systemPrompt: string | null;
  roleDescription: string;
  provider: AgentProvider;
  command: string | null;
  autoRestart: boolean;
  isSupervisor: boolean;
  isSupervised: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentTemplateInput {
  workspaceId?: string | null;
  name: string;
  description?: string;
  systemPrompt?: string | null;
  roleDescription?: string;
  provider?: AgentProvider;
  command?: string | null;
  autoRestart?: boolean;
  isSupervisor?: boolean;
  isSupervised?: boolean;
}

export interface QueryResult {
  result: string;
  sessionId: string;
  isError: boolean;
}

export interface HealthCheck {
  wslAvailable: boolean;
  tmuxAvailable: boolean;
  claudeWindowsAvailable: boolean;
  claudeWslAvailable: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  error?: string;
}

export interface FileTab {
  id: string;
  filePath: string;        // empty string for directory-only tabs
  rootDirectory: string;   // tree root (agent workingDirectory or workspace path)
  pathType: PathType;
  agentId?: string;
  label: string;           // display name (filename or dirname/)
}

export interface GroupThinkSession {
  id: string;
  workspaceId: string;
  topic: string;
  status: GroupThinkStatus;
  roundCount: number;
  maxRounds: number;
  memberAgentIds: string[];
  createdAt: string;
  updatedAt: string;
  synthesis: string | null;
}

// ── Team interfaces ─────────────────────────────────────────────────────

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  template: TeamTemplate | null;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  disbandedAt: string | null;
  // Populated on fetch:
  members?: TeamMember[];
  channels?: TeamChannel[];
}

export interface TeamMember {
  teamId: string;
  agentId: string;
  role: string;
  joinedAt: string;
  // Enriched from agent table:
  title?: string;
  provider?: string;
  status?: AgentStatus;
}

export interface TeamChannel {
  id: string;
  teamId: string;
  fromAgent: string;
  toAgent: string;
  label: string | null;
}

export interface TeamMessage {
  id: number;
  teamId: string;
  fromAgent: string;
  toAgent: string;
  subject: string;
  status: TeamMessageStatus;
  summary: string;
  detail: string | null;
  need: string | null;
  deliveredAt: string | null;
  createdAt: string;
  // Enriched:
  fromTitle?: string;
  toTitle?: string;
}

export interface TeamTask {
  id: string;
  teamId: string;
  title: string;
  description: string;
  status: TeamTaskStatus;
  assignedTo: string | null;
  blockedBy: string[];
  createdBy: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamInput {
  workspaceId: string;
  name: string;
  description?: string;
  template?: TeamTemplate;
  members: { agentId: string; role?: string }[];
  channels?: { from: string; to: string; label?: string }[];
}

export interface TeamManifest {
  version: 1;
  members: Array<{
    agentId: string;
    title: string;
    provider: string;
    roleDescription: string;
    workingDirectory: string;
    command: string;
    resumeSessionId: string | null;
    role: string;
  }>;
  channels: Array<{ fromAgent: string; toAgent: string; label: string | null }>;
  tasks: Array<{ title: string; description: string; status: string; assignedTo: string | null }>;
  recentMessages: TeamMessage[];
}

export interface PanelLayout {
  sidebarWidth: number;
  detailPanelWidth: number;
  terminalHeight: number;
  directoryTreeWidth: number;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
  terminalCollapsed: boolean;
  directoryTreeCollapsed: boolean;
}

export interface ContextStats {
  agentId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalOutputTokens: number;
  totalContextTokens: number;
  contextWindowMax: number;
  contextPercentage: number;
  turnCount: number;
  lastUpdatedAt: string;
}

export interface IpcApi {
  workspaces: {
    list: () => Promise<Workspace[]>;
    create: (input: CreateWorkspaceInput) => Promise<Workspace>;
    delete: (id: string) => Promise<void>;
    openInVSCode: (id: string) => Promise<void>;
  };
  agents: {
    list: (workspaceId: string) => Promise<Agent[]>;
    listAll: () => Promise<Agent[]>;
    launch: (input: LaunchAgentInput) => Promise<Agent>;
    stop: (id: string) => Promise<void>;
    restart: (id: string) => Promise<void>;
    getLog: (id: string, lines?: number) => Promise<string>;
    delete: (id: string) => Promise<void>;
    checkAgentMd: (workingDirectory: string, pathType: PathType) => Promise<{ found: boolean; fileName: string | null }>;
    getFileActivities: (agentId: string, operation?: FileOperation) => Promise<FileActivity[]>;
    onFileActivity: (callback: (activity: FileActivity) => void) => () => void;
    getContextStats: (agentId: string) => Promise<ContextStats | null>;
    onContextStatsChanged: (callback: (stats: ContextStats) => void) => () => void;
    fork: (id: string) => Promise<Agent>;
    query: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult>;
    sendInput: (agentId: string, text: string) => Promise<void>;
    getSupervisor: (workspaceId: string) => Promise<Agent | null>;
    updateSupervised: (id: string, supervised: boolean) => Promise<Agent>;
  };
  terminal: {
    attach: (agentId: string) => Promise<void>;
    detach: (agentId: string) => Promise<void>;
    write: (agentId: string, data: string) => Promise<void>;
    resize: (agentId: string, cols: number, rows: number) => Promise<void>;
    onData: (callback: (agentId: string, data: string) => void) => () => void;
  };
  files: {
    readFile: (filePath: string, pathType: PathType) => Promise<FileContent>;
    listDirectory: (dirPath: string, pathType: PathType) => Promise<DirectoryEntry[]>;
  };
  system: {
    pickDirectory: (startInWsl?: boolean) => Promise<string | null>;
    healthCheck: () => Promise<HealthCheck>;
    openFile: (filePath: string, pathType: PathType) => Promise<void>;
    openFileInWorkspace: (filePath: string, workspaceDir: string, pathType: PathType) => Promise<void>;
  };
  groupthink: {
    start: (workspaceId: string, topic: string, agentIds: string[], maxRounds?: number) => Promise<GroupThinkSession>;
    getStatus: (sessionId: string) => Promise<GroupThinkSession>;
    list: (workspaceId: string) => Promise<GroupThinkSession[]>;
    cancel: (sessionId: string) => Promise<void>;
  };
  teams: {
    create: (input: CreateTeamInput) => Promise<Team>;
    get: (teamId: string) => Promise<Team>;
    list: (workspaceId: string) => Promise<Team[]>;
    disband: (teamId: string) => Promise<void>;
    addMember: (teamId: string, agentId: string, role?: string) => Promise<void>;
    removeMember: (teamId: string, agentId: string) => Promise<void>;
    addChannel: (teamId: string, fromAgent: string, toAgent: string, label?: string) => Promise<TeamChannel>;
    removeChannel: (teamId: string, channelId: string) => Promise<void>;
    getMessages: (teamId: string, agentId?: string) => Promise<TeamMessage[]>;
    getTasks: (teamId: string) => Promise<TeamTask[]>;
    createTask: (teamId: string, task: { title: string; description?: string; assignedTo?: string; blockedBy?: string[]; createdBy: string }) => Promise<TeamTask>;
    updateTask: (teamId: string, taskId: string, updates: { status?: TeamTaskStatus; assignedTo?: string; notes?: string }) => Promise<TeamTask>;
    resurrect: (teamId: string) => Promise<Team>;
  };
  templates: {
    list: (workspaceId?: string) => Promise<AgentTemplate[]>;
    create: (input: CreateAgentTemplateInput) => Promise<AgentTemplate>;
    update: (id: string, updates: Partial<CreateAgentTemplateInput>) => Promise<AgentTemplate>;
    delete: (id: string) => Promise<void>;
  };
  personas: {
    list: (workspacePath: string, pathType: PathType) => Promise<AgentPersona[]>;
    create: (workspacePath: string, pathType: PathType, name: string, customClaudeMd?: string) => Promise<AgentPersona>;
  };
  onAgentStatusChanged: (callback: (data: { agentId: string; status: AgentStatus; agent: Agent }) => void) => () => void;
  onGroupThinkUpdated: (callback: (session: GroupThinkSession) => void) => () => void;
  onTeamUpdated: (callback: (team: Team) => void) => () => void;
  onTeamMessageCreated: (callback: (message: TeamMessage) => void) => () => void;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
