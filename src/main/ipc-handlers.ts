import { ipcMain, dialog, BrowserWindow } from 'electron';
import { AgentSupervisor } from './supervisor';
import {
  getWorkspaces, createWorkspace, deleteWorkspace, getWorkspace,
  getAgentsByWorkspace, getAllAgents, getAgent, getFileActivities, getWorkspaceAgentSummary,
  checkAgentMdExists, updateAgentSupervised,
  createGroupThinkSession, getGroupThinkSession, listGroupThinkSessions, cancelGroupThink,
  createTeam, getTeam, listTeams, updateTeamStatus, addTeamMember, removeTeamMember,
  createChannel, removeChannel, getTeamMessages, getTeamTasks, createTeamTask, updateTeamTask,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate,
} from './database';
import { openInVSCode, openFileInVSCode, openFileInWorkspace } from './vscode-launcher';
import { isWslAvailable, isTmuxAvailable, isClaudeAvailableInWsl } from './wsl-bridge';
import { execFileSync } from 'child_process';
import { detectPathType } from './path-utils';
import { readFileContents, listDirectoryEntries } from './file-reader';
import { scanPersonas, scaffoldPersona } from './persona-scanner';

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
  ipcMain.handle('agent:query', (_e, targetAgentId, question, sourceAgentId) => supervisor.queryAgent(targetAgentId, question, sourceAgentId));
  ipcMain.handle('agent:send-input', (_e, agentId, text) => supervisor.sendInput(agentId, text));
  ipcMain.handle('agent:check-agent-md', (_e, workingDirectory, pathType) => checkAgentMdExists(workingDirectory, pathType));
  ipcMain.handle('agent:workspace-heat', () => getWorkspaceAgentSummary());
  ipcMain.handle('agent:get-supervisor', (_e, workspaceId) => supervisor.getSupervisorAgent(workspaceId));
  ipcMain.handle('agent:get-context-stats', (_e, agentId) => supervisor.getContextStats(agentId));
  ipcMain.handle('agent:update-supervised', (_e, id, supervised) => {
    updateAgentSupervised(id, supervised);
    return getAgent(id);
  });

  // Group Think handlers
  ipcMain.handle('groupthink:start', (_e, workspaceId, topic, agentIds, maxRounds) => {
    const session = createGroupThinkSession(workspaceId, topic, agentIds, maxRounds);
    supervisor.notifyGroupThinkStart(session);
    return session;
  });
  ipcMain.handle('groupthink:status', (_e, sessionId) => getGroupThinkSession(sessionId));
  ipcMain.handle('groupthink:list', (_e, workspaceId) => listGroupThinkSessions(workspaceId));
  ipcMain.handle('groupthink:cancel', (_e, sessionId) => {
    cancelGroupThink(sessionId);
    const session = getGroupThinkSession(sessionId);
    if (session && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('groupthink:updated', session);
    }
  });

  // Team handlers
  ipcMain.handle('team:create', (_e, input) => {
    const team = createTeam(input);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return team;
  });
  ipcMain.handle('team:get', (_e, teamId) => getTeam(teamId));
  ipcMain.handle('team:list', (_e, workspaceId) => listTeams(workspaceId));
  ipcMain.handle('team:disband', (_e, teamId) => {
    updateTeamStatus(teamId, 'disbanded');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:add-member', (_e, teamId, agentId, role) => {
    addTeamMember(teamId, agentId, role || 'member');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:remove-member', (_e, teamId, agentId) => {
    removeTeamMember(teamId, agentId);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:add-channel', (_e, teamId, fromAgent, toAgent, label) => {
    const channel = createChannel(teamId, fromAgent, toAgent, label);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return channel;
  });
  ipcMain.handle('team:remove-channel', (_e, teamId, channelId) => {
    removeChannel(channelId);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:get-messages', (_e, teamId, agentId) => getTeamMessages(teamId, agentId));
  ipcMain.handle('team:get-tasks', (_e, teamId) => getTeamTasks(teamId));
  ipcMain.handle('team:create-task', (_e, teamId, task) => createTeamTask({ teamId, ...task }));
  ipcMain.handle('team:update-task', (_e, teamId, taskId, updates) => updateTeamTask(taskId, updates));
  ipcMain.handle('team:resurrect', (_e, teamId) => {
    updateTeamStatus(teamId, 'active');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return team;
  });

  // Persona handlers
  ipcMain.handle('persona:list', (_e, workspacePath, pathType) => scanPersonas(workspacePath, pathType));
  ipcMain.handle('persona:create', (_e, workspacePath, pathType, name, customClaudeMd?) => scaffoldPersona(workspacePath, pathType, name, customClaudeMd));

  // Template handlers
  ipcMain.handle('template:list', (_e, workspaceId) => listAgentTemplates(workspaceId));
  ipcMain.handle('template:create', (_e, data) => createAgentTemplate(data));
  ipcMain.handle('template:update', (_e, id, updates) => updateAgentTemplate(id, updates));
  ipcMain.handle('template:delete', (_e, id) => deleteAgentTemplate(id));

  // Terminal handlers - track attached agents and their data listeners
  // Map<agentId, listenerFunction>
  const activeListeners = new Map<string, (data: string) => void>();
  const attachedAgents = new Set<string>(); // Keep for backward compatibility/quick checks

  ipcMain.handle('terminal:attach', (_e, agentId) => {
    if (activeListeners.has(agentId)) return { ok: true }; // already attached

    try {
      const bridge = supervisor.attachAgent(agentId);

      const listener = (data: string) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', agentId, data);
        }
      };

      bridge.onData(listener);
      activeListeners.set(agentId, listener);
      attachedAgents.add(agentId);
      return { ok: true };
    } catch (err: any) {
      console.error('Failed to attach:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('terminal:detach', (_e, agentId) => {
    const listener = activeListeners.get(agentId);
    if (listener) {
      supervisor.removeAgentListener(agentId, listener);
      activeListeners.delete(agentId);
    }
    
    // Original detach logic (wsl runner detach)
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
  ipcMain.handle('system:pick-directory', async (_e, startInWsl?: boolean) => {
    // Don't parent to mainWindow — on multi-monitor setups the dialog
    // can appear on the wrong screen. Let the OS place it centrally.
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    };
    // When WSL mode is selected, start the dialog in \\wsl.localhost\
    if (startInWsl) {
      opts.defaultPath = '\\\\wsl.localhost\\';
    }
    const result = await dialog.showOpenDialog(opts);
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

  // File viewer handlers
  ipcMain.handle('files:read', (_e, filePath, pathType) => {
    return readFileContents(filePath, pathType || detectPathType(filePath));
  });

  ipcMain.handle('files:list-directory', (_e, dirPath, pathType) => {
    return listDirectoryEntries(dirPath, pathType || detectPathType(dirPath));
  });

  // File open handler
  ipcMain.handle('system:open-file', (_e, filePath, pathType) => {
    openFileInVSCode(filePath, pathType || detectPathType(filePath));
  });

  ipcMain.handle('system:open-file-in-workspace', (_e, filePath, workspaceDir, pathType) => {
    openFileInWorkspace(filePath, workspaceDir, pathType || detectPathType(filePath));
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

  // Forward context stats changes to renderer
  supervisor.on('contextStatsChanged', (stats) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:context-stats-changed', stats);
    }
  });

  // Forward group think updates to renderer
  supervisor.on('groupThinkUpdated', (session) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('groupthink:updated', session);
    }
  });

  // Forward team updates to renderer
  supervisor.on('teamUpdated', (team) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });

  supervisor.on('teamMessageCreated', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:message-created', message);
    }
  });
}
