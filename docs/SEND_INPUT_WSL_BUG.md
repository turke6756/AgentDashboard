# `sendInput` on WSL — RESOLVED 2026-04-29

*Originally written 2026-04-29 as a handoff. Resolved later the same day after research confirmed all three providers enable kitty keyboard protocol (CSI-u) on Linux.*

The Windows-side fix is complete and documented in [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md) and [`docs/CODEX_INPUT_HANDOFF.md`](./CODEX_INPUT_HANDOFF.md). The WSL bug is the same class of "text rendered, Enter doesn't submit" with a different transport (tmux instead of node-pty/ConPTY).

## Final state (2026-04-29)

| Provider | WSL single-line | WSL multi-line |
|----------|-----------------|----------------|
| claude   | ✅ | ✅ |
| codex    | ✅ | ✅ |
| gemini   | ✅ | ✅ |

Verified by sending one single-line and one three-line message to fresh agents in workspace `bbf8af5c-179f-48b0-b61e-9e00b98cb100`:

- WSL claude `27c55a0e-9f27-4556-904f-b8cc1e535f78` → `WSL_CLAUDE_SINGLE_LINE_OK`, `WSL_CLAUDE_MULTI_LINE_OK`
- WSL codex `afbc5ec4-6314-4e87-8963-e9bd81813343` → `WSL_CODEX_SINGLE_LINE_OK`, `WSL_CODEX_MULTI_LINE_OK`
- WSL gemini `9fee00a3-b4f9-4d6e-b3e4-8e747dac9d09` → `WSL_GEMINI_SINGLE_LINE_OK`, `WSL_GEMINI_MULTI_LINE_OK`

## Resolution

All three Linux CLIs (claude, codex, gemini) enable the kitty keyboard progressive enhancement protocol at startup. In that mode, a bare `\r` byte (what `tmux send-keys Enter` emits) is dropped — submit must arrive as the kitty CSI key event `\x1b[13u`.

`tmuxSendInput()` in `src/main/wsl-bridge.ts` now branches by provider:

- **claude**: wrap the body in bracketed-paste markers (`\x1b[200~ ... \x1b[201~`) so embedded `\n`s render as a real paste without entering paste-confirmation, sleep 80 ms, then send kitty Enter (`\x1b[13u`).
- **codex / gemini**: send each line literal via `tmux send-keys -l`, encode each embedded `\n` as kitty Shift+Enter (`\x1b[13;2u`) — these CLIs treat the body as typed input rather than a paste, so bracketed paste would open codex's external-editor confirmation flow as it does on Windows. Sleep 80 ms (well past codex's 8 ms `PasteBurst` window and gemini's 30 ms `bufferFastReturn` window) before sending kitty Enter for submit.
- **unknown provider**: keep the legacy `tmux send-keys -l <text> \; send-keys Enter` path.

Hex byte sequences sent via `tmux send-keys -H`:

| Key | Bytes |
|---|---|
| Plain Enter (submit) | `1b 5b 31 33 75` (= `\x1b[13u`) |
| Shift+Enter (newline insert) | `1b 5b 31 33 3b 32 75` (= `\x1b[13;2u`) |
| Bracketed-paste start | `1b 5b 32 30 30 7e` (= `\x1b[200~`) |
| Bracketed-paste end | `1b 5b 32 30 31 7e` (= `\x1b[201~`) |

`Supervisor.sendInput` (`src/main/supervisor/index.ts`) WSL branch dispatches by `agent.provider` into `tmuxSendInput(name, text, provider)`.

### Side fixes shipped with this work

- **Provider-launch bug at `src/main/supervisor/index.ts:509`** — workspaces whose `defaultCommand` was the WSL framework default silently dropped the `provider` override at launch (the comparison only matched `DEFAULT_COMMAND`, not `DEFAULT_COMMAND_WSL`). Now compares against both, so `provider: "codex" | "gemini"` is honored on WSL workspaces without needing an explicit `command` override.

### Known unresolved quirk (separate)

- **Gemini WSL prompts for sudo password before launch.** Source unclear; not addressed here. Worth narrowing down because it leaks a credential into a process tree spawned by the dashboard.

