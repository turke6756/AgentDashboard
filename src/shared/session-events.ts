// Typed event union produced by SessionLogReader (main) and consumed by
// ChatPane (renderer). The reader tails the Claude Code JSONL session log at
// ~/.claude/projects/<slug>/<session-id>.jsonl and emits these events.
//
// Intentionally a leaf module: no imports from main/renderer so both sides
// can import freely. Covered by tsconfig.main.json and the renderer tsconfig
// via their respective src/shared/** includes.

export interface BaseEvent {
  uuid: string;
  timestamp: string; // ISO8601
  agentId: string;
}

export interface UserTextEvent extends BaseEvent {
  type: 'user-text';
  text: string;
}

export interface AssistantTextEvent extends BaseEvent {
  type: 'assistant-text';
  text: string;
  model?: string;
  // Metadata for orchestration and structured extraction
  turnComplete?: boolean;
  stopReason?: string;
}

export interface ThinkingEvent extends BaseEvent {
  type: 'thinking';
  text: string;
}

export interface ToolUseEvent extends BaseEvent {
  type: 'tool-use';
  toolUseId: string;
  toolName: string;
  input: unknown; // tool-specific JSON; refined by per-tool blocks in phase 7
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool-result';
  toolUseId: string;
  content: string; // truncated to ~20KB by SessionLogReader
  truncated: boolean;
  isError?: boolean;
}

export interface UsageEvent extends BaseEvent {
  type: 'usage';
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cumulativeContextTokens: number;
  contextWindowMax: number;
  contextPercentage: number;
  // Additive (Codex/Gemini): Anthropic-shaped readers leave these undefined.
  // Phase 6 will redesign this surface with required `provider` and per-provider fields.
  cachedTokens?: number;
  totalTokens?: number;
}

export interface SystemInitEvent extends BaseEvent {
  type: 'system-init';
  model: string;
  cwd?: string;
}

export type SessionEvent =
  | UserTextEvent
  | AssistantTextEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | UsageEvent
  | SystemInitEvent;

export interface ChatEventBatch {
  agentId: string;
  events: SessionEvent[];
  initialLoad?: boolean;
  truncated?: boolean; // true if ring buffer cache evicted older events
}
