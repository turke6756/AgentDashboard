import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentProvider } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/session-events';

export interface ChatLogReaderSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
  startedAt?: string;
  /** True when the chat pane is open for this agent — readers may use this to do aggressive path re-resolution after N empty ticks. */
  subscribed: boolean;
}

export interface ChatLogReader {
  readonly provider: AgentProvider;
  /** Tail the on-disk session log and return any new events since the last call. Stateful: tracks byte offsets internally. */
  pollSession(session: ChatLogReaderSession): SessionEvent[];
  /** Drop cached path/offsets for an agent. Called when resumeSessionId changes. */
  invalidatePath(agentId: string): void;
  /** Re-read the full content of a previously-truncated tool_result. Returns null if the reader doesn't track this agent or tool result. */
  getFullToolResult?(agentId: string, toolUseId: string): Promise<string | null>;
}

export const TOOL_RESULT_TRUNCATE_BYTES = 20_000;

/**
 * Flatten a tool-result `content` field into a single string.
 *
 * Handles the union of shapes seen across providers:
 *   - Claude: `string` or `Array<{type:'text', text:string}>`
 *   - Codex:  `string`, or structured `{output, metadata}` (function_call_output),
 *             or array of `{type:'output_text'|'text', text}` blocks
 *   - Gemini: `Array<{functionResponse:{response:{output|text|error: string}}}>`
 */
export function flattenToolResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.output === 'string') parts.push(b.output);
      else if (b.functionResponse && typeof b.functionResponse === 'object') {
        const fr = b.functionResponse as Record<string, unknown>;
        const resp = fr.response;
        if (resp && typeof resp === 'object') {
          const r = resp as Record<string, unknown>;
          if (typeof r.output === 'string') parts.push(r.output);
          else if (typeof r.text === 'string') parts.push(r.text);
          else if (typeof r.error === 'string') parts.push(r.error);
        }
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.output === 'string') return c.output;
    if (typeof c.text === 'string') return c.text;
    if (Array.isArray(c.content)) return flattenToolResultContent(c.content);
  }
  return '';
}

export function truncateForChat(text: string): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= TOOL_RESULT_TRUNCATE_BYTES) return { content: text, truncated: false };
  const sliced = text.slice(0, TOOL_RESULT_TRUNCATE_BYTES);
  return { content: sliced, truncated: true };
}

/**
 * Resolve a per-home subdirectory across both Windows host and WSL.
 *
 * Returns `{windowsDir, wslUncDir}` — either may be null if the dir doesn't exist
 * on that side. WSL home is discovered via `wsl.exe bash -lc 'echo $HOME'`.
 *
 * Example:
 *   resolveHomeSubdir('.codex/sessions')
 *     → { windowsDir: 'C:\\Users\\me\\.codex\\sessions',
 *         wslUncDir:  '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions' }
 *
 * `subpath` is a forward-slash relative path under `~`. Both segments are joined
 * with the platform-appropriate separator.
 */
export function resolveHomeSubdir(subpath: string): {
  windowsDir: string | null;
  wslUncDir: string | null;
} {
  const segments = subpath.split('/').filter(Boolean);

  let windowsDir: string | null = null;
  const userProfile = process.env.USERPROFILE || '';
  if (userProfile) {
    const candidate = path.join(userProfile, ...segments);
    if (fs.existsSync(candidate)) windowsDir = candidate;
  }

  let wslUncDir: string | null = null;
  try {
    const home = execFileSync('wsl.exe', ['bash', '-lc', 'echo $HOME'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (home) {
      const homeBackslashed = home.replace(/\//g, '\\');
      const subBackslashed = segments.join('\\');
      const candidate = `\\\\wsl.localhost\\Ubuntu${homeBackslashed}\\${subBackslashed}`;
      if (fs.existsSync(candidate)) wslUncDir = candidate;
    }
  } catch {
    // WSL not available
  }

  return { windowsDir, wslUncDir };
}
