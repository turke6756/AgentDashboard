import type { AgentProvider } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/session-events';

export interface ChatLogReaderSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
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
