import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ContextStats, FileOperation } from '../../shared/types';
import { CONTEXT_STATS_POLL_INTERVAL_MS, DEFAULT_CONTEXT_WINDOW_TOKENS, getContextWindowForModel } from '../../shared/constants';

interface AgentSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
}

export interface JsonlFileActivity {
  agentId: string;
  filePath: string;
  operation: FileOperation;
}

export class ContextStatsMonitor extends EventEmitter {
  private stats = new Map<string, ContextStats>();
  private fileOffsets = new Map<string, number>();
  private partialLines = new Map<string, string>();
  private seenUuids = new Map<string, Set<string>>(); // per agentId
  private seenFiles = new Map<string, Set<string>>(); // per agentId: "op:path" dedup
  private resolvedPaths = new Map<string, string>(); // cache: agentId -> jsonlPath
  private interval: ReturnType<typeof setInterval> | null = null;
  private getActiveAgentSessions: () => AgentSession[];
  private windowsProjectsDir: string | null = null;
  private wslProjectsUncDir: string | null = null;

  constructor(getActiveAgentSessions: () => AgentSession[]) {
    super();
    this.getActiveAgentSessions = getActiveAgentSessions;
    this.resolveProjectsDirs();
  }

  private resolveProjectsDirs(): void {
    // Windows native Claude projects dir
    const userProfile = process.env.USERPROFILE || '';
    const windowsPath = path.join(userProfile, '.claude', 'projects');
    if (fs.existsSync(windowsPath)) {
      this.windowsProjectsDir = windowsPath;
    }

    // WSL Claude projects dir via UNC path
    try {
      const home = execFileSync('wsl.exe', ['bash', '-lc', 'echo $HOME'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      }).trim();
      if (home) {
        const uncPath = `\\\\wsl.localhost\\Ubuntu${home.replace(/\//g, '\\')}` +
          '\\.claude\\projects';
        if (fs.existsSync(uncPath)) {
          this.wslProjectsUncDir = uncPath;
        }
      }
    } catch {
      // WSL not available
    }

    console.log('[context-stats] Windows projects dir:', this.windowsProjectsDir || 'NOT FOUND');
    console.log('[context-stats] WSL projects dir (UNC):', this.wslProjectsUncDir || 'NOT FOUND');
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), CONTEXT_STATS_POLL_INTERVAL_MS);
    // Don't poll immediately — agents haven't been reconciled yet.
    // The first real poll happens after CONTEXT_STATS_POLL_INTERVAL_MS.
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStats(agentId: string): ContextStats | null {
    return this.stats.get(agentId) || null;
  }

  /** Force an immediate poll — called after reconcile so initial data is available. */
  pollNow(): void {
    this.poll();
  }

  private poll(): void {
    const sessions = this.getActiveAgentSessions();

    for (const session of sessions) {
      try {
        this.pollSession(session);
      } catch (err) {
        // Silently skip individual session failures
      }
    }
  }

  private pollSession(session: AgentSession): void {
    const jsonlPath = this.resolveJsonlPath(session);
    if (!jsonlPath) return;

    let fileSize: number;
    try {
      const stat = fs.statSync(jsonlPath);
      fileSize = stat.size;
    } catch {
      return; // File doesn't exist yet
    }

    const lastOffset = this.fileOffsets.get(jsonlPath) || 0;
    if (fileSize <= lastOffset) return; // No new data

    // Read only new bytes
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const bytesToRead = fileSize - lastOffset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, lastOffset);
      this.fileOffsets.set(jsonlPath, fileSize);

      const rawText = buffer.toString('utf-8');
      const partial = this.partialLines.get(jsonlPath) || '';
      const combined = partial + rawText;

      const lines = combined.split('\n');
      // Last element may be incomplete — buffer it
      const maybeLast = lines.pop() || '';
      this.partialLines.set(jsonlPath, maybeLast);

      let statsUpdated = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const entry = JSON.parse(trimmed);
          if (this.processEntry(session.agentId, session.sessionId, entry)) {
            statsUpdated = true;
          }
          // Also extract file activities from tool_use content blocks
          this.extractFileActivities(session.agentId, entry);
        } catch {
          // Malformed JSON line, skip
        }
      }

      if (statsUpdated) {
        const stats = this.stats.get(session.agentId);
        if (stats) {
          this.emit('statsChanged', stats);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private processEntry(agentId: string, sessionId: string, entry: any): boolean {
    if (entry.type !== 'assistant' || !entry.message?.usage) return false;

    // Deduplicate by UUID
    const uuid = entry.uuid || entry.message?.id;
    if (uuid) {
      if (!this.seenUuids.has(agentId)) {
        this.seenUuids.set(agentId, new Set());
      }
      const seen = this.seenUuids.get(agentId)!;
      if (seen.has(uuid)) return false;
      seen.add(uuid);
    }

    const usage = entry.message.usage;
    const model = entry.message.model || 'unknown';

    let stats = this.stats.get(agentId);
    if (!stats) {
      stats = {
        agentId,
        sessionId,
        model,
        inputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalOutputTokens: 0,
        totalContextTokens: 0,
        contextWindowMax: DEFAULT_CONTEXT_WINDOW_TOKENS,
        contextPercentage: 0,
        turnCount: 0,
        lastUpdatedAt: new Date().toISOString(),
      };
    }

    stats.model = model;
    stats.contextWindowMax = getContextWindowForModel(model);
    stats.inputTokens = usage.input_tokens || 0;
    stats.cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    stats.cacheReadTokens = usage.cache_read_input_tokens || 0;
    stats.outputTokens = usage.output_tokens || 0;
    stats.totalOutputTokens += usage.output_tokens || 0;
    stats.turnCount += 1;

    stats.totalContextTokens = stats.inputTokens + stats.outputTokens;
    stats.contextPercentage = Math.min(100, Math.round((stats.totalContextTokens / stats.contextWindowMax) * 100));
    stats.lastUpdatedAt = new Date().toISOString();

    this.stats.set(agentId, stats);
    return true;
  }

  /**
   * Extract file read/write/create activities from JSONL tool_use content blocks.
   * This is the reliable source of file activities (vs PTY scraping which fails for tmux).
   *
   * Claude Code JSONL assistant messages contain content blocks like:
   *   { "type": "tool_use", "name": "Read", "input": { "file_path": "/path/to/file" } }
   *   { "type": "tool_use", "name": "Edit", "input": { "file_path": "/path/to/file" } }
   *   { "type": "tool_use", "name": "Write", "input": { "file_path": "/path/to/file" } }
   */
  private extractFileActivities(agentId: string, entry: any): void {
    if (entry.type !== 'assistant') return;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;

    if (!this.seenFiles.has(agentId)) {
      this.seenFiles.set(agentId, new Set());
    }
    const seen = this.seenFiles.get(agentId)!;

    const TOOL_MAP: Record<string, FileOperation> = {
      'Read': 'read',
      'Edit': 'write',
      'Write': 'create',
      'Glob': 'read',
      'Grep': 'read',
    };

    for (const block of content) {
      if (block.type !== 'tool_use') continue;

      const operation = TOOL_MAP[block.name];
      if (!operation) continue;

      const filePath = block.input?.file_path || block.input?.path;
      if (!filePath || typeof filePath !== 'string') continue;

      const key = `${operation}:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      this.emit('fileActivity', { agentId, filePath, operation } as JsonlFileActivity);
    }
  }

  private resolveJsonlPath(session: AgentSession): string | null {
    // Check cache first
    const cached = this.resolvedPaths.get(session.agentId);
    if (cached) {
      if (fs.existsSync(cached)) return cached;
      this.resolvedPaths.delete(session.agentId);
    }

    const { workingDirectory, sessionId } = session;
    const slug = this.makeSlug(workingDirectory);
    const fileName = `${sessionId}.jsonl`;

    // For WSL working directories (start with /), JSONL is in WSL's ~/.claude/projects/
    if (workingDirectory.startsWith('/') && this.wslProjectsUncDir) {
      const jsonlPath = path.join(this.wslProjectsUncDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        console.log(`[context-stats] Found JSONL for ${session.agentId} (WSL): ${jsonlPath}`);
        return jsonlPath;
      }
    }

    // For Windows working directories, JSONL is in Windows ~/.claude/projects/
    if (this.windowsProjectsDir) {
      const jsonlPath = path.join(this.windowsProjectsDir, slug, fileName);
      if (fs.existsSync(jsonlPath)) {
        this.resolvedPaths.set(session.agentId, jsonlPath);
        console.log(`[context-stats] Found JSONL for ${session.agentId} (Win): ${jsonlPath}`);
        return jsonlPath;
      }
    }

    // Fallback: brute-force scan all project dirs for the session JSONL
    const dirsToScan = [this.windowsProjectsDir, this.wslProjectsUncDir].filter(Boolean) as string[];
    for (const baseDir of dirsToScan) {
      try {
        const dirs = fs.readdirSync(baseDir);
        for (const dir of dirs) {
          const candidatePath = path.join(baseDir, dir, fileName);
          if (fs.existsSync(candidatePath)) {
            this.resolvedPaths.set(session.agentId, candidatePath);
            console.log(`[context-stats] Found JSONL for ${session.agentId} (scan): ${candidatePath}`);
            return candidatePath;
          }
        }
      } catch {
        // Can't read directory
      }
    }

    return null;
  }

  /**
   * Convert a working directory path into a Claude Code project slug.
   * Claude Code replaces path separators, colons, underscores, and dots with dashes.
   *
   * Examples:
   *   C:\Users\turke\Projects\AgentDashboard -> C--Users-turke-Projects-AgentDashboard
   *   /home/turke/AGU25_R_Workshop            -> -home-turke-AGU25-R-Workshop
   *   C:\Users\turke\Projects\JobSearch2.0    -> C--Users-turke-Projects-JobSearch2-0
   */
  private makeSlug(workingDirectory: string): string {
    return workingDirectory
      .replace(/[/\\:_.]/g, '-');
  }
}
