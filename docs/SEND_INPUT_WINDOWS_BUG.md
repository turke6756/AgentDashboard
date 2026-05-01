# Bug: `send_message_to_agent` on Windows lands in input box but never submits — RESOLVED 2026-04-29

*Originally written 2026-04-29 as a handoff. Updated later that day with the final fix covering all three providers.*

## Final resolution (2026-04-29)

All three providers now submit on Windows, single-line and multi-line:

- **Claude (Windows)**: `formatBracketedPaste(text)` + delayed `\r` (Attempt 4 above).
- **Codex (Windows)**: char-by-char typing at 8ms intervals (defeats codex's paste-detect heuristic) + Win32 Input Mode VK_RETURN down/up CSI key event for submit.
- **Gemini (Windows)**: same path as codex.
- **Multi-line for codex/gemini**: each embedded `\n` becomes a Win32 Shift+Enter CSI sequence (newline-without-submit) so the final plain Enter still triggers submit instead of inserting another line in the multi-line input mode.

Final dispatch in `Supervisor.sendInput()` Windows branch (`src/main/supervisor/index.ts:1503-1535`):

```ts
if (agent?.provider === 'claude') {
  winRunner.write(formatBracketedPaste(text));
  await delay(WINDOWS_SEND_INPUT_ENTER_DELAY_MS);
  winRunner.write('\r');
} else if (agent?.provider === 'codex' || agent?.provider === 'gemini') {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const ch of normalized) {
    if (ch === '\n') {
      winRunner.write(WIN32_KEY_SHIFT_ENTER_DOWN + WIN32_KEY_SHIFT_ENTER_UP);
    } else {
      winRunner.write(ch);
    }
    await delay(WINDOWS_CODEX_TYPING_DELAY_MS);
  }
  await delay(WINDOWS_SEND_INPUT_ENTER_DELAY_MS);
  winRunner.write(WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP);
} else {
  winRunner.write(`${text}\r`);
}
```

Win32 key event format: `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`. Constants: `WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_'`, `..._UP = '\x1b[13;28;13;0;0;1_'`. Shift variants use Cs=16. See [`docs/CODEX_INPUT_HANDOFF.md`](./CODEX_INPUT_HANDOFF.md) for the longer derivation.

WSL parity is **not** addressed by this fix. WSL submits via `tmux send-keys -l <text> \; send-keys Enter`; codex/gemini and (newly observed) multi-line claude on WSL all fail to submit. Tracked in [`docs/SEND_INPUT_WSL_BUG.md`](./SEND_INPUT_WSL_BUG.md).

## Original handoff (preserved below)


## Symptom

When the dashboard's `send_message_to_agent` MCP tool (or any caller of `Supervisor.sendInput()`) targets a **Windows** agent (i.e., `WindowsRunner`), the message text reliably appears in the agent's Claude Code input prompt but is **never submitted** — Claude Code stays in `idle` and the message just sits there as typed-but-not-sent text. The HTTP / MCP layer reports success.

This is the same class of bug the WSL side hit and patched (see the explanatory comment at `src/main/wsl-bridge.ts:99-108`). The WSL fix was: chain the literal-text send and the Enter into a single `tmux send-keys -l <text> \; send-keys Enter` invocation. Windows doesn't go through tmux; it writes directly to a node-pty PTY.

## Reproduction

1. Launch the AgentDashboard (`npm run build && npm run start`).
2. Launch a Claude supervisor agent in the AgentDashboard workspace via the UI. Wait until status `idle`.
3. From a separate Claude Code session connected to the same dashboard MCP server, call:
   ```
   mcp__agent-dashboard__send_message_to_agent({
     agent_id: "<supervisor-id>",
     message: "Run the orchestration spike — read .claude/agents/supervisor/skills/orchestration-spike.md and execute it."
   })
   ```
4. The MCP wrapper returns `Message sent to agent ...`. The supervisor's `status` stays `idle` indefinitely. Visually, the text appears in the input prompt with the cursor parked on it. The dashboard log shows `ctrl+g to edit in Notepad.exe` hint, indicating the input buffer is non-empty.

## Code path

Windows send chain:

1. HTTP route `POST /api/agents/:id/input` — `src/main/api-server.ts:133-153`
2. `Supervisor.sendInput(agentId, text)` — `src/main/supervisor/index.ts:1459-1481`
3. For Windows agents, this calls `winRunner.write(text + '\r')` (original) → JSON-RPC to `pty-host.js`
4. `WindowsRunner.write()` — `src/main/supervisor/windows-runner.ts:205-207` — sends `{ type: 'write', data }` over stdin
5. `pty-host.js:88-93` — `case 'write': ptyProcess.write(msg.data)` — node-pty PTY write

So the actual bytes hitting Claude Code's TTY in the original code are: `<message text>\r`.

## What I tried (in order)

### Attempt 1 — original: `text + '\r'` as one PTY write
**Result:** Text appears in input box, no submit. Supervisor status: `idle` → `idle` (no work performed). Verified visually by the user and via `read_agent_log` — the TUI input area shows the message with cursor.

### Attempt 2 — `text + '\n'` as one PTY write
Edit at `src/main/supervisor/index.ts:1478`. Rebuilt main, killed all Electron processes, restarted.
**Result:** Identical failure. Text appears in input box, no submit. The `[?2004h` (bracketed paste enable) sequence is visible in the supervisor terminal log, confirming Claude Code v2.1.123 has bracketed paste mode active.

### Attempt 3 — split into two PTY writes with 80ms delay
Edit at `src/main/supervisor/index.ts:1475-1485`:
```ts
winRunner.write(text);
await new Promise((resolve) => setTimeout(resolve, 80));
winRunner.write('\r');
```
Rebuilt main, killed Electron, restarted. **Not yet tested** — fresh supervisor was still in `working` (launching) state; user interrupted before the send was triggered. **This is where to resume.** It's possible the split write either fixes it or produces a yet-different failure mode.

### Attempt 4 - bracketed paste body, delayed Enter
Implemented in `src/main/supervisor/index.ts` on 2026-04-29:
```ts
winRunner.write(formatBracketedPaste(text));
await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
winRunner.write('\r');
```
`formatBracketedPaste()` normalizes line endings, strips nested bracketed-paste boundary markers, and wraps the body in `\x1b[200~...\x1b[201~` before Enter is sent as a separate PTY write.

Build verification passed with `npm run build:main`.

Runtime verification passed on 2026-04-29 against a fresh Windows Claude Code agent (`71db53b2-58c1-44c0-98f5-9ac12848a67e`) via `POST /api/agents/:id/input` with `Reply with exactly: WINDOWS_SEND_INPUT_TEST_OK`. The log showed the prompt submitted, Claude entered `Working...`, and the agent replied `WINDOWS_SEND_INPUT_TEST_OK`.

End-to-end MCP verification also passed on 2026-04-29: `mcp__agent-dashboard__send_message_to_agent` against a fresh Claude supervisor (`3f415a66-...`) flipped status `idle → working` immediately and the supervisor ran the orchestration-spike skill end-to-end through Phase E. Spike test details in [`CorePrimatives_EdTurk_042826.md` § "First Spike Test Run — 2026-04-29"](./CorePrimatives_EdTurk_042826.md).

## Regression: Attempt 4 breaks codex agents

The bracketed-paste fix above is **Claude-Code-specific**. It was discovered during the spike test (above) that codex agents on Windows now hang in a paste-confirmation state instead of submitting.

Beta planner (`d8fed708-...`, provider=codex / gpt-5.5 CLI) received the planner prompt during the spike. Its terminal log shows:

```
›  [Pasted Content 1019 chars]
   Save and close external editor to continue.
```

Codex detects `\x1b[200~...\x1b[201~`, treats the body as a paste, stashes it as a `[Pasted Content N chars]` placeholder, and opens an **external editor** waiting for save+close. The subsequent `\r` does nothing because codex is no longer at its input prompt — it's at "Save and close external editor to continue." Codex never submits and stays in this state until killed.

Before Attempt 4, codex worked: plain `text + '\r'` was received as typed input and submitted. The fix that unblocks Claude simultaneously breaks codex.

### Follow-up fix: provider-aware dispatch

Implemented on 2026-04-29 in `Supervisor.sendInput()`.

In `Supervisor.sendInput()`, branch on the agent's provider:

```ts
const agent = getAgent(agentId);
const winRunner = this.windowsRunners.get(agentId);
if (winRunner) {
  if (agent?.provider === 'claude') {
    // Claude Code v2.x — needs bracketed paste body + delayed \r
    winRunner.write(formatBracketedPaste(text));
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
    winRunner.write('\r');
  } else {
    // codex (and default for unknown providers) — bracketed paste opens an
    // external-editor confirmation flow we can't drive from here. Plain text
    // + Enter works for codex's pre-bracketed-paste typed-input path.
    winRunner.write(text + '\r');
  }
  return;
}
```

`gemini` is untested in this codebase right now; safest default is the codex path until we verify.

The provider field is already populated on the agent record (visible in `list_agents` output as `"provider": "claude" | "codex" | "gemini"`), so the branch is cheap.

### What needs to be tested after the provider-aware patch

- **Claude regression.** Re-run the orchestration-spike or the standalone smoke test (`POST /api/agents/:id/input` with `WINDOWS_SEND_INPUT_TEST_OK`) against a fresh Claude agent. Status must go `idle → working`, agent must submit.
- **Codex unblock.** Launch a fresh codex agent. Send a simple prompt via `send_message_to_agent`. Confirm status flips to `working` (codex doesn't expose `working` cleanly — verify by checking that the prompt is submitted via terminal log).
- **Spike Phase C again.** With codex unblocked, the planner consensus exchange may actually produce a `CONSENSUS` token in Beta's reply this time. Worth re-running the full spike to confirm.

## Hypotheses for root cause (untested)

1. **Bracketed paste interaction.** Claude Code v2.1.123 emits `\x1b[?2004h` (bracketed paste enable). Some Ink/raw-mode TUIs only treat `\r` / `\n` as Enter when received as a *separate* keypress event tick — not when they arrive as the trailing byte of a larger chunk that the input loop treats as a paste. This is the leading hypothesis. Attempt 3 directly tests it.
2. **ConPTY line-discipline rewriting.** Windows ConPTY (which node-pty uses on Win10+) sometimes mangles `\r` / `\n` in the input stream depending on how the PTY was opened. Worth checking node-pty options in `scripts/pty-host.js` and whether ConPTY `disableConpty: false` is set.
3. **Bracketed-paste-aware input.** Claude Code may deliberately wrap incoming bytes in `\x1b[200~ ... \x1b[201~` (bracketed paste protocol) before treating them as input, treating any trailing newline inside the bracket as part of the paste content rather than a submit. If so, the fix is: send the body as a paste, exit bracketed paste mode, then send a separate Enter — i.e., write `\x1b[200~<text>\x1b[201~` then tick, then `\r`.
4. **Race / timing.** The PTY write completes before Claude Code's render loop has consumed the body, so the `\r` is processed against an empty input buffer (no submit) and the body lands a tick later. Attempt 3 also addresses this.

## Files referenced

- `src/main/supervisor/index.ts:1452-1481` — `writeToAgent` and `sendInput`
- `src/main/supervisor/windows-runner.ts:205-207` — `write()` JSON-RPC to pty-host
- `scripts/pty-host.js:88-93` — node-pty `write` handler
- `src/main/wsl-bridge.ts:99-112` — the WSL counterpart with the explanatory comment about the same symptom on the other path
- `src/main/api-server.ts:133-153` — HTTP route

## Suggested next steps for a fresh agent

1. **Optional MCP smoke test.** The HTTP path is verified. A final end-to-end MCP test can call `mcp__agent-dashboard__send_message_to_agent` against a fresh idle Windows agent.
2. **If MCP still fails:** inspect the MCP wrapper/proxy layer; the underlying `Supervisor.sendInput()` Windows path is now known to submit successfully through HTTP.
3. **Check the WSL fix's spirit.** WSL solved this by guaranteeing the body and Enter arrive in the same "transaction" (single tmux invocation). On Windows we don't have that primitive, but a node-pty equivalent is to write the full sequence (body + bracketed-paste end + Enter) as one buffer. If the issue is bracketed paste, this might still fail; if the issue is timing, this should work.
5. **Once fixed:** add a regression test that sends a message via `Supervisor.sendInput()` to a Windows-spawned agent and asserts the agent transitions out of `idle`. Currently nothing guards this — the WSL fix only landed because someone hit the symptom in real use.

## What's NOT the bug

- Not the MCP wrapper (`scripts/mcp-supervisor.js:555-558`) — it's a thin proxy over the HTTP route.
- Not the HTTP route (`api-server.ts:133-153`) — validation passes, `sendInput` is called with the right text.
- Not `agent.status === 'working'` rejection — the supervisor was confirmed `idle` before each attempt; the route returned 200 OK.
- Not a queueing issue — `supervisorQueuedEvents` is for events delivered to a busy supervisor, but the supervisor was idle.

## Context for the larger task

This bug surfaced while trying to test the orchestration spike (`scripts/orchestration-spike.js`, skill at `.claude/agents/supervisor/skills/orchestration-spike.md`). The intended flow is: caller (a separate Claude Code session) sends the supervisor a "Run the orchestration spike" message via MCP → supervisor reads the skill markdown → supervisor launches the detached Node script → script orchestrates planner agents and a worker fork. The bug blocks step 1, so we never reach the spike's actual logic. Once `sendInput` is fixed on Windows, resume the spike test from `docs/CorePrimatives_EdTurk_042826.md` § "Implemented Orchestration Spike — 2026-04-29".
