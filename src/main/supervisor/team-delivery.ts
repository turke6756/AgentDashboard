import { EventEmitter } from 'events';
import { getPendingMessages, markMessageDelivered, getTeam, getAgent } from '../database';
import { TeamMessage } from '../../shared/types';
import { TEAM_MESSAGE_DELIVERY_POLL_MS, TEAM_MESSAGE_BATCH_DELAY_MS } from '../../shared/constants';

/**
 * Delivers pending team messages to agents when they go idle.
 *
 * Two delivery triggers:
 * 1. On agent idle: listens to supervisor statusChanged events
 * 2. Polling fallback: catches messages that arrived while agent was already idle
 *
 * Messages are batched with a short delay to avoid rapid-fire stdin writes.
 */
export class TeamMessageDeliveryEngine extends EventEmitter {
  private supervisor: any; // AgentSupervisor — avoid circular import
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDeliveries: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(supervisor: any) {
    super();
    this.supervisor = supervisor;
  }

  start(): void {
    // Listen for agent status changes
    this.supervisor.on('statusChanged', (data: { agentId: string; status: string }) => {
      if (data.status === 'idle' || data.status === 'waiting') {
        this.scheduleDelivery(data.agentId);
      }
    });

    // Polling fallback: scan for idle agents with pending messages
    this.pollTimer = setInterval(() => {
      this.pollPendingDeliveries();
    }, TEAM_MESSAGE_DELIVERY_POLL_MS);

    console.log('[team-delivery] Engine started');
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.pendingDeliveries.values()) {
      clearTimeout(timer);
    }
    this.pendingDeliveries.clear();
    console.log('[team-delivery] Engine stopped');
  }

  /** Schedule a batched delivery for an agent (with short delay to batch multiple messages) */
  private scheduleDelivery(agentId: string): void {
    // If already scheduled, skip — the existing timer will pick up all pending messages
    if (this.pendingDeliveries.has(agentId)) return;

    const timer = setTimeout(() => {
      this.pendingDeliveries.delete(agentId);
      this.deliverMessages(agentId);
    }, TEAM_MESSAGE_BATCH_DELAY_MS);

    this.pendingDeliveries.set(agentId, timer);
  }

  /** Deliver all pending messages to an agent */
  private async deliverMessages(agentId: string): Promise<void> {
    const messages = getPendingMessages(agentId);
    if (messages.length === 0) return;

    // Check agent is still idle
    const agent = getAgent(agentId);
    if (!agent || !['idle', 'waiting'].includes(agent.status)) {
      // Agent went back to working — messages stay pending for next idle
      return;
    }

    // Format all pending messages into a single input
    const formatted = messages.map(m => this.formatMessage(m)).join('\n\n---\n\n');

    try {
      await this.supervisor.sendInput(agentId, formatted);

      // Mark all as delivered
      for (const m of messages) {
        markMessageDelivered(m.id);
      }

      console.log(`[team-delivery] Delivered ${messages.length} message(s) to agent ${agentId}`);
      this.emit('messagesDelivered', { agentId, count: messages.length, messageIds: messages.map(m => m.id) });
    } catch (err) {
      console.error(`[team-delivery] Failed to deliver to agent ${agentId}:`, err);
      // Messages stay undelivered — will retry on next idle or poll
    }
  }

  /** Format a team message for agent stdin delivery */
  private formatMessage(message: TeamMessage): string {
    const team = getTeam(message.teamId);
    const teamName = team?.name || message.teamId;
    const fromAgent = getAgent(message.fromAgent);
    const fromName = fromAgent?.title || message.fromTitle || message.fromAgent;

    const lines = [
      `[TEAM MESSAGE from "${fromName}" in "${teamName}"]`,
      `Subject: ${message.subject}`,
      `Status: ${message.status}`,
      `Summary: ${message.summary}`,
    ];
    if (message.detail) lines.push(`Detail: ${message.detail}`);
    if (message.need) lines.push(`Need: ${message.need}`);

    return lines.join('\n');
  }

  /** Poll for any idle agents with undelivered messages */
  private pollPendingDeliveries(): void {
    // Get all agents and check which idle ones have pending messages
    // This is intentionally lightweight — just queries the DB
    const allAgents = this.supervisor.getAllAgentStatuses?.() || [];

    for (const { agentId, status } of allAgents) {
      if (status === 'idle' || status === 'waiting') {
        const pending = getPendingMessages(agentId);
        if (pending.length > 0 && !this.pendingDeliveries.has(agentId)) {
          this.scheduleDelivery(agentId);
        }
      }
    }
  }
}
