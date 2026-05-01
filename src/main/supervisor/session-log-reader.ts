import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type {
  SessionEvent,
  ChatEventBatch,
  UserTextEvent,
  AssistantTextEvent,
  ThinkingEvent,
  ToolUseEvent,
  ToolResultEvent,
  UsageEvent,
  SystemInitEvent,
} from '../../shared/session-events';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../shared/constants';

interface AgentSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
}

interface ToolResultLocation {
  jsonlPath: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
}

const MASTER_TICK_MS = 1000;
const SUBSCRIBED_POLL_MS = 1000;
const UNSUBSCRIBED_POLL_MS = 5000;
const RING_BUFFER_MAX = 2000;
const TOOL_RESULT_TRUNCATE_BYTES = 20_000;
const EOF_STREAK_REREGISTER = 3;

export class SessionLogReader extends EventEmitter {
  private getActiveAgentSessions: () => AgentSession[];

  private windowsProjectsDir: string | null = null;
  private wslProjectsUncDir: string | null = null;

  private resolvedPaths = new Map<string, string>(); // agentId -> jsonlPath
  private fileOffsets = new Map<string, number>(); // jsonlPath -> byte offset
  private partialLines = new Map<string, string>(); // jsonlPath -> partial
  private seenEntryUuids = new Map<string, Set<string>>(); // agentId -> entry uuids
  private eventsByAgent = new Map<string, SessionEvent[]>(); // agentId -> ring buffer
  private truncatedByAgent = new Map<string, boolean>(); // agentId -> eviction flag
  private emittedSystemInit = new Set<string>(); // agentId
  private toolResultLocations = new Map<string, ToolResultLocation>(); // `${agentId}:${toolUseId}` -> location
  private eofStreak = new Map<string, number>(); // agentId

  private subscribers = new Set<string>();
  private nextPollAt = new Map<string, number>();
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(getActiveAgentSessions: () => AgentSession[]) {
    super();
    this.getActiveAgentSessions = getActiveAgentSessions;
    this.resolveProjectsDirs();
  }

