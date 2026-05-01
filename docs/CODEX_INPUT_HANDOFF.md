# Handoff: Codex `sendInput` — RESOLVED 2026-04-29 (Windows only; WSL still open)

*Originally written 2026-04-29 mid-investigation. Updated later the same day when the multi-line case was fixed. WSL parity remains open — see [`docs/SEND_INPUT_WSL_BUG.md`](./SEND_INPUT_WSL_BUG.md).*

This is a continuation of [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md). Read that first for the original Claude fix and the codex regression history.

## TL;DR (current state)

| Provider | Windows single-line | Windows multi-line | WSL single-line | WSL multi-line |
|----------|---------------------|--------------------|-----------------|-----------------|
| claude   | ✅ (bracketed paste) | ✅                | ✅              | ❌ |
| codex    | ✅ (Win32 keys)      | ✅ (Shift+Enter)  | ❌              | ❌ |
| gemini   | ✅ (Win32 keys)      | ✅ (Shift+Enter)  | ❌              | ❌ |

Windows path is fully working for all three providers. WSL path needs follow-up — see the new WSL handoff.

## Resolution (Windows)

The fix lives in `src/main/supervisor/index.ts`. Three code paths, one per provider class:

```ts
if (agent?.provider === 'claude') {
  // Claude Code v2.x: bracketed paste body, then Enter as a separate write.
  winRunner.write(formatBracketedPaste(text));
  await delay(WINDOWS_SEND_INPUT_ENTER_DELAY_MS);
  winRunner.write('\r');
} else if (agent?.provider === 'codex' || agent?.provider === 'gemini') {
  // Codex/gemini enable Win32 Input Mode (ESC[?9001h). ConPTY's auto-converted
  // single KEY_DOWN per byte renders typed characters but doesn't trigger
  // submit. Type chars at a slow rate (paste-detect would otherwise fire),
  // encode embedded '\n' as Shift+Enter (newline-without-submit) so the final
  // plain Enter still submits, then send a real VK_RETURN down+up pair.
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

Constants used:

```ts
const WINDOWS_CODEX_TYPING_DELAY_MS = 8;
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';
const WIN32_KEY_SHIFT_ENTER_DOWN = '\x1b[13;28;13;1;16;1_';
const WIN32_KEY_SHIFT_ENTER_UP = '\x1b[13;28;13;0;16;1_';
```

### Verification (2026-04-29)

- Codex single-line + multi-line: agent `bbb0c682-c75d-4d51-b502-41e949d41fcc`. Multi-line three-line message rendered correctly, status flipped `idle → working`, codex replied `pong`.
- Gemini single-line + multi-line: agent `9a621964-70fa-42a1-b590-14da3f3f7cef`. Multi-line message rendered correctly, gemini replied `✦ gemini multi-line ok`.
- Claude multi-line: agent `e9751708-2388-4f2c-9baf-68b2514696e1`. Bracketed paste path unchanged, replied `claude multi-line ok`.

## Historical context (preserved for reference)

The original mid-investigation notes follow. They explain why Win32 Input Mode is necessary, the paste-detect heuristic that forces slow char-by-char typing, and the Shift+Enter approach that turned out to be the fix.

### What worked (single-line, partial fix from earlier in the day)

### Root cause confirmed

Codex enables **Win32 Input Mode** at startup (`\x1b[?9001h`). In this mode the TUI expects key events as CSI sequences with both KEY_DOWN and KEY_UP. ConPTY's auto-conversion of incoming bytes emits a single KEY_DOWN per byte — enough for codex to render typed characters, but not enough to register `Enter` as submit. The fix is to write Enter as a real VK_RETURN CSI key-event pair instead of relying on `\r` byte conversion.

Format: `ESC [ <Vk> ; <Sc> ; <Uc> ; <Kd> ; <Cs> ; <Rc> _`

For VK_RETURN: Vk=13, Sc=28, Uc=13. Down: `\x1b[13;28;13;1;0;1_`. Up: `\x1b[13;28;13;0;0;1_`.

## Current code (committed in working tree, not pushed)

`src/main/supervisor/index.ts`:

```ts
// Constants near top of file
const WINDOWS_CODEX_TYPING_DELAY_MS = 8;
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';

// In Supervisor.sendInput(), Windows runner branch:
if (agent?.provider === 'claude') {
  // unchanged Claude bracketed-paste fix
} else if (agent?.provider === 'codex') {
  for (const ch of text) {
    winRunner.write(ch);
    await new Promise((resolve) => setTimeout(resolve, WINDOWS_CODEX_TYPING_DELAY_MS));
  }
  await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
  winRunner.write(WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP);
} else {
  winRunner.write(`${text}\r`);   // gemini still falls into here, untested
}
```

The char-by-char typing with 8ms delay is necessary because codex auto-detects rapid PTY input as a paste and triggers an external-editor confirmation flow. The slow typing defeats that heuristic.

## Reproduction

```bash
npm run build && npm run start
```

Wait for dashboard, launch a codex agent in the AgentDashboard workspace, then:

**Single-line (works):**
```
mcp__agent-dashboard__send_message_to_agent({
  agent_id: "<codex-agent-id>",
  message: "ping"
})
```
Expected: status flips `idle → working`, codex replies (e.g. `pong`).

**Multi-line (broken):**
```
mcp__agent-dashboard__send_message_to_agent({
  agent_id: "<codex-agent-id>",
  message: "Line 1\nLine 2\nLine 3"
})
```
Expected: status flips `idle → working`, codex processes the message.
Actual: text appears in codex's input buffer rendered across multiple lines (with the `›` continuation prefix), but the Win32 Enter at the end fails to submit. status returns to `idle` immediately, codex never responds.

A live hung test agent from the failed run is `61803fb5-0042-4cc9-a080-41b5c965ac7f` — feel free to inspect via `read_agent_log` or stop it.

## Hypothesis for the multi-line failure

Each `\n` byte in the message gets written to the PTY during the char-by-char loop. ConPTY converts `\n` (0x0A) to some key event that codex interprets as **"insert newline in input buffer"** — verified by the fact that the rendered text shows proper line breaks with the `›` continuation prefix. Codex is now in **multi-line input mode**.

In multi-line mode, plain VK_RETURN (no modifiers) likely **adds another newline** rather than submitting. The submit keystroke for multi-line input in codex is probably one of:

- **Shift+Enter** for newline insert, **plain Enter** for submit (but then we shouldn't be sending `\n` as the newline trigger)
- **Esc+Enter** / **Alt+Enter** to submit multi-line — already tried as `\x1b\r`, did NOT work (but that was before the Win32 Enter fix; worth retrying as VK_RETURN with LEFT_ALT_PRESSED)
- **Ctrl+Enter** to submit
- **Ctrl+D** (EOT) to end input
- **Ctrl+J** (LF) — but `\n` already produced multi-line behavior, so this is unlikely

## Next steps to try (ordered cheap → expensive)

Each requires: edit `Supervisor.sendInput` codex branch, `npm run build:main`, kill electron, `npm run start`, launch fresh codex agent, send the multi-line test message, read log to verify submit.

1. **Strip `\n` from text before typing.** Replace newlines with spaces. Collapses formatting but is a known-good single-line path. Cheapest safety net if all else fails.

2. **Try Win32 modifier-Enter variants at end** in this order. Each tests a different "submit multi-line" keybinding hypothesis:

   ```ts
   // Alt+Enter (LEFT_ALT_PRESSED = 0x02)
   winRunner.write('\x1b[13;28;13;1;2;1_\x1b[13;28;13;0;2;1_');

   // Ctrl+Enter (LEFT_CTRL_PRESSED = 0x08)
   winRunner.write('\x1b[13;28;13;1;8;1_\x1b[13;28;13;0;8;1_');

   // Shift+Enter (SHIFT_PRESSED = 0x10) — usually inserts newline, but worth a check
   winRunner.write('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_');

   // Ctrl+D (VK_D = 0x44, with LEFT_CTRL_PRESSED)
   winRunner.write('\x1b[68;32;4;1;8;1_\x1b[68;32;4;0;8;1_');
   ```

3. **Encode embedded `\n` as Shift+Enter** instead of typing the raw `\n` byte. Then plain Enter at the end. This mirrors how a user enters multi-line input in most modern TUIs:

   ```ts
   for (const ch of text) {
     if (ch === '\n') {
       // Shift+Enter for newline-without-submit
       winRunner.write('\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_');
     } else {
       winRunner.write(ch);
     }
     await new Promise((resolve) => setTimeout(resolve, WINDOWS_CODEX_TYPING_DELAY_MS));
   }
   await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
   winRunner.write(WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP);
   ```

4. **Inspect codex's actual keybinding source.** Codex CLI is OpenAI's open-source CLI. Find the input handler and look for which keystroke its multi-line edit widget treats as "submit". This is the authoritative answer — but requires fetching codex source.

5. **Apply the eventual fix to gemini.** Once codex multi-line works, change the Windows runner branch from `provider === 'codex'` to `provider !== 'claude'`, or add an explicit gemini branch with the same logic. Verify with a fresh gemini agent.

## WSL parity (separate work, deferred)

User reports codex/gemini on WSL also fail (text appears, Enter doesn't fire). The WSL path uses `tmux send-keys -l <text> \; send-keys Enter` (`src/main/wsl-bridge.ts:99-112`). The `Enter` keyword in tmux should send a real Enter key event, but if codex/gemini on Linux enable kitty keyboard protocol or similar, tmux's Enter may not produce the right encoding for that mode.

To investigate later: read codex's startup output on WSL, look for keyboard protocol enable sequences (e.g. `\x1b[>1u` for kitty). If found, see if tmux can be configured to emit kitty-encoded Enter, or override the WSL `tmuxSendKeys` to send the raw kitty sequence directly.

## Files to read

- `src/main/supervisor/index.ts:1492-1525` — `sendInput()` Windows branch with the codex code we're iterating on.
- `src/main/supervisor/index.ts:32-40` — constants (`WINDOWS_CODEX_TYPING_DELAY_MS`, `WIN32_KEY_ENTER_DOWN`, `WIN32_KEY_ENTER_UP`).
- `src/main/supervisor/windows-runner.ts:205-207` — `write()` JSON-RPC to pty-host.
- `scripts/pty-host.js:88-93` — node-pty `write` handler. Uses default ConPTY settings.
- `src/main/wsl-bridge.ts:99-112` — WSL `tmuxSendKeys`, the path that's also broken for codex/gemini.
- [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md) — original Claude fix and the codex regression chain that led here.

## Useful constants reference

Win32 Input Mode CSI key event format:
```
ESC [ <VirtualKeyCode> ; <ScanCode> ; <UnicodeChar> ; <KeyDown> ; <ControlKeyState> ; <RepeatCount> _
```

| Symbol | Code |
|---|---|
| VK_RETURN | 13 (Sc=28) |
| VK_ESCAPE | 27 |
| VK_TAB | 9 |
| VK_BACK | 8 |
| VK_D | 0x44 |
| VK_J | 0x4A |

| Control state flag | Mask |
|---|---|
| RIGHT_ALT_PRESSED | 0x01 |
| LEFT_ALT_PRESSED | 0x02 |
| RIGHT_CTRL_PRESSED | 0x04 |
| LEFT_CTRL_PRESSED | 0x08 |
| SHIFT_PRESSED | 0x10 |

Reference: Microsoft Terminal repo issue #4999 (search "Improved keyboard handling in Conpty").

## Verification artifacts from the partial-fix run

- Codex single-line ping success: agent `61803fb5-0042-4cc9-a080-41b5c965ac7f` — log shows "Working… (1s • esc to interrupt)" then "• pong" after the Win32 Enter sequence. Visible via `read_agent_log` while the agent is still alive.
- Codex multi-line failure: same agent, second message. Log shows the text rendered across 4 lines under the `›` prompt with continuation markers, no submit, status returned to idle without working transition.

## Suggested commit message once it works

`fix(supervisor): codex/gemini sendInput — Win32 Input Mode key events for submit`
