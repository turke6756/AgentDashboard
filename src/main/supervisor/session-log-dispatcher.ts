import { EventEmitter } from 'events';
import type {
  SessionEvent,
  ChatEventBatch,
  UserTextEvent,
} from '../../shared/session-events';
import type { AgentProvider } from '../../shared/types';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';

interface AgentSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
}

const MASTER_TICK_MS = 1000;
const SUBSCRIBED_POLL_MS = 1000;
const UNSUBSCRIBED_POLL_MS = 5000;
const RING_BUFFER_MAX = 2000;

export class SessionLogDispatcher extends EventEmitter {
  private getActiveAgentSessions: () => AgentSession[];
  private readers = new Map<AgentProvider, ChatLogReader>();

  private eventsByAgent = new Map<string, SessionEvent[]>();
  private truncatedByAgent = new Map<string, boolean>();

  private subscribers = new Set<string>();
  private nextPollAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(getActiveAgentSessions: () => AgentSession[]) {
    super();
    this.getActiveAgentSessions = getActiveAgentSessions;
  }

  register(reader: ChatLogReader): void {
    this.readers.set(reader.provider, reader);
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), MASTER_TICK_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  pollNow(): void {
    this.tick();
  }

  addChatSubscriber(agentId: string): void {
    this.subscribers.add(agentId);
    this.nextPollAt.set(agentId, 0);
  }

  removeChatSubscriber(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  // Synthetic echo for codex/gemini (no on-disk user-message echo). TODO(reconcile-synthetic): dedupe vs real reader within ~30s once codex/gemini readers land.
  appendSyntheticUserText(agentId: string, text: string): void {
    const ev: UserTextEvent = {
      type: 'user-text',
      uuid: `synthetic:${agentId}:${Date.now()}`,
      timestamp: new Date().toISOString(),
      agentId,
      text,
    };
    this.appendToRingBuffer(agentId, [ev]);
    const batch: ChatEventBatch = {
      agentId,
      events: [ev],
      truncated: this.truncatedByAgent.get(agentId) || false,
    };
    this.emit('chat-events', batch);
  }

  invalidatePath(agentId: string): void {
    for (const reader of this.readers.values()) reader.invalidatePath(agentId);
  }

  getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean } {
    const all = this.eventsByAgent.get(agentId) || [];
    const truncated = this.truncatedByAgent.get(agentId) || false;
    if (!sinceUuid) return { events: all.slice(), truncated };
    const idx = all.findIndex(e => e.uuid === sinceUuid);
    if (idx < 0) return { events: all.slice(), truncated };
    return { events: all.slice(idx + 1), truncated };
  }

  async getFullToolResult(agentId: string, toolUseId: string): Promise<string | null> {
    for (const reader of this.readers.values()) {
      if (!reader.getFullToolResult) continue;
      const result = await reader.getFullToolResult(agentId, toolUseId);
      if (result !== null && result !== undefined) return result;
    }
    return null;
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private tick(): void {
    const sessions = this.getActiveAgentSessions();
    const now = Date.now();
    for (const session of sessions) {
      const due = this.nextPollAt.get(session.agentId) || 0;
      if (due > now) continue;
      try {
        this.pollOne(session);
      } catch {
        // swallow per-agent errors
      }
      const rate = this.subscribers.has(session.agentId) ? SUBSCRIBED_POLL_MS : UNSUBSCRIBED_POLL_MS;
      this.nextPollAt.set(session.agentId, now + rate);
    }
  }

  private pollOne(session: AgentSession): void {
    const reader = this.readers.get(session.provider);
    if (!reader) return;

    const readerSession: ChatLogReaderSession = {
      agentId: session.agentId,
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
      provider: session.provider,
      subscribed: this.subscribers.has(session.agentId),
    };

    const newEvents = reader.pollSession(readerSession);
    if (newEvents.length === 0) return;

    this.appendToRingBuffer(session.agentId, newEvents);

    const batch: ChatEventBatch = {
      agentId: session.agentId,
      events: newEvents,
      truncated: this.truncatedByAgent.get(session.agentId) || false,
    };
    this.emit('chat-events', batch);

    for (const ev of newEvents) {
      if (ev.type === 'usage') this.emit('usage', ev);
      else if (ev.type === 'tool-use') this.emit('tool-use', ev);
    }
  }

  private appendToRingBuffer(agentId: string, newEvents: SessionEvent[]): void {
    let buf = this.eventsByAgent.get(agentId);
    if (!buf) {
      buf = [];
      this.eventsByAgent.set(agentId, buf);
    }
    buf.push(...newEvents);
    if (buf.length > RING_BUFFER_MAX) {
      const overflow = buf.length - RING_BUFFER_MAX;
      buf.splice(0, overflow);
      this.truncatedByAgent.set(agentId, true);
    }
  }
}
