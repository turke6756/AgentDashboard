import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '../shared/types';

const api: IpcApi = {
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (input) => ipcRenderer.invoke('workspace:create', input),
    delete: (id) => ipcRenderer.invoke('workspace:delete', id),
    openInVSCode: (id) => ipcRenderer.invoke('workspace:open-vscode', id),
  },
  agents: {
    list: (workspaceId) => ipcRenderer.invoke('agent:list', workspaceId),
    listAll: () => ipcRenderer.invoke('agent:list-all'),
    launch: (input) => ipcRenderer.invoke('agent:launch', input),
    stop: (id) => ipcRenderer.invoke('agent:stop', id),
    restart: (id) => ipcRenderer.invoke('agent:restart', id),
    getLog: (id, lines) => ipcRenderer.invoke('agent:get-log', id, lines),
    delete: (id) => ipcRenderer.invoke('agent:delete', id),
    checkAgentMd: (workingDirectory, pathType) => ipcRenderer.invoke('agent:check-agent-md', workingDirectory, pathType),
    getFileActivities: (agentId, operation) => ipcRenderer.invoke('agent:get-file-activities', agentId, operation),
    fork: (id) => ipcRenderer.invoke('agent:fork', id),
    query: (targetAgentId, question, sourceAgentId) => ipcRenderer.invoke('agent:query', targetAgentId, question, sourceAgentId),
    sendInput: (agentId, text) => ipcRenderer.invoke('agent:send-input', agentId, text),
    onFileActivity: (callback) => {
      const listener = (_event: any, activity: any) => callback(activity);
      ipcRenderer.on('agent:file-activity', listener);
      return () => ipcRenderer.removeListener('agent:file-activity', listener);
    },
    getContextStats: (agentId) => ipcRenderer.invoke('agent:get-context-stats', agentId),
    onContextStatsChanged: (callback) => {
      const listener = (_event: any, stats: any) => callback(stats);
      ipcRenderer.on('agent:context-stats-changed', listener);
      return () => ipcRenderer.removeListener('agent:context-stats-changed', listener);
    },
  },
  terminal: {
    attach: (agentId) => ipcRenderer.invoke('terminal:attach', agentId),
    detach: (agentId) => ipcRenderer.invoke('terminal:detach', agentId),
    write: (agentId, data) => ipcRenderer.invoke('terminal:write', agentId, data),
    resize: (agentId, cols, rows) => ipcRenderer.invoke('terminal:resize', agentId, cols, rows),
    onData: (callback) => {
      const listener = (_event: any, agentId: string, data: string) => callback(agentId, data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
  },
  system: {
    pickDirectory: (startInWsl?: boolean) => ipcRenderer.invoke('system:pick-directory', startInWsl),
    healthCheck: () => ipcRenderer.invoke('system:health-check'),
    openFile: (filePath, pathType) => ipcRenderer.invoke('system:open-file', filePath, pathType),
  },
  onAgentStatusChanged: (callback) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('agent:status-changed', listener);
    return () => ipcRenderer.removeListener('agent:status-changed', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
