# Chat Pane Overhaul — Multi-Phase Plan

> **Handoff doc.** Designed so another agent, in a fresh context window, can pick up at any uncompleted phase and execute it without reading prior conversation.

## Status board

- [x] **Phase 1** — Extract `AgentMarkdown` and `ChatInputBar` to shared files
- [x] **Phase 2** — Add typed event module `src/shared/session-events.ts`
- [x] **Phase 3** — Build `SessionLogReader` in main process (parallel to existing monitor)
- [x] **Phase 4** — Wire chat IPC (`get-chat-events`, `chat-subscribe`, `chat-events` push, `get-tool-result-full`)
- [x] **Phase 5** — Build `ChatPane` + `ContextUsageBar` + `GenericToolBlock` dispatcher
- [x] **Phase 6** — Flip `DetailPanel.tsx` tab 2 to `ChatPane`; dogfood
- [x] **Phase 7** — Per-tool specialists (parallel-friendly — spawn a team here)
  - [x] 7a `EditToolBlock` — diff view
  - [x] 7b `BashToolBlock` — command + collapsible stdout
  - [x] 7c `TodoWriteToolBlock` — checklist
  - [x] 7d `ReadToolBlock` — collapsed file with expand-to-syntax-highlight
  - [x] 7e `GrepToolBlock` + `GlobToolBlock` — match list
  - [x] 7f `WriteToolBlock` — diff against empty (piggyback on 7a)
- [x] **Phase 8** — Collapse `context-stats-monitor.ts` into a `SessionLogReader` consumer
- [x] **Phase 9** — Delete `DetailPaneLog.tsx`
- [x] **Phase 10** — Polish Context + Outputs tabs (grouping, dedupe display)

When picking up: scan this board, find the first unchecked phase, read its section. Each phase is self-contained.

---

## Context

The right-pane **Chat** tab in this Electron + React Claude Code dashboard parses pretty terminal text with regex (`src/renderer/components/detail/DetailPaneLog.tsx`). This breaks markdown tables, loses per-tool structure, and can't show diffs / checklists / syntax-highlighted file reads.

The **Context** and **Outputs** tabs already consume structured JSONL via `src/main/supervisor/context-stats-monitor.ts`, which tails the Claude Code session log at `~/.claude/projects/<slug>/<session-id>.jsonl`. JSONL discovery, byte-offset tailing, partial-line buffering, and Windows-vs-WSL path resolution all already work.

The fix: read the same JSONL the other two tabs already use; render each event type with its own visual treatment; expose context-window usage as a thin bar at the bottom of the chat pane. Terminal escape hatch already exists in the bottom dock (`src/renderer/components/terminal/TerminalPanel.tsx`) — no new terminal tab is needed.

**Out of scope** (future): agent archive / "who wrote file X" / `--resume` from DB. Architecture supports this naturally because the JSONL is already the durable record.

---

## Architecture (unchanging — read once)

### Data flow

```
Claude Code (per agent)
  └─> writes ~/.claude/projects/<slug>/<session-id>.jsonl
        └─> SessionLogReader (main process, per agent)
              ├─> typed events ──> agent:chat-events (push)            ──> ChatPane
              ├─> typed events ──> agent:get-chat-events (handle)      ──> ChatPane (hydrate)
              ├─> UsageEvent  ──> ContextUsageBar (via chat events)
              ├─> ToolUseEvent ──> file activity ──> Context / Outputs tabs
              └─> UsageEvent ──> context stats ──> Context tab
```

`context-stats-monitor.ts` runs alongside `SessionLogReader` until phase 8, then becomes a thin consumer of it.

### Typed event union (defined in phase 2)

```ts
// src/shared/session-events.ts
type SessionEvent =
  | UserTextEvent          // user message text
  | AssistantTextEvent     // model prose
  | ThinkingEvent          // model thinking block
  | ToolUseEvent           // { id, name, input }
  | ToolResultEvent        // { tool_use_id, content, truncated }
  | UsageEvent             // per-turn + cumulative tokens, model
  | SystemInitEvent        // session start metadata
```

All events carry `{ uuid, timestamp, agentId }`.

### JSONL schema (real example lines from `~/.claude/projects/...`)

User turn:
```json
{ "type": "user",
  "message": { "role": "user", "content": "..." OR [...blocks...] },
  "uuid": "...", "timestamp": "...", "agentId": "...", "sessionId": "..." }
```

