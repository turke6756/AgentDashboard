import * as vscode from 'vscode';

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
  platform: string;
  tmuxSession?: string;
}

export class TerminalManager {
  private terminals = new Map<string, vscode.Terminal>();
  private disposable: vscode.Disposable;
  private onTerminalClosedCallback: ((agentId: string) => void) | null = null;

  constructor() {
    // Detect when user closes a terminal tab
    this.disposable = vscode.window.onDidCloseTerminal((terminal) => {
      for (const [agentId, t] of this.terminals) {
        if (t === terminal) {
          this.terminals.delete(agentId);
          this.onTerminalClosedCallback?.(agentId);
          break;
        }
      }
    });
  }

  onTerminalClosed(callback: (agentId: string) => void): void {
    this.onTerminalClosedCallback = callback;
  }

  syncTerminals(agents: AgentInfo[]): void {
    const incomingIds = new Set(agents.map((a) => a.id));

    // Remove terminals for agents no longer present
    for (const [agentId, terminal] of this.terminals) {
      if (!incomingIds.has(agentId)) {
        terminal.dispose();
        this.terminals.delete(agentId);
      }
    }

    // Create terminals for new agents
    for (const agent of agents) {
      if (!this.terminals.has(agent.id)) {
        this.createTerminal(agent);
      }
    }
  }

  addAgent(agent: AgentInfo): void {
    if (this.terminals.has(agent.id)) return;
    this.createTerminal(agent);
  }

  removeAgent(agentId: string): void {
    const terminal = this.terminals.get(agentId);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(agentId);
    }
  }

  updateStatus(agentId: string, status: string): void {
    // Terminal stays open; status is informational only
    const terminal = this.terminals.get(agentId);
    if (terminal) {
      // VS Code doesn't support renaming terminals after creation,
      // so we just log it. Status is reflected in the Dashboard UI.
    }
  }

  get agentCount(): number {
    return this.terminals.size;
  }

  private createTerminal(agent: AgentInfo): void {
    if (!agent.tmuxSession) {
      // Only WSL/tmux agents are supported in Phase 1
      return;
    }

    // When VS Code is in WSL remote mode, we're already inside WSL —
    // use bash directly instead of wsl.exe
    const isRemote = vscode.env.remoteName === 'wsl';
    const terminal = vscode.window.createTerminal({
      name: `Agent: ${agent.name}`,
      shellPath: isRemote ? 'bash' : 'wsl.exe',
      shellArgs: isRemote
        ? ['-lc', `tmux attach -t '${agent.tmuxSession}'`]
        : ['bash', '-lc', `tmux attach -t '${agent.tmuxSession}'`],
    });

    this.terminals.set(agent.id, terminal);
  }

  disposeAll(): void {
    for (const [, terminal] of this.terminals) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.disposable.dispose();
  }
}