  private resolveProjectsDirs(): void {
    const userProfile = process.env.USERPROFILE || '';
    const windowsPath = path.join(userProfile, '.claude', 'projects');
    if (fs.existsSync(windowsPath)) this.windowsProjectsDir = windowsPath;

    try {
      const home = execFileSync('wsl.exe', ['bash', '-lc', 'echo $HOME'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (home) {
        const uncPath =
          `\\\\wsl.localhost\\Ubuntu${home.replace(/\//g, '\\')}` +
          '\\.claude\\projects';
        if (fs.existsSync(uncPath)) this.wslProjectsUncDir = uncPath;
      }
    } catch {
      // WSL not available
    }
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

  /** Force immediate tick — useful after reconcile. */
  pollNow(): void {
    this.tick();
  }

  addChatSubscriber(agentId: string): void {
    this.subscribers.add(agentId);
    // Make next poll immediate so the chat pane hydrates fast.
    this.nextPollAt.set(agentId, 0);
  }

  removeChatSubscriber(agentId: string): void {
    this.subscribers.delete(agentId);
  }

  /** Called when agent's resumeSessionId changes — forces re-resolution of JSONL path. */
  invalidatePath(agentId: string): void {
    const cached = this.resolvedPaths.get(agentId);
    if (cached) {
      this.resolvedPaths.delete(agentId);
      this.fileOffsets.delete(cached);
      this.partialLines.delete(cached);
    }
    // Don't clear seenEntryUuids or eventsByAgent — keep the history.
    this.eofStreak.delete(agentId);
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
    const loc = this.toolResultLocations.get(`${agentId}:${toolUseId}`);
    if (!loc) return null;

    try {
      const fd = fs.openSync(loc.jsonlPath, 'r');
      try {
        const length = loc.endOffset - loc.startOffset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, loc.startOffset);
        const line = buf.toString('utf-8');
        const entry = JSON.parse(line);
        const content = entry?.message?.content;
        if (!Array.isArray(content)) return null;
        const block = content[loc.blockIndex];
        if (!block || block.type !== 'tool_result') return null;
        return this.flattenToolResultContent(block.content);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  // ── Polling ──────────────────────────────────────────────────────────

  private tick(): void {
    const sessions = this.getActiveAgentSessions();
    const now = Date.now();
    for (const session of sessions) {
      const due = this.nextPollAt.get(session.agentId) || 0;
      if (due > now) continue;
      try {
        this.pollSession(session);
      } catch {
        // swallow per-agent errors
      }
      const rate = this.subscribers.has(session.agentId) ? SUBSCRIBED_POLL_MS : UNSUBSCRIBED_POLL_MS;
      this.nextPollAt.set(session.agentId, now + rate);
    }
  }

  private pollSession(session: AgentSession): void {
    const jsonlPath = this.resolveJsonlPath(session);
    if (!jsonlPath) return;

    let fileSize: number;
    try {
      fileSize = fs.statSync(jsonlPath).size;
    } catch {
      return;
    }

    const lastOffset = this.fileOffsets.get(jsonlPath) || 0;
    if (fileSize <= lastOffset) {
      // EOF streak: if subscribed agent is active but no new data, re-resolve after N ticks.
      const streak = (this.eofStreak.get(session.agentId) || 0) + 1;
      this.eofStreak.set(session.agentId, streak);
      if (streak >= EOF_STREAK_REREGISTER && this.subscribers.has(session.agentId)) {
        this.invalidatePath(session.agentId);
        this.eofStreak.delete(session.agentId);
      }
      return;
    }
    this.eofStreak.delete(session.agentId);

    const fd = fs.openSync(jsonlPath, 'r');
    let readStart: number;
    let rawText: string;
    try {
      const bytesToRead = fileSize - lastOffset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, lastOffset);
      readStart = lastOffset;
      rawText = buffer.toString('utf-8');
      this.fileOffsets.set(jsonlPath, fileSize);
    } finally {
      fs.closeSync(fd);
    }

    const partial = this.partialLines.get(jsonlPath) || '';
    const combined = partial + rawText;

    // Walk line-by-line while tracking byte positions within the JSONL so we
    // can record (startOffset, endOffset) for each tool_result for later re-read.
    const newEvents: SessionEvent[] = [];

    // The byte offset of the start of `combined` in the file is:
    //   readStart - partial.byteLength
    const partialBytes = Buffer.byteLength(partial, 'utf-8');
    let cursor = readStart - partialBytes;

    const lines = combined.split('\n');
    const maybeLast = lines.pop() || '';
    this.partialLines.set(jsonlPath, maybeLast);

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      const lineStartOffset = cursor;
      const lineEndOffset = cursor + lineBytes;
      cursor = lineEndOffset + 1; // +1 for '\n'

      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      this.parseEntry(session, jsonlPath, entry, lineStartOffset, lineEndOffset, newEvents);
    }

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

  private parseEntry(
    session: AgentSession,
    jsonlPath: string,
    entry: any,
    lineStartOffset: number,
    lineEndOffset: number,
    out: SessionEvent[]
  ): void {
    const entryUuid: string | undefined = entry.uuid;
    if (entryUuid) {
      let seen = this.seenEntryUuids.get(session.agentId);
      if (!seen) {
        seen = new Set();
        this.seenEntryUuids.set(session.agentId, seen);
      }
      if (seen.has(entryUuid)) return;
      seen.add(entryUuid);
    }

    const timestamp: string = entry.timestamp || new Date().toISOString();
    const baseUuid = entryUuid || `${jsonlPath}:${lineStartOffset}`;

    const mkEventUuid = (suffix: string) => `${baseUuid}#${suffix}`;

    if (entry.type === 'system') {
      // Claude Code session init record. Emit once per agent.
      if (!this.emittedSystemInit.has(session.agentId)) {
        const ev: SystemInitEvent = {
          type: 'system-init',
          uuid: mkEventUuid('init'),
          timestamp,
          agentId: session.agentId,
          model: entry.model || entry.subtype || 'unknown',
          cwd: entry.cwd,
        };
        out.push(ev);
        this.emittedSystemInit.add(session.agentId);
      }
      return;
    }

    if (entry.type === 'user') {
      const content = entry.message?.content;
      if (typeof content === 'string') {
        const text = content.trim();
        if (text.length > 0) {
          const ev: UserTextEvent = {
            type: 'user-text',
            uuid: mkEventUuid('u'),
            timestamp,
            agentId: session.agentId,
            text,
          };
          out.push(ev);
        }
        return;
      }
      if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text.length === 0) continue;
            const ev: UserTextEvent = {
              type: 'user-text',
              uuid: mkEventUuid(`u${i}`),
              timestamp,
              agentId: session.agentId,
              text,
            };
            out.push(ev);
          } else if (block.type === 'tool_result') {
            const rawContent = this.flattenToolResultContent(block.content);
            const { content: truncatedContent, truncated } = this.truncateForChat(rawContent);
            const toolUseId = block.tool_use_id || '';
            const ev: ToolResultEvent = {
              type: 'tool-result',
              uuid: mkEventUuid(`r${i}`),
              timestamp,
              agentId: session.agentId,
              toolUseId,
              content: truncatedContent,
              truncated,
              isError: block.is_error === true,
            };
            out.push(ev);
            if (toolUseId) {
              this.toolResultLocations.set(`${session.agentId}:${toolUseId}`, {
                jsonlPath,
                blockIndex: i,
                startOffset: lineStartOffset,
                endOffset: lineEndOffset,
              });
            }
          }
        }
      }
      return;
    }

    if (entry.type === 'assistant') {
      const msg = entry.message;
      if (!msg) return;
      const model: string = msg.model || 'unknown';
      const content = msg.content;

      if (Array.isArray(content)) {
        for (let i = 0; i < content.length; i++) {
          const block = content[i];
          if (!block || typeof block !== 'object') continue;

          if (block.type === 'text') {
            const text = (block.text || '').trim();
            if (text.length === 0) continue;
            const ev: AssistantTextEvent = {
              type: 'assistant-text',
              uuid: mkEventUuid(`a${i}`),
              timestamp,
              agentId: session.agentId,
              text,
              model,
            };
            out.push(ev);
          } else if (block.type === 'thinking') {
            const text = (block.thinking || '').trim();
            if (text.length === 0) continue;
            const ev: ThinkingEvent = {
              type: 'thinking',
              uuid: mkEventUuid(`t${i}`),
              timestamp,
              agentId: session.agentId,
              text,
            };
            out.push(ev);
          } else if (block.type === 'tool_use') {
            const ev: ToolUseEvent = {
              type: 'tool-use',
              uuid: mkEventUuid(`tu${i}`),
              timestamp,
              agentId: session.agentId,
              toolUseId: block.id || '',
              toolName: block.name || 'unknown',
              input: block.input,
            };
            out.push(ev);
          }
        }
      }

      const usage = msg.usage;
      if (usage) {
        const contextWindowMax = getContextWindowForModel(model) || DEFAULT_CONTEXT_WINDOW_TOKENS;
        const inputTokens = usage.input_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cumulativeContextTokens = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;
        const contextPercentage = Math.min(100, Math.round((cumulativeContextTokens / contextWindowMax) * 100));
        const ev: UsageEvent = {
          type: 'usage',
          uuid: mkEventUuid('use'),
          timestamp,
          agentId: session.agentId,
          sessionId: session.sessionId,
          model,
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          cumulativeContextTokens,
          contextWindowMax,
          contextPercentage,
        };
        out.push(ev);
      }
    }
  }