## Original handoff (preserved below)

The notes below were written mid-investigation. They're kept for context on how the kitty-protocol hypothesis was reached.



## Reproduction (2026-04-29)

Workspace: `bbf8af5c-179f-48b0-b61e-9e00b98cb100` (ClaudeGIS_Automation, WSL path `/home/turke/ClaudeGIS_Automation`).

Test agents launched:
- WSL claude: `46358104-ae85-4ca6-a76c-e86f52fc6521`
- WSL codex (with explicit `command: "ccodex --full-auto"` to work around the launch bug below): `afbc5ec4-6314-4e87-8963-e9bd81813343`
- WSL gemini (with explicit `command: "gemini --yolo"`): `cf1ae69c-6e37-467a-af71-fbd9cda73cab`

Test sequence:

1. `send_message_to_agent` with `"ping — reply pong"` to all three.
   - Claude: log shows `❯ ping — reply pong` followed by `● pong` and `✻ Cooked for 1s`. Status flipped through `working` and back to `idle`. **Works.**
   - Codex: log shows `› ping — reply pong` in the prompt buffer with the cursor parked. No response, no submit. **Broken.**
   - Gemini: log shows `ping — reply pong` (raw text only — gemini's TUI rendering hadn't even painted the input box). No submit. **Broken.**

2. `send_message_to_agent` with three-line message to WSL claude (the only working single-line case):
   ```
   Multi-line test on WSL claude.
   Line two — confirming all three lines render.
   Line three. Reply with exactly: wsl claude multi-line ok
   ```
   Result: log shows the message correctly rendered across three lines under the `❯` prompt with continuation indents, but **no submit**. Status stayed `idle`. **Broken.**

The multi-line failure pattern matches the Windows codex failure that was fixed via Shift+Enter for embedded newlines. The single-line failure (codex/gemini) is a separate problem — Enter itself isn't being honored.

## Code path

WSL send chain:

1. HTTP route `POST /api/agents/:id/input` — `src/main/api-server.ts:133-153`
2. `Supervisor.sendInput(agentId, text)` — `src/main/supervisor/index.ts:1480-1494` for the WSL branch
3. `tmuxSendKeys(name, text)` — `src/main/wsl-bridge.ts:99-112`:
   ```ts
   const escaped = text.replace(/'/g, "'\\''");
   await wslExec(
     `tmux send-keys -t '${name}' -l '${escaped}' \\; send-keys -t '${name}' Enter`,
     5000
   );
   ```

The `-l` flag tells tmux to send the text **literally** (interpret bytes as input, not as keynames). Then a separate `send-keys Enter` fires what tmux thinks is an Enter keypress. Both happen in a single `wsl.exe` invocation so a flaky second spawn can't drop the Enter.

## Hypothesis

Codex, gemini, and (in multi-line mode) claude on Linux likely enable the **kitty keyboard protocol** at startup (CSI `>1u` to enable, CSI `<u` to disable). In that protocol, modern TUIs expect Enter as a CSI key-event sequence (e.g. `\x1b[13u` for plain Enter, `\x1b[13;5u` for Ctrl+Enter, `\x1b[13;2u` for Shift+Enter), not as a bare CR/LF byte.

`tmux send-keys Enter` emits a plain `\r` to the pane — fine for "classic" terminal-mode TUIs, but in kitty mode the TUI may simply ignore `\r` because it's expecting the CSI form.

This mirrors the Windows situation, where codex/gemini enable Win32 Input Mode (`\x1b[?9001h`) and `\r` similarly fails to register as a real key event without the CSI key-event encoding.

For multi-line claude on WSL, the symptom is consistent with kitty mode being activated **only** when a `\n` byte lands in the input buffer (entering "multi-line edit mode"), at which point plain `\r` from `send-keys Enter` is no longer interpreted as submit.

## Investigation steps to try (cheap → expensive)

