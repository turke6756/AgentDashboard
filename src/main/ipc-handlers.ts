import { ipcMain, dialog, BrowserWindow } from 'electron';
import { AgentSupervisor } from './supervisor';
import {
  getWorkspaces, createWorkspace, deleteWorkspace, getWorkspace,
  getAgentsByWorkspace, getAllAgents, getAgent, getFileActivities, getWorkspaceAgentSummary,
  checkAgentMdExists
} from './database';
import { openInVSCode, openFileInVSCode } from './vscode-launcher';
import { isWslAvailable, isTmuxAvailable, isClaudeAvailableInWsl } from './wsl-bridge';
import { execFileSync } from 'child_process';
import { detectPathType } from './path-utils';

export function registerIpcHandlers(supervisor: AgentSupervisor, mainWindow: BrowserWindow): void {
  // Workspace handlers
  ipcMain.handle('workspace:list', () => getWorkspaces());
  ipcMain.handle('workspace:create', (_e, input) => createWorkspace(input));
  ipcMain.handle('workspace:delete', (_e, id) => deleteWorkspace(id));

  ipcMain.handle('workspace:open-vscode', (_e, id) => {
    const ws = getWorkspace(id);
    if (ws) openInVSCode(ws.path, ws.pathType);
  });

  // Agent handlers
  ipcMain.handle('agent:list', (_e, workspaceId) => getAgentsByWorkspace(workspaceId));
  ipcMain.handle('agent:list-all', () => getAllAgents());
  ipcMain.handle('agent:launch', (_e, input) => supervisor.launchAgent(input));
  ipcMain.handle('agent:stop', (_e, id) => supervisor.stopAgent(id));
  ipcMain.handle('agent:restart', (_e, id) => supervisor.restartAgent(id));
  ipcMain.handle('agent:get-log', (_e, id, lines) => supervisor.getAgentLog(id, lines));
  ipcMain.handle('agent:get', (_e, id) => getAgent(id));
  ipcMain.handle('agent:get-file-activities', (_e, agentId, operation) => getFileActivities(agentId, operation));
  ipcMain.handle('agent:delete', (_e, id) => supervisor.deleteAgent(id));
  ipcMain.handle('agent:fork', (_e, id) => supervisor.forkAgent(id));
  ipcMain.handle('agent:query', (_e, targetAgentId, question) => supervisor.queryAgent(targetAgentId, question));
  ipcMain.handle('agent:check-agent-md', (_e, workingDirectory, pathType) => checkAgentMdExists(workingDirectory, pathType));
  ipcMain.handle('agent:workspace-heat', () => getWorkspaceAgentSummary());

  // Terminal handlers - track attached agents and their data listeners
  const attachedAgents = new Set<string>();

  ipcMain.handle('terminal:attach', (_e, agentId) => {
    if (attachedAgents.has(agentId)) return; // already attached

    try {
      const bridge = supervisor.attachAgent(agentId);

      const listener = (data: string) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', agentId, data);
        }
      };
      bridge.onData(listener);
      attachedAgents.add(agentId);
    } catch (err: any) {
      console.error('Failed to attach:', err.message);
    }
  });

  ipcMain.handle('terminal:detach', (_e, agentId) => {
    supervisor.detachAgent(agentId);
    attachedAgents.delete(agentId);
  });

  ipcMain.handle('terminal:write', (_e, agentId, data) => {
    supervisor.writeToAgent(agentId, data);
  });

  ipcMain.handle('terminal:resize', (_e, agentId, cols, rows) => {
    supervisor.resizeAgent(agentId, cols, rows);
  });

  // System handlers
  ipcMain.handle('system:pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0] || null;
  });

  ipcMain.handle('system:health-check', async () => {
    let claudeWindowsAvailable = false;
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000, env });
      claudeWindowsAvailable = true;
    } catch {
      // not available
    }

    const [wslAvailable, tmuxAvailable, claudeWslAvailable] = await Promise.all([
      isWslAvailable(),
      isTmuxAvailable(),
      isClaudeAvailableInWsl(),
    ]);

    return { wslAvailable, tmuxAvailable, claudeWindowsAvailable, claudeWslAvailable };
  });

  // File open handler
  ipcMain.handle('system:open-file', (_e, filePath, pathType) => {
    openFileInVSCode(filePath, pathType || detectPathType(filePath));
  });

  // Forward supervisor status changes to renderer
  supervisor.on('statusChanged', (data) => {
    if (!mainWindow.isDestroyed()) {
      const agent = getAgent(data.agentId);
      mainWindow.webContents.send('agent:status-changed', { ...data, agent });
    }
  });

  // Forward file activity events to renderer
  supervisor.on('fileActivity', (activity) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:file-activity', activity);
    }
  });
}