Assistant turn:
```json
{ "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-6",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Read", "input": { "file_path": "..." } },
      { "type": "thinking", "thinking": "..." }
    ],
    "usage": {
      "input_tokens": 2026,
      "cache_creation_input_tokens": 3414,
      "cache_read_input_tokens": 15018,
      "output_tokens": 38
    }
  },
  "uuid": "...", "timestamp": "...", "agentId": "...", "sessionId": "..." }
```

Tool result lives in a subsequent **user** message: `message.content[].type === "tool_result"` with `tool_use_id` and `content` (string or blocks).

### IPC contract (defined in phase 4)

| Channel | Direction | Payload |
|---|---|---|
| `agent:get-chat-events` | invoke | `(agentId, sinceUuid?) → SessionEvent[]` |
| `agent:chat-subscribe` | invoke | `(agentId) → void` (gates fast-poll rate) |
| `agent:chat-unsubscribe` | invoke | `(agentId) → void` |
| `agent:chat-events` | push | `(agentId, SessionEvent[], { initialLoad?: boolean })` |
| `agent:chat-tool-result-full` | invoke | `(agentId, toolUseId) → string` |
| `agent:context-stats-changed` | push (existing, unchanged) | `(ContextStats)` |
| `agent:file-activity` | push (existing, unchanged) | `(FileActivity)` |

### Reused utilities (do NOT reinvent)

- JSONL path resolution → `src/main/supervisor/context-stats-monitor.ts:261-311`
- Byte-offset tailing + partial-line buffering → `context-stats-monitor.ts:115-127`
- `updateAgentResumeSessionId` signal → `src/main/supervisor/index.ts:515`
- Markdown rendering → `src/renderer/components/detail/DetailPaneLog.tsx:215-337` (will be extracted to shared in phase 1)
- File viewer dispatch → `useDashboardStore().openFileViewer(path, agentId)` → `src/renderer/stores/dashboard-store.ts:289-295`
- File right-click menu → `src/renderer/components/shared/FileContextMenu.tsx`
- PTY escape hatch → `src/renderer/components/terminal/TerminalPanel.tsx` (unchanged)
- Theme hook → `useThemeStore` from `src/renderer/stores/theme-store.ts`; existing pattern is `isLight ? 'light-cls' : 'dark-cls'`
- Markdown libs already installed: `react-markdown`, `remark-gfm`, `react-syntax-highlighter`

### Build / test commands

```bash
npm run build        # main + renderer
npm run start        # launch electron from dist/
npm run build:main   # main process only
npm run build:renderer
```

**Important**: `CLAUDE.md` warns about ghost Vite servers on ports 5173-5175 in dev mode. For verification of these phases, use `npm run build && npm run start` (production) unless you specifically need HMR.

---

## Phase 1 — Extract `AgentMarkdown` and `ChatInputBar`

**Goal**: pull two reusable components out of `DetailPaneLog.tsx` so they survive the eventual deletion of that file. **No behavior change.**

**Where**:
- Source: `src/renderer/components/detail/DetailPaneLog.tsx`
  - `AgentMarkdown` lives at lines 215-337 (uses `react-markdown` + `remark-gfm` + `react-syntax-highlighter`)
  - `ChatInputBar` is the bottom input strip in the same file (search for the input + send button JSX, around the bottom of the component tree)
- New file 1: `src/renderer/components/shared/AgentMarkdown.tsx`
- New file 2: `src/renderer/components/detail/ChatInputBar.tsx`

**Steps**:
1. Read `DetailPaneLog.tsx` end-to-end to find the exact JSX for both pieces.
2. Move `AgentMarkdown` (component + any helper functions it uses) to the new shared file. Re-export `default`. Preserve theme-aware styling.
3. Move `ChatInputBar` similarly. It currently calls `window.api.agents.sendInput(agentId, text)`; keep that API.
4. Update imports in `DetailPaneLog.tsx` to consume the extracted components.
5. Run `npm run build` — must succeed.

**Definition of done**:
- Both files exist and `DetailPaneLog.tsx` imports them.
- `npm run build` clean.
- App launches; chat tab still looks identical.

**Verification**: launch the app, click into an agent's chat tab, send a message — input still works, prior log still renders the same.

### Phases 2-6 completion notes (2026-04-19)

All five phases landed together.

