# Chat → WSL Agent Send Path: Hung-Message Fix

## Symptom

Messages sent via the chat input bar to a WSL-hosted Claude Code agent would
occasionally end up **typed into Claude's prompt buffer but never submitted** —
as if a user had typed the text and forgotten to press Enter. The first message
after attaching usually worked; a later message would hang. No error surfaced
in the UI.

## Affected path

- `src/renderer/components/detail/ChatInputBar.tsx` → `window.api.agents.sendInput`
- `src/preload/index.ts` → `ipcRenderer.invoke('agent:send-input', ...)`
- `src/main/ipc-handlers.ts` → `supervisor.sendInput(agentId, text)`
- `src/main/supervisor/index.ts` `sendInput()` → `tmuxSendKeys(session, text)` (WSL agents)
- `src/main/wsl-bridge.ts` `tmuxSendKeys()` — **the bug lived here**

The native-Windows path (`winRunner.write(text + '\r')` in
`supervisor/index.ts`) was unaffected: it delivers text and Enter in a single
`node-pty` write.

## Old implementation

```ts
// src/main/wsl-bridge.ts
export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  const escaped = text.replace(/'/g, "'\\''");
  await wslExec(`tmux send-keys -t '${name}' -l '${escaped}'`, 5000);
  await wslExec(`tmux send-keys -t '${name}' Enter`, 5000);
}
```

Two separate `wsl.exe` spawns per message:

1. First spawn: types the literal text into the tmux pane (`-l` = literal mode,
   so text isn't interpreted as tmux key names).
2. Second spawn: sends the `Enter` key to submit it.

### Why it hung

`wslExec` catches every error and returns `{ exitCode: 1, stderr: ... }` — it
never throws:

```ts
// src/main/wsl-bridge.ts
export async function wslExec(command: string, timeout = 10000) {
  try {
    const { stdout, stderr } = await execFileAsync('wsl.exe', ['bash', '-lc', command], { ... });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return { stdout: '', stderr: err.stderr || err.message, exitCode: err.code || 1 };
  }
}
```

And `tmuxSendKeys` never checked the exit code. So if the **second** spawn
(the Enter) failed, timed out, or stalled — which happens intermittently with
`wsl.exe` cold-starts under Windows — the failure was silently discarded while
the first spawn (the text) had already succeeded. Net effect: the message
showed up in Claude's prompt buffer with no Enter to submit it, and nothing
surfaced to the UI.

### State diagram of the failure mode

```
┌─────────────┐   wsl.exe spawn #1   ┌──────────────────────────┐
│ chat "hi"   │ ───────────────────▶ │ tmux send-keys -l 'hi' ✅ │
└─────────────┘                      └──────────────────────────┘
                                                  │
                                                  ▼
                               ┌─────────────────────────────────────┐
                               │ Claude's prompt now shows: "hi"     │
                               └─────────────────────────────────────┘
                                                  │
                      wsl.exe spawn #2 ───────────┤
                                                  │
                     (timeout / cold-start stall) │
                                                  ▼
                               ┌─────────────────────────────────────┐
                               │ tmux send-keys Enter ❌ (swallowed)  │
                               └─────────────────────────────────────┘
                                                  │
                                                  ▼
                               ┌─────────────────────────────────────┐
                               │ "hi" sits in buffer, never submitted │
                               │ UI thinks send succeeded             │
                               └─────────────────────────────────────┘
```

## New implementation

```ts
// src/main/wsl-bridge.ts
export async function tmuxSendKeys(name: string, text: string): Promise<void> {
  // Chain literal-text send and Enter into a single wsl.exe invocation so they
  // either both happen or neither does. Splitting them across two wsl.exe
  // spawns lets a flaky second spawn drop the Enter silently, leaving the
  // message typed but unsubmitted in Claude Code's prompt buffer.
  const escaped = text.replace(/'/g, "'\\''");
  const result = await wslExec(
    `tmux send-keys -t '${name}' -l '${escaped}' \\; send-keys -t '${name}' Enter`,
    5000
  );
  if (result.exitCode !== 0) {
    throw new Error(`tmux send-keys failed: ${result.stderr || 'unknown error'}`);
  }
}
```

Two changes:

1. **Single `wsl.exe` spawn.** Both tmux commands are chained via `\;`, which
   tmux itself parses as a command separator (the backslash protects it from
   the outer shell). Text and Enter are now atomic: either both land or both
   fail — no more half-delivered state.
2. **Fail loudly.** Non-zero exit throws. The error propagates:
   `tmuxSendKeys` → `supervisor.sendInput` → `ipcMain.handle('agent:send-input')`
   → rejected promise at `await window.api.agents.sendInput(...)` in
   `ChatInputBar.tsx`.

   `ChatInputBar` already handles this correctly: `setInput('')` only runs
   after a successful `await`, so on failure the draft stays in the textarea
   and the user can retry. The old silent-drop case no longer exists.

## Comparison

| Behavior                            | Old                            | New                             |
|-------------------------------------|--------------------------------|---------------------------------|
| `wsl.exe` spawns per message        | 2                              | 1                               |
| Atomicity of text + Enter           | None — independent spawns      | Atomic — single tmux invocation |
| Exit code checked                   | No                             | Yes — throws on non-zero        |
| Failure visible to renderer         | No                             | Yes — rejected promise          |
| Draft preserved on failure          | N/A (failure silent)           | Yes (textarea retains text)     |
| "Typed but unsubmitted" state       | Possible on 2nd-spawn failure  | Impossible                      |

## Notes

- The native-Windows path was already correct and is unchanged.
- The MCP `send_message_to_agent` tool also flows through `supervisor.sendInput`,
  so it inherits the fix automatically.
- `wslExec` still swallows errors at the general-purpose layer; the exit-code
  check now lives in `tmuxSendKeys` where the semantics demand it.
