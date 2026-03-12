export type PathType = 'windows' | 'wsl';

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
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  resumeSessionId: string | null;
  status: AgentStatus;
  isAttached: boolean;
  restartCount: number;
  lastExitCode: number | null;
  pid: number | null;
  logPath: string | null;
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
  autoRestartEnabled?: boolean;
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
    fork: (id: string) => Promise<Agent>;
    query: (targetAgentId: string, question: string) => Promise<QueryResult>;
  };
  terminal: {
    attach: (agentId: string) => Promise<void>;
    detach: (agentId: string) => Promise<void>;
    write: (agentId: string, data: string) => Promise<void>;
    resize: (agentId: string, cols: number, rows: number) => Promise<void>;
    onData: (callback: (agentId: string, data: string) => void) => () => void;
  };
  system: {
    pickDirectory: () => Promise<string | null>;
    healthCheck: () => Promise<HealthCheck>;
    openFile: (filePath: string, pathType: PathType) => Promise<void>;
  };
  onAgentStatusChanged: (callback: (data: { agentId: string; status: AgentStatus; agent: Agent }) => void) => () => void;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