- **Phase 2** — `src/shared/session-events.ts` exists with the typed union + `ChatEventBatch`. Follows flat `export interface` style; zero imports. Covered by both `tsconfig.main.json` and the renderer tsconfig.
- **Phase 3** — `src/main/supervisor/session-log-reader.ts` added. JSONL path resolution + byte-offset tailing copied from `context-stats-monitor.ts` (they still run side-by-side; phase 8 collapses the monitor into a consumer). Variable poll rate via master 1s ticker + per-agent `nextPollAt` (1s subscribed / 5s idle). Per-agent ring buffer capped at 2000 events. Tool-result content truncated at 20KB with `toolResultLocations: Map<${agentId}:${toolUseId}, {jsonlPath, blockIndex, startOffset, endOffset}>` so `getFullToolResult()` re-reads the exact line byte range. EOF streak re-resolution (3 empty polls → `invalidatePath`). `SystemInitEvent` emitted once per agent when the `system` entry is first seen. Wired into `supervisor/index.ts`: constructed alongside `ContextStatsMonitor`, emits `chatEvents` batch on the supervisor. `invalidatePath(agentId)` called at all three `updateAgentResumeSessionId` sites (launch, auto-restart clear, fork).
- **Phase 4** — IPC handlers in `src/main/ipc-handlers.ts`: `agent:get-chat-events`, `agent:chat-subscribe`, `agent:chat-unsubscribe`, `agent:chat-tool-result-full`. Push channel `agent:chat-events` forwarded from `supervisor.on('chatEvents', ...)`. Preload bridge extended in `src/preload/index.ts` (methods land on `window.api.agents`). `IpcApi` type in `src/shared/types.ts` imports `SessionEvent` + `ChatEventBatch` from the new module.
- **Phase 5** — Four new files under `src/renderer/components/detail/`:
  - `ChatPane.tsx` — hydrates via `getChatEvents`, subscribes via `onChatEvents`, unsubscribes on unmount. `pairEvents()` helper maps `tool-result` → `tool-use` by `toolUseId` before flattening to a render list. Scroll-to-bottom ported from `DetailPaneLog.tsx`: near-bottom threshold 80px; first-paint skip flag for hydration. Renders `UserBubble` / `AssistantBubble` / `ThinkingNote` / `ToolBlock` / `SystemNote`.
  - `chat/ContextUsageBar.tsx` — scans events for latest `UsageEvent`, shows model, tokens, %, progress bar, and `out/cache` breakdown.
  - `chat/blocks/ToolBlock.tsx` — dispatcher with an empty `REGISTRY` (phase 7 populates it).
  - `chat/blocks/GenericToolBlock.tsx` — collapsed header with preview, expands to pretty-printed JSON input + result. Error tint when `result.isError`. "Show full output" button calls `window.api.agents.getFullToolResult` when `result.truncated`.
- **Phase 6** — `DetailPanel.tsx` swapped `DetailPaneLog` import + render to `ChatPane`. Old file left in place per plan for rollback.

Still TODO:
- **Phase 7** — per-tool specialists (Edit, Bash, TodoWrite, Read, Grep, Glob, Write). `REGISTRY` in `ToolBlock.tsx` is the single registration point. Each block receives `ToolBlockProps` exported from `GenericToolBlock.tsx`: `{ toolUseId, toolName, input, result?, agentId }`. Parallel-friendly.
- **Phase 8** — collapse `context-stats-monitor.ts` into a `SessionLogReader` consumer (subscribe to `reader.on('usage', …)` for stats and `reader.on('tool-use', …)` for file activity). Supervisor already exposes `getSessionLogReader()`.
- **Phase 9** — delete `DetailPaneLog.tsx` once phase 7/8 are settled.

Manual verification not yet performed — phases 2-6 compile clean (`npm run build` passes). The user should `npm run build && npm run start` and confirm: chat tab renders new bubbles, markdown tables work, tool blocks collapse/expand, context bar shows at bottom, other tabs unaffected.

### Phase 1 completion notes (2026-04-19)

Landed as-planned. Pointers for later phases:

- `AgentMarkdown` → `src/renderer/components/shared/AgentMarkdown.tsx` (default export, prop `{ content: string }`). Import from `ChatPane` (phase 5) as `import AgentMarkdown from '../shared/AgentMarkdown'`.
- `ChatInputBar` → `src/renderer/components/detail/ChatInputBar.tsx` (default export, props `{ agentId, agentStatus }`). The `ACCEPTING_INPUT: AgentStatus[]` whitelist is now module-private there — if phase 5's `ChatPane` needs the same disabled/enabled logic, reuse it by dropping the input bar in rather than redefining the whitelist.
- `DetailPaneLog.tsx` shrank 733 → 451 lines and now imports both extracted files. It still owns `parseLog` / `toChatBlocks` / `ToolActivity` / `UserMessage` / `AgentMessage` / `ThinkingNote` / `SystemNote`. Those all die in phase 9 — no need to touch them before then.
- `src/shared/types.ts` uses flat `export type` / `export interface` (no namespaces, no default exports). Phase 2's new `src/shared/session-events.ts` should follow that style — no tsconfig changes needed; both `tsconfig.main.json` and the renderer's Vite config already cover `src/shared/**`.
- `AgentStatus` is exported from `src/shared/types.ts` if any `SessionEvent`-adjacent code wants it (phase 4's IPC types, probably not phase 2 itself).

---

## Phase 2 — Typed event module

**Goal**: define the shared `SessionEvent` union types used by main and renderer.

**Where**: new file `src/shared/session-events.ts`.

**Contents** (template — adjust field names if conflicts arise):

```ts
export interface BaseEvent {
  uuid: string;
  timestamp: string;     // ISO8601
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
}

export interface ThinkingEvent extends BaseEvent {
  type: 'thinking';
  text: string;
}

export interface ToolUseEvent extends BaseEvent {
  type: 'tool-use';
  toolUseId: string;
  toolName: string;
  input: unknown;        // tool-specific JSON
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool-result';
  toolUseId: string;
  content: string;       // truncated to ~20KB
  truncated: boolean;
  isError?: boolean;
}

export interface UsageEvent extends BaseEvent {
  type: 'usage';
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cumulativeContextTokens: number;
  contextWindowMax: number;
  contextPercentage: number;
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
  truncated?: boolean;   // true if cache evicted older events
}
```

**Definition of done**: file exists, exports compile (`npm run build:main` and `:renderer` both pass).

---

## Phase 3 — `SessionLogReader` (main process)

**Goal**: build the reader that tails JSONL files and emits typed events. Runs **alongside** the existing `context-stats-monitor.ts` — no shared state yet.

**Where**: new file `src/main/supervisor/session-log-reader.ts`.

**Class shape**:

```ts
import { EventEmitter } from 'events';
import type { SessionEvent, ChatEventBatch } from '../../shared/session-events';

export class SessionLogReader extends EventEmitter {
  // events emitted:
  //   'chat-events' (batch: ChatEventBatch)
  //   'usage' (event: UsageEvent)        // also included in chat-events
  //   'tool-use' (event: ToolUseEvent)   // also included in chat-events
  //
  // Used by phase 8 (context-stats-monitor consumer):
  //   'usage' → context stats
  //   'tool-use' → file activity

  constructor(getActiveAgentSessions: () => AgentSession[]);
  start(): void;
  stop(): void;

  // For chat IPC:
  addChatSubscriber(agentId: string): void;     // bumps that agent to fast poll
  removeChatSubscriber(agentId: string): void;  // returns to slow poll
  getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean };
  getFullToolResult(agentId: string, toolUseId: string): Promise<string | null>;

  // For phase 8 hook:
  pollNow(): void;
}
```

**Implementation requirements**:

- **JSONL path resolution**: copy logic from `context-stats-monitor.ts:261-311`. Include both Windows and WSL UNC paths, the brute-force scan fallback, and per-agent caching.
- **Tailing**: copy byte-offset + partial-line logic from `context-stats-monitor.ts:115-127`.
- **Re-resolution**: when `updateAgentResumeSessionId` fires (`supervisor/index.ts:515`) OR after **N consecutive EOF polls** (e.g., 3) despite the agent being in `working` status, re-resolve the JSONL path.
- **Variable poll rate**: maintain one `setInterval`. Per-agent rate flips between **1000ms** (any chat subscriber attached) and **5000ms** (no subscribers). Implementation hint: track per-agent `nextPollAt` timestamp and run a single 1s ticker that polls only the agents whose timer has elapsed.
- **Per-agent ring buffer cache**: cap at **2000 events**. When evicting, set a per-agent `truncated: true` flag returned by `getCachedEvents`.
- **Tool-result truncation**: cap each `tool_result.content` at **~20KB** in the cached/emitted event; record the source byte offset in the JSONL line so `getFullToolResult` can re-read the line and return full content.
- **Batch emission**: each poll tick emits one `chat-events` batch per agent (with all new events from that tick), not one event per line.
- **Parsing**: walk the JSONL line, decode top-level `type` (`user` / `assistant`), then walk `message.content` blocks (text, tool_use, thinking) for assistant turns; for user turns, check if content is a string (text event) or blocks (tool_result events). Extract `usage` from assistant turns into a separate `UsageEvent`.
- **`SystemInitEvent`**: read first line of JSONL if it's a session-init record (Claude Code writes one); emit once.
- **Pairing**: do NOT pair `tool_use` ↔ `tool_result` in the reader. Emit them as separate events; the renderer pairs by `toolUseId`.

**Wire up** in `src/main/supervisor/index.ts`:
- Instantiate `SessionLogReader` next to the existing `ContextStatsMonitor` (around line 169).
- Call `start()` in `supervisor.start()` (around line 204).
- Hook `updateAgentResumeSessionId` to invoke a `reader.invalidatePath(agentId)` method.

**Don't yet**: don't wire IPC, don't remove anything from `context-stats-monitor.ts`. Phase 4 wires IPC; phase 8 collapses the monitor.

**Definition of done**:
- New file exists, `npm run build:main` clean.
- Add a temporary debug `console.log` like `[reader] agent ${id}: parsed N events` per poll. Launch an agent and confirm in the main-process console that the count grows over time without errors.

**Verification**:
- Launch the app, launch an agent that does some text + a tool call.
- In the main-process console, expect `[reader] agent <id>: parsed N events` lines, with N increasing.
- Both Context and Outputs tabs continue to work (proves the existing monitor is unaffected).

---

## Phase 4 — IPC wiring

**Goal**: expose chat events from `SessionLogReader` to the renderer.

**Where**:
- `src/main/ipc-handlers.ts` — add handlers
- `src/preload/index.ts` — expose bridge methods
- `src/main/supervisor/index.ts` — forward batches via `mainWindow.webContents.send`

**Add to `ipc-handlers.ts`**:

```ts
ipcMain.handle('agent:get-chat-events', (_e, agentId, sinceUuid) =>
  reader.getCachedEvents(agentId, sinceUuid));
ipcMain.handle('agent:chat-subscribe', (_e, agentId) =>
  reader.addChatSubscriber(agentId));
ipcMain.handle('agent:chat-unsubscribe', (_e, agentId) =>
  reader.removeChatSubscriber(agentId));
ipcMain.handle('agent:chat-tool-result-full', (_e, agentId, toolUseId) =>
  reader.getFullToolResult(agentId, toolUseId));
```

**Forward push events** (in `supervisor/index.ts` near where existing forwards live, around line 280):

```ts
reader.on('chat-events', (batch) => {
  mainWindow?.webContents.send('agent:chat-events', batch);
});
```

**Add to `preload/index.ts`** (look at existing entries around lines 17-36 for patterns):

```ts
agents: {
  // ...existing...
  getChatEvents: (agentId, sinceUuid) =>
    ipcRenderer.invoke('agent:get-chat-events', agentId, sinceUuid),
  chatSubscribe: (agentId) =>
    ipcRenderer.invoke('agent:chat-subscribe', agentId),
  chatUnsubscribe: (agentId) =>
    ipcRenderer.invoke('agent:chat-unsubscribe', agentId),
  getFullToolResult: (agentId, toolUseId) =>
    ipcRenderer.invoke('agent:chat-tool-result-full', agentId, toolUseId),
  onChatEvents: (callback) => {
    const handler = (_e, batch) => callback(batch);
    ipcRenderer.on('agent:chat-events', handler);
    return () => ipcRenderer.off('agent:chat-events', handler);
  },
}
```

**Update preload type definition** in `src/renderer/assets.d.ts` (or wherever the `window.api` type lives — search for `getLog` signature).

**Definition of done**: `npm run build` clean. From DevTools (in the running app) you can do:

```js
await window.api.agents.chatSubscribe('<some-agent-id>');
await window.api.agents.getChatEvents('<some-agent-id>');
```

…and get an array of events back.

---

## Phase 5 — `ChatPane` + `ContextUsageBar` + `GenericToolBlock`

**Goal**: build the new chat UI end-to-end with a generic tool fallback (no per-tool specialists yet).

**Where**:
- `src/renderer/components/detail/ChatPane.tsx` (new)
- `src/renderer/components/detail/chat/ContextUsageBar.tsx` (new)
- `src/renderer/components/detail/chat/blocks/ToolBlock.tsx` (new — dispatcher)
- `src/renderer/components/detail/chat/blocks/GenericToolBlock.tsx` (new — fallback)

**`ChatPane.tsx` skeleton**:

```tsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { SessionEvent, ChatEventBatch } from '../../../shared/session-events';
import AgentMarkdown from '../shared/AgentMarkdown';
import ChatInputBar from './ChatInputBar';
import ToolBlock from './chat/blocks/ToolBlock';
import ContextUsageBar from './chat/ContextUsageBar';

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
  agentName?: string;
}

export default function ChatPane({ agentId, agentStatus, agentName }: Props) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  // Hydrate + subscribe
  useEffect(() => {
    let mounted = true;
    (async () => {
      await window.api.agents.chatSubscribe(agentId);
      const initial = await window.api.agents.getChatEvents(agentId);
      if (mounted) setEvents(initial.events);
    })();

    const unsub = window.api.agents.onChatEvents((batch: ChatEventBatch) => {
      if (batch.agentId !== agentId) return;
      setEvents((prev) => [...prev, ...batch.events]);
    });

    return () => {
      mounted = false;
      window.api.agents.chatUnsubscribe(agentId);
      unsub();
    };
  }, [agentId]);

  // Pair tool_use ↔ tool_result by toolUseId, then render
  const rendered = pairAndGroupEvents(events);

  // Scroll-to-bottom (preserve 80px threshold from DetailPaneLog)
  // ... (port from DetailPaneLog.tsx scroll handling, lines ~660-685)

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {rendered.map((item) => /* dispatch by item.kind */)}
      </div>
      <ContextUsageBar agentId={agentId} events={events} />
      <ChatInputBar agentId={agentId} agentStatus={agentStatus} />
    </div>
  );
}
```

**Pairing helper** (in `ChatPane.tsx` or extracted):

```ts
// Walks events, builds a map toolUseId → ToolResultEvent, then produces a
// mixed list of "messages" where each tool_use is enriched with its result.
// Unpaired tool_use (still running) → render with "running…" state.
```

**`ContextUsageBar.tsx`**:
- Subscribes to the same `events` array (or to a derived "latest UsageEvent").
- Renders: `<model> · <cumulative>/<max> tokens (<pct>%) · +<lastTurnDelta>`.
- Tiny strip: `text-xs text-fg-muted px-3 py-1 border-t border-surface-2`.

**`ToolBlock.tsx`**:

```tsx
import GenericToolBlock from './GenericToolBlock';
// future: import EditToolBlock, BashToolBlock, etc.

const REGISTRY: Record<string, React.FC<ToolBlockProps>> = {
  // 'Edit': EditToolBlock,
  // 'Bash': BashToolBlock,
  // ...
};

export default function ToolBlock(props: ToolBlockProps) {
  const Component = REGISTRY[props.toolName] || GenericToolBlock;
  return <Component {...props} />;
}
```

**`GenericToolBlock.tsx`**: port the `ToolActivity` UX from `DetailPaneLog.tsx:372-476`. Collapsed header, expand to show formatted JSON input + tool result. Support `truncated: true` → "Show full output" button that calls `window.api.agents.getFullToolResult`.

**Definition of done**:
- `npm run build` clean.
- Component is unit-renderable (can be imported without crashing).
- NOT yet wired into `DetailPanel.tsx` — that's phase 6.

---

## Phase 6 — Flip the tab

**Goal**: replace `DetailPaneLog` with `ChatPane` under tab 2 of the detail panel.

**Where**: `src/renderer/components/layout/DetailPanel.tsx`.

**Steps**:
1. Find the `TABS` array (around line 12) and the conditional render (around line 340).
2. Change the import from `DetailPaneLog` to `ChatPane`.
3. Swap `<DetailPaneLog ... />` for `<ChatPane ... />` under `detailPane === 2`.
4. **Do NOT delete** `DetailPaneLog.tsx` yet — leave it unreferenced for rollback safety.

**Definition of done**:
- App launches; clicking an agent shows the new chat pane under the Chat tab.
- An agent doing prose + a tool call shows: user bubble, agent bubble (with markdown working — try a markdown table), generic tool block with collapse/expand.
- Context usage bar visible at bottom.
- Context and Outputs tabs unchanged.

**Verification (manual)**:
1. `npm run build && npm run start`.
2. Launch a fresh agent. Ask it: *"reply with a markdown table comparing apples vs oranges"*.
3. Confirm the table renders as a real table (not literal `|---|`).
4. Have it run `Bash: ls -la` — confirm a generic tool block appears, expand shows command + output.
5. Watch the bottom bar update with model + token count after each turn.

---

## Phase 7 — Per-tool specialists

**This is the team-spawn point.** Each block is independent; they can be built in parallel.

**Shared contract** for every tool block:

```tsx
interface ToolBlockProps {
  toolUseId: string;
  toolName: string;
  input: unknown;                              // tool-specific JSON
  result?: { content: string; truncated: boolean; isError?: boolean };
  // result is undefined if tool is still running
  agentId: string;                             // for openFileViewer dispatch
  workingDirectory: string;                    // for resolving relative file paths
  pathType: 'wsl' | 'windows';
}
```

Register each block in `src/renderer/components/detail/chat/blocks/ToolBlock.tsx`'s `REGISTRY`.

### 7a — `EditToolBlock`

**Input shape**: `{ file_path: string, old_string: string, new_string: string, replace_all?: boolean }`.

**Render**:
- Header: file basename + dirname (use `dashboard-store.openFileViewer` for click).
- Diff: red lines for `old_string`, green for `new_string`. Use a tiny LCS-style diff or pull in the `diff` npm package — check `package.json` first to see if it's already available, otherwise prefer a hand-rolled line splitter for small edits.
- Show line numbers if computable from a recent `Read` event (optional).
- Compact monospace, no horizontal scroll for single-line diffs.

### 7b — `BashToolBlock`

**Input shape**: `{ command: string, description?: string, timeout?: number, run_in_background?: boolean }`.

**Render**:
- Single-line code chip showing `command`. If multi-line, collapse to first line with expand.
- Result body: monospace `<pre>`, default visible at ~8 lines, "Show all" expands.
- If `result.isError` → tint red.
- Watch for ANSI in output — if present, run through a minimal `ansi-to-html` (or strip if simpler).

### 7c — `TodoWriteToolBlock`

**Input shape**: `{ todos: { content: string, status: 'pending'|'in_progress'|'completed', activeForm: string }[] }`.

**Render**:
- Real checklist. Status icons: ☐ pending, ▶ in_progress (highlighted), ✓ completed (struck through).
- No collapse — always visible; this is high-signal, low-volume.

### 7d — `ReadToolBlock`

**Input shape**: `{ file_path: string, offset?: number, limit?: number }`.

**Render**:
- Header: file path (clickable via `openFileViewer`), `+N lines` badge, range like `lines 100-200` if offset/limit present.
- Body: collapsed by default. Expand → syntax-highlighted file content (use `react-syntax-highlighter`, infer language from extension). Cap rendered length; if `result.truncated` show "Open in viewer" button.

### 7e — `GrepToolBlock` + `GlobToolBlock`

**Input shape (Grep)**: `{ pattern: string, path?: string, glob?: string, output_mode?: string, ... }`.
**Input shape (Glob)**: `{ pattern: string, path?: string }`.

**Render**:
- Header: pattern + match count (parse from `result.content`).
- List of files; if `output_mode: content`, show line snippets per file with the matched substring highlighted.
- Each file row clickable → `openFileViewer`.

### 7f — `WriteToolBlock`

**Input shape**: `{ file_path: string, content: string }`.

**Render**: reuse `EditToolBlock` rendering with `old_string=''` and `new_string=content`. Header indicates "created" instead of "modified".

**Definition of done (per block)**:
- Block renders under `ToolBlock` dispatcher when matching tool name appears.
- Click-to-open-file works where applicable.
- Theme-aware (light + dark).
- Add the entry to the registry.

---

## Phase 8 — Collapse `context-stats-monitor.ts` into a consumer

**Goal**: remove the duplicate JSONL-tailing in `context-stats-monitor.ts`. After this phase, only `SessionLogReader` reads the JSONL.

**Where**: `src/main/supervisor/context-stats-monitor.ts`.

**Steps**:
1. Strip out: poll loop, file-offset tracking, partial-line buffer, JSONL parsing, JSONL path resolution. **Keep**: the public class shape, `getStats(agentId)`, the events `statsChanged` and `fileActivity`, the dedup `seenUuids` / `seenFiles` maps.
2. In the constructor, also accept the `SessionLogReader` instance.
3. Subscribe to reader events:
   ```ts
   reader.on('usage', (e: UsageEvent) => {
     // build/update ContextStats from cumulative tokens
     // emit 'statsChanged' with the same payload shape as today
   });
   reader.on('tool-use', (e: ToolUseEvent) => {
     // map tool name → operation (Read/Glob/Grep → read, Edit → write, Write → create)
     // dedupe by `${operation}:${filePath}` per agent
     // emit 'fileActivity' with the existing JsonlFileActivity shape
   });
   ```
4. Update wiring in `supervisor/index.ts` to pass the reader to the monitor's constructor.
5. The DB writes for `file_activities` (in `supervisor/index.ts:187-192`) and the IPC forwards stay unchanged.

**Definition of done**:
- `npm run build` clean.
- App launches.
- Open an active agent: Context tab still shows the same reads in the same order; Outputs tab still shows writes/creates; context % still updates.

**Verification**:
- Pick an agent that's been running. Note its file activity counts and context %.
- After phase 8, restart the app, reopen the same agent. Counts and percent should match.
- Bonus: run a Bash command; verify NO file activity appears for it (correct — Bash is not a file op).

---

## Phase 9 — Delete legacy

**Goal**: remove `DetailPaneLog.tsx`.

**Steps**:
1. `grep` for `DetailPaneLog` across `src/` — should find no remaining references.
2. Delete `src/renderer/components/detail/DetailPaneLog.tsx`.
3. `npm run build` — must pass.

**Definition of done**: file gone, build clean, app still launches and chat works.

---

## Phase 10 — Polish Context + Outputs tabs

**Goal**: minor visual / UX improvements that the user mentioned wanting.

**Where**:
- `src/renderer/components/detail/DetailPaneContext.tsx`
- `src/renderer/components/detail/DetailPaneProducts.tsx`
- `src/renderer/components/detail/FileActivityList.tsx`

**Ideas to consider** (not all required — prioritize with user):
- Group activities by directory (collapsible folder headers).
- Show per-file read count (badge: "read 5×").
- Distinguish `created` vs `modified` more prominently in the Outputs tab.
- Sort by most recent activity per file rather than per event.
- Optional: small line-diff preview hover for write operations.

**Definition of done**: visual review with the user; no functional regression.

---

## Risks & mitigations (reference)

| Risk | Mitigation |
|---|---|
| JSONL rotation under `--resume` | Re-resolve path on `updateAgentResumeSessionId` change or after N EOF polls despite agent activity. |
| Huge `tool_result` blobs (10k-line `Read`) | Truncate to ~20KB at reader; flag `truncated: true`; on-demand `getFullToolResult` re-reads JSONL line. |
| IPC saturation | Batch one `chat-events` message per poll tick, not per JSONL line. |
| Unbounded memory | Per-agent ring buffer cap at ~2000 events. |
| Ghost Vite server | Use `npm run build && npm run start` for verification; kill processes on 5173-5175 if UI changes don't appear. |
| `tool_use` ↔ `tool_result` pairing across turns | Renderer pairs by `toolUseId` map, never by positional adjacency. |
| Cold start parses entire JSONL | Acceptable — users want history. Mark first batch `initialLoad: true` so renderer skips autoscroll animation. |
| Regressions in Context/Outputs in phase 8 | Reader runs in parallel with monitor through phase 7; phase 8 is local + revertible. Diff file-activity counts pre/post. |

---

## File map (final state)

### Created

- `src/main/supervisor/session-log-reader.ts`
- `src/shared/session-events.ts`
- `src/renderer/components/shared/AgentMarkdown.tsx`
- `src/renderer/components/detail/ChatInputBar.tsx`
- `src/renderer/components/detail/ChatPane.tsx`
- `src/renderer/components/detail/chat/ContextUsageBar.tsx`
- `src/renderer/components/detail/chat/blocks/ToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/GenericToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/EditToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/BashToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/TodoWriteToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/ReadToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/GrepToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/GlobToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/WriteToolBlock.tsx`
- `src/renderer/components/detail/chat/blocks/diff.ts` (utility)

### Modified

- `src/main/supervisor/context-stats-monitor.ts` (phase 8 — collapsed to consumer)
- `src/main/supervisor/index.ts`
- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/renderer/assets.d.ts` (preload types)
- `src/renderer/components/layout/DetailPanel.tsx`
- `src/renderer/components/detail/DetailPaneContext.tsx` (phase 10 polish)
- `src/renderer/components/detail/DetailPaneProducts.tsx` (phase 10 polish)
- `src/renderer/components/detail/FileActivityList.tsx` (phase 10 polish)

### Deleted

- `src/renderer/components/detail/DetailPaneLog.tsx` (phase 9)