1. **Confirm the kitty-protocol hypothesis.** Capture the early bytes from each agent's startup. From WSL: `tmux capture-pane -t <session> -p -e -S -200`. Look for `\x1b[>` enable sequences. Codex on Windows already emits `\x1b[?9001h` (Win32 Input Mode); the Linux equivalent is likely `\x1b[>1u` (kitty progressive enhancement) or `\x1b[?2004h` (bracketed paste, already known to be enabled by claude).

2. **Try sending Enter via the kitty CSI form.** Replace `send-keys Enter` with a literal CSI sequence. tmux can send raw bytes via `send-keys -H` (hex) or by piping through a temp paste-buffer. Quickest test:
   ```bash
   tmux send-keys -t <session> -l 'ping' \; send-keys -t <session> -H '1b' '5b' '31' '33' '75'
   # ESC [ 1 3 u  =  \x1b[13u  =  kitty Enter
   ```
   If codex/gemini single-line submit, kitty protocol is confirmed.

3. **For multi-line claude on WSL specifically:** try encoding embedded `\n` as Shift+Enter (kitty form `\x1b[13;2u`) and send plain Enter (`\x1b[13u`) to submit. Mirror the Windows multi-line fix exactly, just with the kitty encoding instead of Win32.

4. **If that works, generalize:** add a `provider`-aware branch to `tmuxSendKeys` matching the structure of the Windows `Supervisor.sendInput` branch:
   - claude: `tmux send-keys -l '<body>'` then a delay, then kitty Enter
   - codex/gemini: char-by-char (or buffered) with Shift+Enter for `\n`, kitty Enter to submit
   - default: leave the current `-l <text> ; send-keys Enter` path

5. **Codex paste-detect on Linux.** Codex on Windows treated rapid PTY input as a paste; the Linux version may do the same. If so, the slow-typing strategy from the Windows codex fix may be needed here too. tmux doesn't have a native "type slow" primitive, but you can split the input into many `send-keys` invocations or write each char individually.

6. **Authoritative answer.** Codex CLI is OpenAI's open-source CLI; gemini's CLI is also published. Find the input handler and look at how each reads Enter. That gives the exact submit keystroke + protocol they expect — much faster than guess-and-test.

## Other quirks observed

- **Provider param ignored on WSL workspaces with a custom default command.** When launching a WSL agent via `mcp__agent-dashboard__launch_agent` with `provider: "codex"` or `provider: "gemini"`, the agent silently launches as **claude** if the workspace's `defaultCommand` differs from the global `DEFAULT_COMMAND` constant. Bug at `src/main/supervisor/index.ts:509`:
  ```ts
  const command = resolvedInput.command || (workspace.defaultCommand === DEFAULT_COMMAND ? defaultCmd : workspace.defaultCommand);
  ```
  `DEFAULT_COMMAND` is the Windows default (`'claude --dangerously-skip-permissions --chrome'`); WSL workspaces have their own default (`'ccode --dangerously-skip-permissions --chrome'`), which is `!== DEFAULT_COMMAND`, so the workspace default always wins and the provider param is silently dropped. **Workaround until fixed:** pass an explicit `command` parameter at launch time. **Real fix:** also compare against `DEFAULT_COMMAND_WSL` and respect provider override regardless.

- **Gemini WSL prompts for sudo password before launch.** User reported being prompted for their password when launching gemini on WSL — happened during this investigation. Source unclear; may be `gemini` itself, may be something in the WSL profile. Worth narrowing down because it leaks a credential into a process tree spawned by the dashboard.

## Files referenced

- `src/main/wsl-bridge.ts:99-112` — `tmuxSendKeys()`, the WSL submit path
- `src/main/supervisor/index.ts:1480-1494` — WSL branch of `sendInput()`
- `src/main/supervisor/index.ts:1503-1535` — Windows branch (now fully working — reference implementation for the kitty version)
- `src/main/supervisor/index.ts:509` — provider-launch bug on WSL workspaces
- [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md) — Windows resolution
- [`docs/CODEX_INPUT_HANDOFF.md`](./CODEX_INPUT_HANDOFF.md) — Win32 Input Mode derivation, also has the kitty protocol idea sketched at the bottom

## Suggested commit message once it works

`fix(wsl-bridge): codex/gemini/claude sendInput — kitty-protocol key events for submit`
