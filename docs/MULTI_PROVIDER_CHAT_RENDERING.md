# Multi-Provider Chat Rendering — Full-Send Plan

> **Audience:** an autonomous agent executing this rebuild.
> **Companion docs:** [`CHAT_PANE_OVERHAUL.md`](./CHAT_PANE_OVERHAUL.md) holds the *why* of the existing Claude-only chat surface. [`CODEX_INPUT_HANDOFF.md`](./CODEX_INPUT_HANDOFF.md) and [`SEND_INPUT_WSL_BUG.md`](./SEND_INPUT_WSL_BUG.md) cover input-path work that is already done. This plan adds the missing **return path** (agent → ChatPane) for Codex and Gemini.

## Mission

Make the dashboard's chat pane render conversations from **all three** supported providers — Claude Code, Codex CLI, Gemini CLI — with first-class parity for: text turns, reasoning/thinking, tool calls + results, and context-window usage.

Today, only Claude works end-to-end. Input dispatch (`sendInput`) reaches all three providers, but only Claude's responses flow back into ChatPane because the only on-disk reader (`SessionLogReader`) parses Anthropic's JSONL schema at `~/.claude/projects/<slug>/<session-id>.jsonl`. Codex and Gemini agents accept input silently and never echo anything to the chat surface — including the user's own typed message — so the chat pane appears completely dead.

## Out of scope

- Replacing the input-path encoding logic in `_doSendInput` (already correct for all three providers).
- Cosmetic changes to `ChatPane`, `ChatInputBar`, `ContextUsageBar` beyond what parity requires.
- Codex-specific `resume` (separate TODO at `src/main/supervisor/index.ts:1021-1026`); however, **the session-id discovery code added in Phase 2 of this plan is shared with that future work** — design it so codex-resume can re-use it.
- Provider-agnostic UI for inter-agent queries (Claude-only feature today; not in scope).

## Background — what is broken and why

1. `src/main/supervisor/session-log-reader.ts` only resolves paths under `~/.claude/projects/<slug>/<session-id>.jsonl` (lines 64-84, 485-529) and only parses Anthropic's schema in `parseEntry` (lines 267-445). No sibling reader exists for any other provider.
2. `ChatPane` synthesizes the user's own bubble from a `user-text` SessionEvent that the reader produces by re-reading Claude's JSONL after Claude Code itself logs the user message. For Gemini/Codex, no `user-text` event is ever emitted — so even the user's typed message never appears.
3. `ContextUsageBar` consumes `usage` events with Anthropic-shaped fields (`cache_creation_input_tokens`, `cache_read_input_tokens`). Codex and Gemini emit token counts in different shapes.
4. `ToolBlock` switches on Claude tool names (`Edit`, `Write`, `Bash`, `Read`, `Grep`, `Glob`, `TodoWrite`). Codex names tools `shell`, `apply_patch`, `read_file`, etc.; Gemini names them `replace`, `write_file`, `read_file`. Even with a Codex/Gemini reader, ToolBlock will fall through to `GenericToolBlock` for everything.

## Research references — verified during recon

These were verified against on-disk files and source/docs during the May 2026 recon. The schemas section near the bottom of this doc transcribes the salient bits, so the implementer does not need to re-fetch them mid-build, but cite these when in doubt.

### Codex CLI

