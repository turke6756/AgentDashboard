import * as vscode from 'vscode';
import { WsClient } from './ws-client';
import { TerminalManager } from './terminal-manager';

let client: WsClient | null = null;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'agentdashboard.reconnect';
  updateStatusBar('disconnected');
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agentdashboard.reconnect', () => {
      if (client) {
        client.dispose();
      }
      startClient();
    }),
    vscode.commands.registerCommand('agentdashboard.disconnect', () => {
      if (client) {
        client.dispose();
        client = null;
        updateStatusBar('disconnected');
      }
    })
  );

  // Auto-connect
  const config = vscode.workspace.getConfiguration('agentdashboard');
  if (config.get<boolean>('autoConnect', true)) {
    startClient();
  }
}

function startClient(): void {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    updateStatusBar('disconnected');
    return;
  }

  const workspacePath = folders[0].uri.fsPath;
  const config = vscode.workspace.getConfiguration('agentdashboard');
  const port = config.get<number>('port', 4545);

  const terminalManager = new TerminalManager();
  client = new WsClient(workspacePath, port, terminalManager, (status, agentCount, workspaceTitle) => {
    updateStatusBar(status, agentCount, workspaceTitle);
  });

  client.connect();
}

function updateStatusBar(
  status: 'disconnected' | 'connecting' | 'connected',
  agentCount?: number,
  workspaceTitle?: string
): void {
  switch (status) {
    case 'disconnected':
      statusBarItem.text = '$(plug) AgentDashboard';
      statusBarItem.tooltip = 'Click to connect to AgentDashboard';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'connecting':
      statusBarItem.text = '$(sync~spin) AgentDashboard';
      statusBarItem.tooltip = 'Connecting to AgentDashboard...';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'connected': {
      const count = agentCount ?? 0;
      const suffix = workspaceTitle ? ` - ${workspaceTitle}` : '';
      statusBarItem.text = `$(check) AgentDashboard (${count} agent${count !== 1 ? 's' : ''})`;
      statusBarItem.tooltip = `Connected to AgentDashboard${suffix}`;
      statusBarItem.backgroundColor = undefined;
      break;
    }
  }
}

export function deactivate(): void {
  if (client) {
    client.dispose();
    client = null;
  }
}