  private flattenToolResultContent(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block as any).type === 'text' && typeof (block as any).text === 'string') {
        parts.push((block as any).text);
      }
    }
    return parts.join('\n');
  }

  private truncateForChat(text: string): { content: string; truncated: boolean } {
    const bytes = Buffer.byteLength(text, 'utf-8');
    if (bytes <= TOOL_RESULT_TRUNCATE_BYTES) return { content: text, truncated: false };
    // Slice by chars as a cheap approximation; exact byte-slice is overkill here.
    const sliced = text.slice(0, TOOL_RESULT_TRUNCATE_BYTES);
    return { content: sliced, truncated: true };
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

  // ── JSONL path resolution ────────────────────────────────────────────
  // Mirrors context-stats-monitor.ts:261-311

  private resolveJsonlPath(session: AgentSession): string | null {
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.resolvedPaths.delete(session.agentId);
    }

    const { workingDirectory, sessionId } = session;
    const slug = this.makeSlug(workingDirectory);
    const fileName = `${sessionId}.jsonl`;

    if (workingDirectory.startsWith('/') && this.wslProjectsUncDir) {
      const jsonlPath = path.join(this.wslProjectsUncDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    if (this.windowsProjectsDir) {
      const jsonlPath = path.join(this.windowsProjectsDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        return jsonlPath;
      }
    }

    const dirsToScan = [this.windowsProjectsDir, this.wslProjectsUncDir].filter(Boolean) as string[];
    for (const baseDir of dirsToScan) {
      try {
        const dirs = fs.readdirSync(baseDir);
        for (const dir of dirs) {
          const candidatePath = path.join(baseDir, dir, fileName);
          if (fs.existsSync(candidatePath)) {
            this.resolvedPaths.set(session.agentId, candidatePath);
            return candidatePath;
          }
        }
      } catch {
        // can't read directory
      }
    }

    return null;
  }

  private makeSlug(workingDirectory: string): string {
    return workingDirectory.replace(/[/\\:_.]/g, '-');
  }
}
