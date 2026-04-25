import { EventEmitter } from 'events';
import { ContextStats, FileOperation } from '../../shared/types';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../../shared/constants';
import type { UsageEvent, ToolUseEvent } from '../../shared/session-events';
import { SessionLogReader } from './session-log-reader';

export interface JsonlFileActivity {
  agentId: string;
  filePath: string;
  operation: FileOperation;
}

const TOOL_MAP: Record<string, FileOperation> = {
  'Read': 'read',
  'Edit': 'write',
  'Write': 'create',
  'Glob': 'read',
  'Grep': 'read',
};

export class ContextStatsMonitor extends EventEmitter {
  private stats = new Map<string, ContextStats>();
  private seenUuids = new Map<string, Set<string>>(); // per agentId
  private seenFiles = new Map<string, Set<string>>(); // per agentId: "op:path" dedup
  private reader: SessionLogReader;
  private started = false;

  constructor(reader: SessionLogReader) {
    super();
    this.reader = reader;
  }

  start(): void {
    if (this.started) return;
    this.reader.on('usage', this.handleUsage);
    this.reader.on('tool-use', this.handleToolUse);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.reader.off('usage', this.handleUsage);
    this.reader.off('tool-use', this.handleToolUse);
    this.started = false;
  }

  getStats(agentId: string): ContextStats | null {
    return this.stats.get(agentId) || null;
  }

  /** Force an immediate poll — delegates to the underlying reader. */
  pollNow(): void {
    this.reader.pollNow();
  }

  private handleUsage = (e: UsageEvent): void => {
    // Dedupe by event uuid — the reader already byte-offset tails, but
    // invalidatePath() + pollNow could theoretically replay.
    let seen = this.seenUuids.get(e.agentId);
    if (!seen) {
      seen = new Set();
      this.seenUuids.set(e.agentId, seen);
    }
    if (seen.has(e.uuid)) return;
    seen.add(e.uuid);

    let stats = this.stats.get(e.agentId);
    if (!stats) {
      stats = {
        agentId: e.agentId,
        sessionId: e.sessionId,
        model: e.model,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalOutputTokens: 0,
        totalContextTokens: 0,
        contextWindowMax: e.contextWindowMax || DEFAULT_CONTEXT_WINDOW_TOKENS,
        contextPercentage: 0,
        turnCount: 0,
        lastUpdatedAt: e.timestamp,
      };
    }

    stats.sessionId = e.sessionId;
    stats.model = e.model;
    stats.inputTokens = e.inputTokens;
    stats.cacheCreationTokens = e.cacheCreationTokens;
    stats.cacheReadTokens = e.cacheReadTokens;
    stats.outputTokens = e.outputTokens;
    stats.totalOutputTokens += e.outputTokens;
    stats.turnCount += 1;
    stats.totalContextTokens = e.cumulativeContextTokens;
    stats.contextWindowMax = e.contextWindowMax || DEFAULT_CONTEXT_WINDOW_TOKENS;
    stats.contextPercentage = e.contextPercentage;
    stats.lastUpdatedAt = e.timestamp;

    this.stats.set(e.agentId, stats);
    this.emit('statsChanged', stats);
  };

  private handleToolUse = (e: ToolUseEvent): void => {
    const operation = TOOL_MAP[e.toolName];
    if (!operation) return;

    const input = e.input as { file_path?: unknown; path?: unknown } | null | undefined;
    const filePath = input?.file_path ?? input?.path;
    if (!filePath || typeof filePath !== 'string') return;

    let seen = this.seenFiles.get(e.agentId);
    if (!seen) {
      seen = new Set();
      this.seenFiles.set(e.agentId, seen);
    }
    const key = `${operation}:${filePath}`;
    if (seen.has(key)) return;
    seen.add(key);

    this.emit('fileActivity', { agentId: e.agentId, filePath, operation } as JsonlFileActivity);
  };
}
