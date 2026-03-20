import WebSocket from 'ws';
import { TerminalManager, AgentInfo } from './terminal-manager';

type StatusCallback = (status: 'disconnected' | 'connecting' | 'connected', agentCount?: number, workspaceTitle?: string) => void;

const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private workspacePath: string;
  private port: number;
  private terminalManager: TerminalManager;
  private onStatusChange: StatusCallback;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private intentionalClose = false;
  private workspaceTitle = '';

  constructor(
    workspacePath: string,
    port: number,
    terminalManager: TerminalManager,
    onStatusChange: StatusCallback
  ) {
    this.workspacePath = workspacePath;
    this.port = port;
    this.terminalManager = terminalManager;
    this.onStatusChange = onStatusChange;

    // Forward terminal close events to server
    this.terminalManager.onTerminalClosed((agentId) => {
      this.send({ type: 'terminal_closed', agentId });
    });
  }

  connect(): void {
    this.intentionalClose = false;
    this.onStatusChange('connecting');

    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.send({
        type: 'hello',
        workspacePath: this.workspacePath,
        extensionVersion: '0.1.0',
      });
    });

    this.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      if (!this.intentionalClose) {
        this.onStatusChange('disconnected');
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      // Error will be followed by close event
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onStatusChange('disconnected');
  }

  private send(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome':
        this.workspaceTitle = msg.workspaceTitle || '';
        this.onStatusChange('connected', this.terminalManager.agentCount, this.workspaceTitle);
        break;

      case 'inject_terminals': {
        const agents: AgentInfo[] = msg.agents || [];
        this.terminalManager.syncTerminals(agents);
        this.onStatusChange('connected', this.terminalManager.agentCount, this.workspaceTitle);
        break;
      }

      case 'agent_added': {
        if (msg.agent) {
          this.terminalManager.addAgent(msg.agent as AgentInfo);
          this.onStatusChange('connected', this.terminalManager.agentCount, this.workspaceTitle);
        }
        break;
      }

      case 'agent_removed':
        this.terminalManager.removeAgent(msg.agentId);
        this.onStatusChange('connected', this.terminalManager.agentCount, this.workspaceTitle);
        break;

      case 'agent_status_changed':
        this.terminalManager.updateStatus(msg.agentId, msg.status);
        break;

      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'error':
        console.warn('[AgentDashboard]', msg.message);
        this.onStatusChange('connected', 0, '');
        break;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  dispose(): void {
    this.disconnect();
    this.terminalManager.disposeAll();
  }
}