- On-disk path: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<sessionId>.jsonl`. Confirmed on Windows host (`C:\Users\turke\.codex\sessions\…`) and in WSL (`/home/turke/.codex/sessions/…`).
- Official schema generator (Rust source of truth): [`openai/codex#14434`](https://github.com/openai/codex/pull/14434) merged 2026-03. Run `codex app-server generate-json-schema --out ./schemas` to produce `RolloutLine.json`. (Note: command is `generate-json-schema`, not `generate-internal-json-schema` — earlier draft of this doc had it wrong.)
- **Pinned tested-against version: codex-cli `0.128.0`** (recon-of-recon May 2026). Earlier recon used `0.125.0`; the current installed version on this dev box is `0.128.0`, and the on-disk rollout files still self-report `cli_version: "0.125.0"` from sessions captured under the older binary. Capture a fresh fixture under 0.128 in Phase 2.
- Background discussion: [`openai/codex#3827`](https://github.com/openai/codex/discussions/3827).
- Rollout items design: [`openai/codex#3380`](https://github.com/openai/codex/pull/3380).

### Gemini CLI

- On-disk path: `~/.gemini/tmp/<project_hash>/chats/session-<ISO-ts>-<id>.{json,jsonl}`. Confirmed in `~/.gemini/tmp/agentdashboard/chats/`. Mixed `.json` (legacy) and `.jsonl` (new) files coexist.
- Active migration to JSONL: [`google-gemini/gemini-cli#15292`](https://github.com/google-gemini/gemini-cli/issues/15292) and commit `f044b34` "feat: add JSONL session recording".
- Storage discussion: [`google-gemini/gemini-cli#4974`](https://github.com/google-gemini/gemini-cli/discussions/4974).
- User-facing docs: [`session-management.md`](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md), [`checkpointing.md`](https://google-gemini.github.io/gemini-cli/docs/cli/checkpointing.html).
- **Schema is not officially documented** — it must be derived from observed files and the source. Treat it as unstable and gate behind defensive parsing.
- **Pinned tested-against version: gemini-cli `0.40.1`** (WSL-native, nvm-installed). The Windows host has `0.40.0` from the npm install; pick one canonical version per environment when capturing fixtures.

> **⚠️ Recon-of-recon (May 2026): on-disk reality contradicts the original recon.** A re-scan of `~/.gemini/tmp/` on this dev box found **0 `.jsonl` files and 23 `.json` files** across all projects. The original recon claimed mixed files; that may have been wrong, or a Gemini upgrade may have reverted the JSONL behavior. Phase 4 cannot proceed until we know **what makes Gemini emit `.jsonl` instead of `.json`** — a CLI flag, a config setting, a version threshold, a `--output-format` interaction, or something else. See "Phase 4 prerequisites" below.

> **⚠️ Resume semantics are different than the original recon assumed.** `gemini --resume <string>` takes only `"latest"` or an **index number** (e.g. `--resume 5`) per `gemini --help` on 0.40.x. It does **not** accept a session UUID. The dashboard's existing bare `--resume` (no value) at `index.ts:1016, 1122` is suspect under yargs `[string]`-with-required-value rules — verify before relying on it. Resume itself is out of scope for chat rendering, but the path-resolution code in Phase 4 cannot use the trailing-hex-of-filename trick to map `agent.resumeSessionId` → file directly; it has to discover the file via post-launch dir snapshot/diff, same as Codex.

### Claude (already implemented, reference only)

- On-disk path: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`.
- Existing parser: `src/main/supervisor/session-log-reader.ts` (this file becomes the `ClaudeJsonlReader` after Phase 1 extraction).

## Rules of engagement (agent)

- **Commit at the end of every phase.** Message format: `multi-provider chat phase N: <phase name>`. No amending — pre-commit hooks must run cleanly on a fresh commit.
- **`npm run build` must pass at the end of every phase.** If it doesn't, fix or stop.
- **Stop and report at every `STOP` marker.** Do not proceed past one without explicit human confirmation.
- **Do not delete `SessionLogReader` until Phase 7.** Keep it working as the Claude reader during the migration; orphan callers point at the new dispatcher.
- **No new behavior without an event-payload test.** Every new reader phase must include a unit test that pins the parser against a captured fixture from the reference rollout/session file.
- **Capture fixtures from real sessions, not made-up JSON.** Anonymize CWDs and prompts but keep envelope/schema shape.
- **If an acceptance check fails, stop.** Do not "try harder" through repeated variations. Report: what step, what error, what you tried, what you think the cause is.
- **Electron does not hot-reload the main process.** Any change under `src/main/` requires a full app relaunch.
- **Schema-version probe before parsing.** Codex `cli_version` from `session_meta`; Gemini empirical detection (presence of `kind` and `sessionId` on first line). If a version is newer than what the parser was tested against, log a warning but still attempt parse.

## Architecture target

After this plan ships, the data flow looks like:

```
                    Provider:    claude          codex           gemini
                                  │              │               │
src/main/supervisor/log-readers/  │              │               │
  ├── types.ts (ChatLogReader)    │              │               │
  ├── claude-jsonl-reader.ts ←────┘              │               │
  ├── codex-rollout-reader.ts ←──────────────────┘               │
  └── gemini-jsonl-reader.ts ←───────────────────────────────────┘
                  │
                  ▼
       SessionLogDispatcher  ← single facade, picks reader by agent.provider
                  │
                  ▼
    SessionEvent (shared/session-events.ts) ← provider-neutral event union
                  │
                  ▼
         supervisor.emit('chatEvents', batch)
                  │
                  ▼
      ChatPane (renderer)  ─→  ToolBlock (provider-aware registry)
                            ─→  ContextUsageBar (provider-aware adapter)
```

The shared `SessionEvent` type stays the same — it is already provider-neutral. Each new reader normalizes provider-specific records into the existing event union.

## File inventory

Files this plan touches (created / renamed / modified). Use this as the diff target for each phase's `git diff --stat`.

**New files:**
- `src/main/supervisor/log-readers/types.ts` — `ChatLogReader` interface + shared helpers
- `src/main/supervisor/log-readers/claude-jsonl-reader.ts` — extracted from `session-log-reader.ts`
- `src/main/supervisor/log-readers/codex-rollout-reader.ts`
- `src/main/supervisor/log-readers/gemini-jsonl-reader.ts`
- `src/main/supervisor/session-log-dispatcher.ts` — picks reader by provider
- `src/main/supervisor/session-id-discovery.ts` — pre/post-launch dir-snapshot helper (also used by future codex-resume)
- `src/renderer/components/detail/chat/blocks/codex/` — Codex-specific ToolBlock renderers
- `src/renderer/components/detail/chat/blocks/gemini/` — Gemini-specific ToolBlock renderers
- `src/renderer/components/detail/chat/usage-adapters.ts` — context-window math per provider
- Test fixtures under `src/main/supervisor/log-readers/__fixtures__/` (anonymized samples)

**Modified files:**
- `src/main/supervisor/session-log-reader.ts` — shrinks to a re-export of the dispatcher (Phase 1), then deleted (Phase 7)
- `src/main/supervisor/index.ts` — instantiates dispatcher; uses `session-id-discovery` at launch for codex/gemini
- `src/main/supervisor/context-stats-monitor.ts` — consumes `usage` events from any provider
- `src/main/supervisor/windows-runner.ts`, `wsl-runner.ts` — capture session-id post-launch (codex)
- `src/main/ipc-handlers.ts` — pipe synthetic-echo events through the same chat batch channel
- `src/renderer/components/detail/ChatInputBar.tsx` — fire synthetic echo on send for non-claude
- `src/renderer/components/detail/chat/blocks/ToolBlock.tsx` — provider-aware registry
- `src/renderer/components/detail/chat/ContextUsageBar.tsx` — use `usage-adapters`
- `src/shared/session-events.ts` — minor: add `provider?` discriminator for downstream filtering (optional)
- `src/shared/types.ts` — extend `Agent` with `chatLogPath?: string` if dispatcher needs to memoize resolved paths

---

## Phase 0 — Synthetic user-echo (~half day)

**Goal:** when the user sends a message to a Codex or Gemini agent from `ChatInputBar`, that message immediately appears in `ChatPane` as a `user-text` event, just like for Claude. This is independent of any reader work and unblocks the worst symptom ("I typed and nothing showed up").

This is the small win. Land it and ship; the rest of the plan can proceed at a slower pace.

### Files

- **MODIFY:** `src/main/supervisor/index.ts` — `_doSendInput` synthesizes a `UserTextEvent` and emits a `chatEvents` batch for non-Claude providers (Claude already gets it from the JSONL).
- **MODIFY:** `src/main/ipc-handlers.ts` — confirm the existing `agent:chat-events` channel forwards synthetic batches with no extra path needed.
- **NO CHANGES** to renderer required — `ChatPane` already consumes `user-text` events generically.

### Steps

1. In `src/main/supervisor/index.ts`, after the input has been successfully delivered (i.e. inside the `await tmuxSendInput(...)` / `winRunner.write(...)` success paths), construct a `UserTextEvent`:
   ```ts
   const synthetic: UserTextEvent = {
     type: 'user-text',
     uuid: `synthetic:${agentId}:${Date.now()}`,
     timestamp: new Date().toISOString(),
     agentId,
     text,
   };
   ```
   Only emit for `agent.provider === 'codex' || 'gemini'`. Claude already gets a real `user-text` from the JSONL tail; emitting both would duplicate the bubble.
2. Append the synthetic event to whatever in-memory ring buffer the dispatcher will eventually own. For Phase 0, route it through `sessionLogReader`'s public surface — add `appendSyntheticUserText(agentId, text)` if needed, since the existing `appendToRingBuffer` is private.
3. Emit a one-event `ChatEventBatch` so subscribers see it immediately.
4. Reconciliation note: when the **real** `user-text` event eventually lands (only relevant if a future reader for codex/gemini surfaces user messages), de-dupe by `(agentId, text)` within a 30-second window. Codex's rollout `event_msg/user_message` payload carries the same text we synthesized. For Phase 0 there is no real reader yet, so no reconciliation work needed — but leave a `// TODO(reconcile-synthetic)` comment at the dedupe site.

### Acceptance

- [ ] Send a message to a Codex agent from ChatPane → user bubble appears within 100ms.
- [ ] Send a message to a Gemini agent → same.
- [ ] Send a message to a Claude agent → still exactly one user bubble (no duplicate from synthetic + real).
- [ ] `npm run build` passes.
- [ ] Restart the dashboard with a Codex agent that received synthetic-only messages — synthetic bubbles do not persist (expected; they are not in the JSONL the reader will tail). Document this in the commit message.

### Commit

`multi-provider chat phase 0: synthetic user-echo for codex/gemini`

### STOP — confirm with human before Phase 1

---

## Phase 1 — Extract `ChatLogReader` interface and split out Claude reader (~1 day)

**Goal:** zero behavior change. `SessionLogReader` is split into a reader interface, a Claude implementation, and a dispatcher facade. All existing call sites keep working through the dispatcher.

### Files

- **CREATE:** `src/main/supervisor/log-readers/types.ts`:
  ```ts
  export interface ChatLogReaderSession {
    agentId: string;
    sessionId: string;
    workingDirectory: string;
    provider: AgentProvider;
  }
  export interface ChatLogReader {
    readonly provider: AgentProvider;
    pollSession(session: ChatLogReaderSession): SessionEvent[];
    invalidatePath(agentId: string): void;
    getCachedEvents(agentId: string, sinceUuid?: string): { events: SessionEvent[]; truncated: boolean };
    getFullToolResult?(agentId: string, toolUseId: string): Promise<string | null>;
  }
  ```
- **CREATE:** `src/main/supervisor/log-readers/claude-jsonl-reader.ts` — moves all path-resolution + parse logic out of `session-log-reader.ts`.
- **CREATE:** `src/main/supervisor/session-log-dispatcher.ts` — owns the master-tick loop, ring buffers per-agent (provider-agnostic), subscriber tracking. Routes `pollSession` calls to the reader matching `session.provider`.
- **MODIFY:** `src/main/supervisor/session-log-reader.ts` — slim to a re-export of `SessionLogDispatcher` so existing `import { SessionLogReader } from './session-log-reader'` continues to work.
- **MODIFY:** `src/main/supervisor/index.ts` — pass `provider` through `getActiveAgentSessions()`.
- **MODIFY:** `src/main/supervisor/context-stats-monitor.ts` — accept the dispatcher's reader-agnostic event stream.

### Steps

1. Create `log-readers/types.ts` with the interface and shared helpers (the `truncateForChat`, `appendToRingBuffer` patterns lifted to module-level utilities).
2. Move `parseEntry` + `flattenToolResultContent` + `resolveJsonlPath` + `makeSlug` + Windows/WSL projects-dir resolution into `claude-jsonl-reader.ts`. Class name `ClaudeJsonlReader implements ChatLogReader`.
3. Create `session-log-dispatcher.ts`. It holds:
   - `Map<AgentProvider, ChatLogReader>`
   - the master `setInterval` tick (1s)
   - per-agent ring buffer (existing `RING_BUFFER_MAX = 2000`)
   - subscriber set + `addChatSubscriber/removeChatSubscriber`
   - `getCachedEvents(agentId, sinceUuid)` — same signature as before
4. In `index.ts`, register only the Claude reader for now: `dispatcher.register(new ClaudeJsonlReader())`. Other providers fall through to a no-op reader (returns empty events) — Phase 0 synthetic echo stays alive because it does not depend on the dispatcher.
5. Reduce `session-log-reader.ts` to:
   ```ts
   export { SessionLogDispatcher as SessionLogReader } from './session-log-dispatcher';
   ```
6. Verify ChatPane still works for Claude end-to-end: open a Claude agent, see existing chat history, send a new message, confirm reply renders.
7. Add a fixture-based unit test for `ClaudeJsonlReader` using a real Claude JSONL captured from `~/.claude/projects/`. Anonymize cwd and any prompts; preserve the envelope.

### Acceptance

- [ ] Existing Claude chat behavior is byte-identical to before — diff-able by comparing `SessionEvent` arrays from the same JSONL pre/post-refactor.
- [ ] Codex/Gemini agents still receive synthetic user-echo from Phase 0.
- [ ] `npm run build` passes.
- [ ] No callers reference `SessionLogReader` internals other than via the public dispatcher surface.
- [ ] Unit test: parse a fixture Claude JSONL → expected `SessionEvent[]`.

### Commit

`multi-provider chat phase 1: extract ChatLogReader interface, split out Claude reader`

### STOP — confirm with human before Phase 2

---

## Phase 2 — Codex reader + session-id discovery (~2 days)

**Goal:** Codex agents render full chat history in ChatPane: user turns, assistant text, reasoning, tool calls + outputs. Context usage bar shows tokens used.

### Files

- **CREATE:** `src/main/supervisor/log-readers/codex-rollout-reader.ts`
- **CREATE:** `src/main/supervisor/session-id-discovery.ts` — pre/post-launch directory snapshot, returns the new rollout filename.
- **MODIFY:** `src/main/supervisor/windows-runner.ts`, `wsl-runner.ts` — invoke `session-id-discovery` around codex spawn; persist captured session id to `agent.resumeSessionId` via `updateAgent`.
- **MODIFY:** `src/main/supervisor/index.ts` — register `CodexRolloutReader` with the dispatcher.
- **CREATE:** `src/main/supervisor/log-readers/__fixtures__/codex-rollout-sample.jsonl` (anonymized).

### Steps

1. **Generate the official schema** locally for reference:
   ```bash
   codex app-server generate-json-schema --out ./tmp/codex-schemas
   ```
   Commit the resulting `RolloutLine.json` under `docs/codex-rollout-schema.json` so future maintainers have a frozen reference. (Do **not** generate this at build time — pin a snapshot.) Run on **codex-cli 0.128.x** (current pinned version) so the schema matches the binary the dashboard will tail against.
2. **Path resolution.** Codex sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. The session id is the *suffix* of the filename: `rollout-<ts>-<sessionId>.jsonl`. Resolution strategy:
   - If `agent.resumeSessionId` is set → glob `~/.codex/sessions/**/rollout-*-${sessionId}.jsonl` and pick the newest.
   - Both Windows host and WSL home need to be checked, mirroring the existing `windowsProjectsDir` / `wslProjectsUncDir` pattern in `claude-jsonl-reader.ts`.
3. **Session-id discovery at launch.** Codex does not accept `--session-id` (unlike Claude). `session-id-discovery.ts` exports:
   ```ts
   export async function snapshotCodexSessions(): Promise<Set<string>> { /* read all rollout-*.jsonl filenames */ }
   export async function discoverNewCodexSession(before: Set<string>, timeoutMs = 10_000): Promise<string | null> { /* poll until a new file appears, return its sessionId suffix */ }
   ```
   Wire into `windows-runner.ts` and `wsl-runner.ts` around the spawn:
   - Before spawn: `const before = await snapshotCodexSessions()`
   - After spawn: `discoverNewCodexSession(before)` runs in the background (Promise), updates `agent.resumeSessionId` when it resolves.
4. **Parser.** Each line is `{timestamp, type, payload}`. Map to `SessionEvent`:

   | Codex line | Field path | → SessionEvent |
   |---|---|---|
   | `event_msg / user_message` | `payload.message` | `user-text` |
   | `response_item / message` (role=`assistant`, content[].type=`output_text`) | `payload.content[].text` | `assistant-text` |
   | `response_item / reasoning` | `payload.summary[].text` (or `payload.content`) | `thinking` |
   | `response_item / function_call` | `payload.name`, `payload.arguments`, `payload.call_id` | `tool-use` (toolName, input parsed from JSON string, toolUseId=call_id) |
   | `response_item / function_call_output` | `payload.call_id`, `payload.output` | `tool-result` (toolUseId=call_id, content=output) |
   | `response_item / custom_tool_call` + `custom_tool_call_output` | same | same as function_call |
   | `event_msg / token_count` | `payload.input_tokens`, `payload.output_tokens`, `payload.cached_tokens`, `payload.total_tokens` | `usage` (see Phase 6 for usage-shape mapping) |
   | `event_msg / exec_command_end`, `patch_apply_end` | informational | drop OR fold into matching tool_result if call_id available |
   | `session_meta` | `payload.id`, `payload.cli_version`, `payload.cwd` | `system-init` (model = `payload.model_provider` + `payload.cli_version`) |
   | `turn_context`, `event_msg / task_started`, `task_complete`, `update`, `unknown` | — | drop |

   **Tool input shape:** `function_call.arguments` is a JSON-encoded string. Parse it; on parse failure, fall back to the raw string. ToolBlock will receive the parsed object or a string (handle both).

   **Tool result content:** `function_call_output.output` is sometimes a string, sometimes a structured object with `output` and `metadata`. The `flattenToolResultContent` helper from the Claude reader generalizes here — extend it to look for `.output` / `.text` / `.content[].text`.

5. **Tail mechanics.** Reuse the byte-offset bookkeeping pattern from `claude-jsonl-reader.ts`. Codex rollout files are append-only — same tailing approach works.
6. **Path invalidation.** When `agent.resumeSessionId` changes, call `dispatcher.invalidatePath(agentId)` — same hook used by Claude.
7. **Capture a fixture** from a real Codex session in `__fixtures__/codex-rollout-sample.jsonl`. Anonymize.
8. **Unit test:** parse fixture → expected `SessionEvent[]`.

### Caveats to guard against

- **Cli-version drift.** Pin tested-against version (today: `0.125.0` per the recon). On a new `session_meta` with a higher version, log a `[CodexRolloutReader] cli_version X newer than tested Y — proceeding` warning but still parse. Add a phase entry to retest schema when the user upgrades Codex.
- **Multi-line `output_text`.** Codex emits multiple `response_item / message` records per assistant turn (one per content block). Group consecutive `assistant-text` events with the same `turn_id` into one bubble in the renderer? **Recommendation: no — emit one event per block and let ChatPane render them adjacent.** Same approach Claude uses; multi-line text is a single block so this rarely matters.
- **`reasoning` confidentiality.** Codex's reasoning may include encrypted-content fields the model expects to round-trip. Parse only the `summary[].text` for display; ignore `encrypted_content`.
- **Path bridging.** Windows host and WSL each have their own `~/.codex/sessions/`. The same bridging logic from `ClaudeJsonlReader.resolveJsonlPath` (UNC `\\wsl.localhost\Ubuntu` paths) is the template. Extract that helper into `log-readers/types.ts` so both Claude and Codex readers share it.

### Acceptance

- [ ] Launch a fresh Codex agent → wait for first reply → `agent.resumeSessionId` populated within 10s, ChatPane shows user message + assistant reply + any tool use.
- [ ] Subsequent messages stream into ChatPane within 1-2s.
- [ ] Restart the agent (which uses the codex-resume TODO path; for Phase 2 acceptance, simulate by using `--resume` flag manually) → existing chat history loads.
- [ ] Tool calls appear via `GenericToolBlock` (provider-specific renderers come in Phase 3).
- [ ] `ContextUsageBar` shows model + token count for Codex sessions (full polish in Phase 6).
- [ ] No regression in Claude chat behavior.
- [ ] Phase-0 synthetic user-echo coexists cleanly: with a real Codex reader now emitting `user-text` from `event_msg/user_message`, the synthetic echo's dedupe window (`TODO(reconcile-synthetic)` from Phase 0) must be implemented. Within 30s of a synthetic event, drop any incoming `user-text` whose `text` matches.
- [ ] `npm run build` passes.
- [ ] Fixture-based unit test green.

### Commit

`multi-provider chat phase 2: Codex rollout reader + session-id discovery`

### STOP — confirm with human before Phase 3

---

## Phase 3 — Codex tool/usage rendering polish (~half day)

**Goal:** Codex tool calls render with the same visual quality as Claude tools — collapsible diffs for `apply_patch`, command/output pairing for `shell`, file path + result for `read_file`.

### Files

- **CREATE:** `src/renderer/components/detail/chat/blocks/codex/ShellToolBlock.tsx`
- **CREATE:** `src/renderer/components/detail/chat/blocks/codex/ApplyPatchToolBlock.tsx`
- **CREATE:** `src/renderer/components/detail/chat/blocks/codex/ReadFileToolBlock.tsx`
- **CREATE:** `src/renderer/components/detail/chat/blocks/codex/index.ts` — exports a `Record<string, FC<ToolBlockProps>>`
- **MODIFY:** `src/renderer/components/detail/chat/blocks/ToolBlock.tsx` — provider-aware registry
- **MODIFY:** `src/shared/session-events.ts` — add `provider?: AgentProvider` to `ToolUseEvent` so the renderer can pick the correct registry

### Steps

1. Extend `ToolUseEvent` with optional `provider` (defaults to `claude` for back-compat). The Codex reader populates it; the Claude reader can remain undefined and the registry treats undefined as `claude`.
2. Refactor `ToolBlock.tsx` to a two-level lookup:
   ```ts
   const REGISTRIES: Record<AgentProvider, Record<string, FC<ToolBlockProps>>> = {
     claude: { Edit, Write, Bash, Read, Grep, Glob, TodoWrite },
     codex:  { shell, apply_patch, read_file },
     gemini: { /* phase 5 */ },
   };
   const Component = REGISTRIES[props.provider ?? 'claude']?.[props.toolName] ?? GenericToolBlock;
   ```
3. **`ShellToolBlock`** — Codex's `shell` tool input shape is `{command: string[], workdir?: string}`. Render command joined with spaces, output as a `<pre>`. Mirror the existing Bash block.
4. **`ApplyPatchToolBlock`** — Codex's `apply_patch` input is a textual unified-diff envelope (`*** Begin Patch / *** End Patch`). Render as a collapsible diff using the same diff renderer used by `EditToolBlock`. If patch parsing fails, fall back to raw `<pre>`.
5. **`ReadFileToolBlock`** — input is `{path}`, output is the file contents. Mirror `ReadToolBlock`.

### Acceptance

- [ ] Run a Codex agent that exercises `shell`, `apply_patch`, `read_file` → each renders with provider-specific styling.
- [ ] An unknown Codex tool (e.g. `web_search`) falls through to `GenericToolBlock`.
- [ ] No regression on Claude tool rendering.
- [ ] `npm run build` passes.

### Commit

`multi-provider chat phase 3: Codex tool block renderers`

### STOP — confirm with human before Phase 4

---

## Phase 4 — Gemini reader + path resolution (~2 days)

**Goal:** Gemini agents render chat history in ChatPane. JSONL-only — legacy `.json` single-document sessions are skipped (see "Caveats" below).

### Phase 4 prerequisites — DO THESE FIRST (~1 hour)

This phase is currently **blocked on a research question** flagged in the Gemini CLI section above. On the May 2026 dev box, every Gemini session on disk is `.json`, not `.jsonl`. Before writing any reader code, answer:

1. **What makes Gemini emit `.jsonl` instead of `.json`?** Try in this order:
   - `gemini --output-format stream-json` (top-level CLI flag — captured in the help output but not yet exercised). Inspect what it writes to disk and whether it changes the chat-store format vs. just the stdout format.
   - Settings file: check `~/.gemini/settings.json` for any `chatStorageFormat` / `jsonlSessions` toggle. Cross-reference with the Gemini CLI source for `getProjectTempDir()` and the chat-recording code introduced in commit `f044b34`.
   - Version: confirm `0.40.1` actually does emit `.jsonl` somewhere. If the file format is gated behind a feature flag we have not enabled, plan to enable it.
2. **Capture a tool-using Gemini session** that exercises `read_file`, `write_file`, `replace`, and `run_shell_command`. The original recon never captured one — Phase 4 step 3's parser table is undefined for tool lines until this exists. Save the resulting file to `__fixtures__/gemini-session-sample.jsonl` (anonymized).
3. **Decide policy on legacy `.json`.** If the user has 23 existing legacy `.json` sessions and the JSONL toggle is opt-in or recent, the "skip with a warning" approach in step 5 means most of their existing Gemini work shows empty history. Two options:
   - Accept that legacy sessions render empty (current plan).
   - Write a one-shot legacy-`.json` parser path inside `GeminiJsonlReader` that handles the single-document format. More work, but covers existing user state. Decide here, not mid-Phase-4.

If question 1 has no answer (`stream-json` doesn't change disk format, no setting controls it, the f044b34 path is gated behind a flag we cannot turn on), Phase 4 should **stop and reroute to a stdout-tailing approach** (capture events from the gemini PTY directly) rather than file-tailing. That's a larger plan deviation; surface it before proceeding.

### Files

- **CREATE:** `src/main/supervisor/log-readers/gemini-jsonl-reader.ts`
- **CREATE:** `src/main/supervisor/log-readers/__fixtures__/gemini-session-sample.jsonl`
- **MODIFY:** `src/main/supervisor/session-id-discovery.ts` — extend with `snapshotGeminiSessions()` / `discoverNewGeminiSession()`
- **MODIFY:** `src/main/supervisor/windows-runner.ts`, `wsl-runner.ts` — capture session id at gemini launch
- **MODIFY:** `src/main/supervisor/index.ts` — register `GeminiJsonlReader`

### Steps

1. **Path resolution.** Gemini stores by *project hash*, not cwd slug:
   - The hash is SHA-256 of the absolute project root (per Gemini CLI `getProjectTempDir()` source). Pin the algorithm by reading the Gemini CLI source — link in research refs above.
   - Resolved dir: `~/.gemini/tmp/<sha256(cwd)>/chats/`.
   - Files: `session-<ISO-ts>-<8charHex>.jsonl` (newer) or `.json` (older — skip).
   - When `agent.resumeSessionId` is set, the trailing 8-char hex maps to it. Glob `chats/session-*-${shortId}.jsonl`.
2. **Session-id discovery at launch.** Gemini also mints its own session id. Same snapshot/diff approach as Codex — implement in `session-id-discovery.ts`.
3. **Defensive parsing.** Schema is undocumented. Parse leniently:
   - First line is **session metadata**: `{sessionId, projectHash, startTime, lastUpdated, kind}` — emit as `system-init`.
   - Subsequent lines whose first key is `$set` (`{$set: {lastUpdated: ...}}`) are partial-update mutators — **drop**.
   - Lines with `type: "user"` and `content: [{text}]` → `user-text`.
   - Lines with `type: "gemini"` and `content: string` → `assistant-text`.
   - Lines with `type: "gemini"` and a `thoughts` array → also emit one `thinking` event per thought entry (`{subject, description, timestamp}`).  Concatenate `subject + ": " + description` for the thinking text.
   - Lines with `type: "info"` → `system-init` with the info payload appended (or a new system-text variant — see Phase 6 cleanup).
   - Lines with `type: "tool_call"` / `tool_response` (or whatever shape Gemini settled on; verify against a tool-using session) → `tool-use` / `tool-result`. **The recon did not capture a tool-using Gemini session — Phase 4 must include such a capture and update this row of the table accordingly. If unknown tool shape is encountered, drop with a `[GeminiJsonlReader] unknown line type X` warning.**
   - Lines with a `tokens` field on `type: "gemini"` → emit a `usage` event. Token shape: `{input, output, cached, thoughts, tool, total}`.
4. **Tail mechanics.** Same byte-offset approach as Codex/Claude — Gemini JSONL is append-only.
5. **Legacy `.json` handling.** If the only file matching the resume id is a `.json` (not `.jsonl`), log a one-time warning per agent: `[GeminiJsonlReader] legacy .json session, chat history not available — agent will work, history will not render`. Do not attempt to parse the single-document format. The Gemini team is migrating; the dashboard should not become a maintainer of the legacy format.
6. **Capture a fixture** that exercises tool calls (run a Gemini agent that uses `read_file`, `replace`, etc.). Update the parser table in step 3 with the actual tool-line shape observed.

### Caveats

- **Schema instability.** Gemini's JSONL recording landed in `f044b34`. Expect breakage on Gemini CLI upgrades. Add a `[GeminiJsonlReader]` log line on every unknown `type` value so regressions are visible.
- **Project hash collisions.** SHA-256 is collision-resistant; not a real concern. Worth noting only if path resolution fails.
- **Multi-cwd same-project.** If the user runs Gemini from `/repo` once and `/repo/subdir` once, they hash differently. The Agent's `workingDirectory` is the source of truth.

### Acceptance

- [ ] Launch a fresh Gemini agent → first reply renders within 2s.
- [ ] Reasoning ("thoughts") appear as italic dimmed text via existing `ThinkingNote`.
- [ ] Tool calls render via `GenericToolBlock` (Gemini-specific renderers come in Phase 5).
- [ ] Restart agent → chat history reloads if the resume session is JSONL; logs warning + empty history if legacy `.json`.
- [ ] No regression on Claude or Codex.
- [ ] Phase-0 synthetic dedupe window now applies to Gemini too.
- [ ] `npm run build` passes.
- [ ] Fixture-based unit test green.

### Commit

`multi-provider chat phase 4: Gemini JSONL reader`

### STOP — confirm with human before Phase 5

---

## Phase 5 — Gemini tool/usage rendering polish (~half day)

**Goal:** Gemini tool calls render with provider-specific styling.

### Files

- **CREATE:** `src/renderer/components/detail/chat/blocks/gemini/{ReadFileToolBlock,ReplaceToolBlock,WriteFileToolBlock,ShellToolBlock,index}.tsx`
- **MODIFY:** `src/renderer/components/detail/chat/blocks/ToolBlock.tsx` — populate `REGISTRIES.gemini`

### Steps

1. From the fixture captured in Phase 4, enumerate the tool names Gemini emits. Common ones (per Gemini CLI source): `read_file`, `write_file`, `replace`, `run_shell_command`, `list_directory`, `glob`, `search_file_content`, `web_fetch`, `save_memory`.
2. Implement renderers for the top ~5 tools (read_file, write_file, replace, run_shell_command, list_directory). Others fall through to `GenericToolBlock`.
3. **`ReplaceToolBlock`** is the analogue of Claude's `EditToolBlock` — render the diff between `old_string` and `new_string`.

### Acceptance

- [ ] Run a Gemini agent that uses each top-5 tool → each renders with provider-specific styling.
- [ ] Unknown tools fall through to `GenericToolBlock`.
- [ ] `npm run build` passes.

### Commit

`multi-provider chat phase 5: Gemini tool block renderers`

### STOP — confirm with human before Phase 6

---

## Phase 6 — Provider-aware context usage (~half day)

**Goal:** `ContextUsageBar` shows accurate "X / Y tokens, Z%" for all three providers, with per-provider caveats noted in the UI.

### Files

- **CREATE:** `src/renderer/components/detail/chat/usage-adapters.ts` — exports `computeUsage(usage: UsageEvent): { displayText, percentage, color }` keyed by provider.
- **MODIFY:** `src/main/supervisor/context-stats-monitor.ts` — already provider-agnostic if it consumes the dispatcher's `usage` events. Verify and extend.
- **MODIFY:** `src/renderer/components/detail/chat/ContextUsageBar.tsx` — delegate to `usage-adapters`.
- **MODIFY:** `src/shared/session-events.ts` — extend `UsageEvent` to carry provider plus optional provider-specific fields:
  ```ts
  export interface UsageEvent extends BaseEvent {
    type: 'usage';
    provider: AgentProvider;
    sessionId: string;
    model: string;
    contextWindowMax: number;
    cumulativeContextTokens: number;
    contextPercentage: number;
    // Provider-specific (all optional):
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;  // Anthropic
    cacheReadTokens?: number;      // Anthropic
    cachedTokens?: number;          // Codex / Gemini
    thoughtsTokens?: number;        // Gemini
    toolTokens?: number;            // Gemini
    totalTokens?: number;
  }
  ```
- **MODIFY:** Each reader's `usage` emit path to populate the new fields.

### Steps

1. **Claude (existing):** keep cumulative = input + cache_creation + cache_read + output; that already matches Anthropic's billing model. Display: `model · cumulative/window · pct%`.
2. **Codex:** `event_msg / token_count` payload exposes `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`. Cumulative = `total_tokens` if present, else `input + output`. Context window: pull from **`event_msg/task_started.payload.model_context_window`** (e.g. 258400 in the May 2026 sample). The earlier draft of this doc said `session_meta.payload.model_context_window`; that field is **absent** in real 0.125+ rollout `session_meta` payloads — it lives on `task_started`. Fall back to the existing `getContextWindowForModel` lookup using `model_provider + model` as the key. Add Codex models to `src/shared/constants.ts`'s context window map.
3. **Gemini:** per-message `tokens.{input,output,cached,thoughts,tool,total}`. Cumulative = `tokens.total`. Context window: hardcode per-model (1M for `gemini-2.5-pro`, 1M for `gemini-3-flash-preview`, etc.) in `constants.ts`. Add a `[ContextUsageBar] gemini context-window unknown for model X — defaulting to 1M` warning when an unrecognized model appears.
4. UI tweak: show provider name as a small label next to the model name when provider !== 'claude'. Helps the user remember which provider's token semantics they are looking at (cache split for Claude vs no cache split for Codex/Gemini).
5. **`context-stats-monitor.ts`** sanity check: it stores the latest usage per agent and feeds the IPC channel `agent:context-stats-changed`. Confirm it does not assume Anthropic-shaped fields anywhere; if it does, fix.

### Acceptance

- [ ] Claude usage bar identical to before this plan.
- [ ] Codex usage bar shows tokens used out of `model_context_window`, percent-correct.
- [ ] Gemini usage bar shows tokens out of hardcoded window, with the warning logged for unknown models.
- [ ] `npm run build` passes.

### Commit

`multi-provider chat phase 6: provider-aware context usage`

### STOP — confirm with human before Phase 7

---

## Phase 7 — Cleanup, parity matrix, regression sweep (~half day)

**Goal:** delete the legacy compatibility shim, freeze a parity matrix in the doc, sweep for regressions.

### Files

- **DELETE:** `src/main/supervisor/session-log-reader.ts` (the shim from Phase 1).
- **MODIFY:** all callers `import { SessionLogReader }` → `import { SessionLogDispatcher }` (or whatever the public name is). Plain rename.
- **MODIFY:** this file (`MULTI_PROVIDER_CHAT_RENDERING.md`) — fill in the parity matrix below with observed-good ✅ marks for each cell at the end of the run.
- **MODIFY:** `CLAUDE.md` — note that ChatPane is now provider-aware and point future agents at this doc.

### Parity matrix (fill in at end)

| Capability | Claude | Codex | Gemini |
|---|:-:|:-:|:-:|
| User text bubble | ☐ | ☐ | ☐ |
| Assistant text bubble | ☐ | ☐ | ☐ |
| Reasoning / thinking | ☐ | ☐ | ☐ |
| Tool call (generic block) | ☐ | ☐ | ☐ |
| Tool call (provider-specific block) | ☐ | ☐ | ☐ |
| Tool result | ☐ | ☐ | ☐ |
| Context usage bar | ☐ | ☐ | ☐ |
| Resume / history reload | ☐ | ☐ | ☐ |
| Synthetic echo dedupe | n/a | ☐ | ☐ |

### Regression sweep

- [ ] Spawn one of each provider. Send 10 messages each. Confirm chat surfaces match `read_agent_log` ground truth.
- [ ] Restart all three agents. Confirm chat history reloads where expected.
- [ ] Run `npm run build` clean.
- [ ] Run any existing unit tests.

### Commit

`multi-provider chat phase 7: cleanup + parity matrix`

---

## Schemas — frozen reference (transcribed during recon)

### Codex `RolloutLine` (one JSON object per line)

```jsonc
{
  "timestamp": "ISO-8601",
  "type": "session_meta" | "event_msg" | "response_item" | "turn_context",
  "payload": { /* shape depends on type, see below */ }
}
```

**`session_meta` payload** (first line of every rollout):
```jsonc
{
  "id": "uuid",                  // session id (matches filename suffix)
  "timestamp": "ISO-8601",
  "cwd": "absolute path",
  "originator": "codex-tui" | "codex-app-server" | ...,
  "cli_version": "0.125.0",      // (or whichever pinned version wrote the file)
  "source": "cli",
  "model_provider": "openai",
  "base_instructions": { "text": "..." }
  // NOTE: model_context_window is NOT here — see task_started below.
}
```

**`event_msg` payload** (subtype in `payload.type`):
```jsonc
// task lifecycle — NOTE: model_context_window lives here, not on session_meta
{ "type": "task_started", "turn_id": "...", "started_at": 1700000000, "model_context_window": 258400, "collaboration_mode_kind": "default" }
{ "type": "task_complete", "turn_id": "...", ... }
// user text turn
{ "type": "user_message", "message": "hello" }
// assistant text turn (sometimes; usually inside response_item/message instead)
{ "type": "agent_message", "message": "hi" }
// command execution result
{ "type": "exec_command_end", "call_id": "...", "stdout": "...", "stderr": "...", "exit_code": 0 }
{ "type": "patch_apply_end",  "call_id": "...", "success": true, ... }
// usage
{ "type": "token_count", "input_tokens": 12345, "output_tokens": 678, "cached_tokens": 9, "total_tokens": 13032 }
```

**`response_item` payload** (subtype in `payload.type`):
```jsonc
// assistant text
{ "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "..."}] }
// developer/system input echo
{ "type": "message", "role": "developer", "content": [{"type": "input_text", "text": "..."}] }
// reasoning (thinking)
{ "type": "reasoning", "summary": [{"type": "summary_text", "text": "..."}], "encrypted_content": "..." }
// tool call
{ "type": "function_call", "call_id": "...", "name": "shell", "arguments": "{\"command\": [\"ls\"]}" }
// tool result
{ "type": "function_call_output", "call_id": "...", "output": "..." }
// custom (MCP) tool call
{ "type": "custom_tool_call", "call_id": "...", "name": "...", "input": {...} }
{ "type": "custom_tool_call_output", "call_id": "...", "output": ... }
```

Generate the canonical JSON Schema with `codex app-server generate-json-schema --out ./schemas` (note: `generate-json-schema`, not `generate-internal-json-schema`). Commit `RolloutLine.json` to the repo as `docs/codex-rollout-schema.json` so future agents have a frozen reference.

### Gemini JSONL session (empirical — schema **not** officially documented)

```jsonc
// First line: session metadata
{ "sessionId": "uuid", "projectHash": "sha256", "startTime": "ISO-8601", "lastUpdated": "ISO-8601", "kind": "main" }
// User turn
{ "id": "uuid", "timestamp": "ISO-8601", "type": "user", "content": [{"text": "..."}] }
// Model turn (assistant)
{
  "id": "uuid", "timestamp": "ISO-8601", "type": "gemini",
  "content": "assistant text",
  "thoughts": [{"subject": "...", "description": "...", "timestamp": "ISO-8601"}],
  "tokens": { "input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0 },
  "model": "gemini-3-flash-preview"
}
// Partial update — drop
{ "$set": { "lastUpdated": "ISO-8601" } }
// Info line
{ "id": "uuid", "timestamp": "ISO-8601", "type": "info", "content": "..." }
// Tool call / response — SHAPE NOT YET CAPTURED IN RECON
// Phase 4 must capture this from a tool-using session and update this section.
```

Source: empirical sample from `~/.gemini/tmp/agentdashboard/chats/session-2026-04-29T22-07-0de3c545.jsonl`, cross-referenced with [`gemini-cli#15292`](https://github.com/google-gemini/gemini-cli/issues/15292) and the f044b34 commit.

Watch for schema drift on every Gemini CLI upgrade. Do **not** depend on undocumented fields — restrict parsing to the fields above.

---

## Open questions / followups (not blocking this plan)

- **Codex resume.** The session-id discovery code from Phase 2 unblocks the existing `TODO(codex-resume)` at `src/main/supervisor/index.ts:1021-1026`. Worth a follow-up PR after Phase 2 lands. Confirmed shape: `codex resume <uuid>` is a subcommand (verified via `codex resume --help` on 0.128.0), takes the UUID positionally, falls back to `--last`. Codex does **not** accept any pre-launch session-id flag, so post-launch dir-snapshot/diff is the only way to capture the UUID.
- **Gemini resume is currently broken.** `index.ts:1016, 1122` append bare `--resume` (no value), which the current Gemini CLI 0.40.x help string says requires `"latest"` or an index. Quickest fix: change to `--resume latest`. Proper fix: capture the session id at launch (snapshot/diff `~/.gemini/tmp/<projectHash>/chats/`), then on resume call `gemini --list-sessions`, look up our session id, pass `--resume <index>`. This is independent of chat rendering but the snapshot/diff helper from Phase 4 (or Phase 2 generalized) can be reused. Either land the one-line `--resume latest` workaround first, or fold the proper fix into a follow-up after the multi-provider plan ships.
- **Inter-agent query** (`agent:query` IPC, `claude -p` only) — non-Claude support is a separate question. Out of scope here; this plan only covers chat *rendering*.
- **`agent.fork`** is also Claude-only and uses the JSONL forking mechanism. Not in scope.
- **Legacy Gemini `.json` migration.** If the user has many legacy single-document sessions they want to render, write a one-shot script that converts them to JSONL and emits a Phase-4-compatible file. Defer until requested.
- **Tool result truncation thresholds.** Currently `TOOL_RESULT_TRUNCATE_BYTES = 20_000`. Codex and Gemini sometimes emit much larger outputs (esp. shell `cat` of big files). The "Show full output" affordance via `getFullToolResult` should work for the new readers — verify in Phase 2 / Phase 4 acceptance.
- **Provider migration in Agent settings.** If a user changes an agent's provider mid-life (unusual but possible via template editing), the resume id from one provider is meaningless to another. Add a guard in `index.ts` that nulls `resumeSessionId` on provider change.

---

## Glossary

- **Rollout** — Codex's term for a session log file. Synonymous with "session" in this doc.
- **Project hash** — Gemini's SHA-256 of the project root, used to namespace per-project session storage.
- **Session id discovery** — the snapshot/diff trick used when a CLI mints its own session id at launch and does not surface it to the parent process.
- **`SessionEvent`** — the dashboard's provider-neutral event union in `src/shared/session-events.ts`. Every reader normalizes its provider's records into this union.
- **`ChatLogReader`** — the per-provider reader interface introduced in Phase 1.
- **Synthetic echo** — an in-memory `user-text` event the supervisor emits the moment a message is dispatched, so the user sees their own bubble without waiting for the on-disk log.
