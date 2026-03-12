import { EventEmitter } from 'events';
import path from 'path';
import { FileActivity, FileOperation } from '../../shared/types';
import { addFileActivity } from '../database';

/**
 * Parses Claude Code PTY output to detect file read/write/create operations.
 * Hooks into runner 'data' events, strips ANSI, and buffers partial lines.
 */
export class FileActivityTracker extends EventEmitter {
  private agentId: string;
  private workingDirectory: string;
  private lineBuffer: string = '';

  // Patterns matching Claude Code tool usage output
  private static readonly PATTERNS: { regex: RegExp; operation: FileOperation }[] = [
    // Tool-call header format: "⏺ Read(filepath)"
    { regex: /Read\(([^)]+)\)/, operation: 'read' },
    { regex: /Edit\(([^)]+)\)/, operation: 'write' },
    { regex: /Write\(([^)]+)\)/, operation: 'create' },
    // Plain text format: "Read <path>", "Edit <path>", etc.
    { regex: /^\s*(?:⏺\s*)?Read\s+(.+?)(?:\s*$|\s+\()/, operation: 'read' },
    { regex: /^\s*(?:⏺\s*)?Edit\s+(.+?)(?:\s*$|\s+\()/, operation: 'write' },
    { regex: /^\s*(?:⏺\s*)?Write\s+(.+?)(?:\s*$|\s+\()/, operation: 'create' },
    { regex: /^\s*(?:⏺\s*)?Created\s+(.+?)(?:\s*$)/, operation: 'create' },
  ];

  constructor(agentId: string, workingDirectory: string) {
    super();
    this.agentId = agentId;
    this.workingDirectory = workingDirectory;
  }

  /** Feed raw PTY data into the tracker */
  processData(data: string): void {
    // Strip ANSI escape sequences
    const cleaned = this.stripAnsi(data);
    this.lineBuffer += cleaned;

    const lines = this.lineBuffer.split('\n');
    // Keep the last partial line in the buffer
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    for (const { regex, operation } of FileActivityTracker.PATTERNS) {
      const match = line.match(regex);
      if (match && match[1]) {
        const filePath = this.resolvePath(match[1].trim());
        if (filePath) {
          const activity = addFileActivity(this.agentId, filePath, operation);
          if (activity) {
            this.emit('activity', activity);
          }
        }
        return; // Only match once per line
      }
    }
  }

  private resolvePath(rawPath: string): string | null {
    // Skip empty or obviously invalid paths
    if (!rawPath || rawPath.length < 2) return null;
    // Skip paths that look like arguments or flags
    if (rawPath.startsWith('-')) return null;

    // If already absolute, use as-is
    if (path.isAbsolute(rawPath) || rawPath.startsWith('/')) {
      return rawPath;
    }

    // Resolve relative to agent working directory
    // For WSL paths (starting with /), join with forward slash
    if (this.workingDirectory.startsWith('/')) {
      return this.workingDirectory + '/' + rawPath;
    }

    return path.resolve(this.workingDirectory, rawPath);
  }

  private stripAnsi(text: string): string {
    return text
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences
      .replace(/\x1b[()][0-9A-Z]/g, '')          // Character set
      .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '')  // Mode changes
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // Control chars (keep \n \r \t)
  }
}
