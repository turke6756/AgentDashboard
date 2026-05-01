# Orchestration Spike — First Green Pass

*2026-04-29*

The orchestration spike is the smoke test for the multi-agent core primitives
described in `docs/CorePrimatives_EdTurk_042826.md`. It launches a Claude
planner (Alpha) and a Codex planner (Beta) in the AgentDashboard workspace,
runs them through a planning + consensus exchange, then forks Alpha into a
disposable worker that creates `hello.py` and ticks off a plan markdown.

If the spike runs end-to-end, the primitives — agent launch, peer messaging,
multi-line cross-provider input, fork, and structured artifact production —
are all wired up correctly.

## First successful run

- **Run ID**: `20260429162310-5593`
- **Log**: `.claude/plans/runs/spike-20260429162310-5593.log`
- **All six phases (A–F) green; artifact verification passed; cleanup
  succeeded.**

| Phase | What it exercised | Wall time |
|---|---|---|
| A | API discovery + supervisor + workspace validation | <100 ms |
| B | Launch Claude + Codex planners, deliver multi-line planner prompt to both | ~62 s |
| C | 5 KB consensus exchange (Alpha log tail typed into Codex Beta) | ~99 s |
| D | Plan markdown written, supervisor notified | ~15 s (3 retry attempts) |
| E | Fork Alpha → worker, deliver worker prompt, worker writes `hello.py` and edits plan | ~43 s |
| F | Cleanup of all spike-launched agents | <1 s |

## What had to land before this passed

### 1. Multi-line input on Windows Codex / Gemini

Already in place at the start of this session. `Supervisor.sendInput()` for the
Windows codex/gemini branch (`src/main/supervisor/index.ts:1542-1569`) types
one character at a time at 8 ms intervals to dodge Codex's paste-burst
detection. Embedded newlines become Win32 Shift+Enter CSI sequences; submit is
a real VK_RETURN down/up pair. See `docs/SEND_INPUT_WINDOWS_BUG.md` for the
encoding details.

### 2. Fire-and-forget `POST /input`

The per-character typing path is *intentionally* slow — a 5 KB consensus tail
takes ~40 s to type. With the previous synchronous `await
supervisor.sendInput(...)` in `api-server.ts`, the HTTP request stayed open for
that whole window and blew through any reasonable client timeout (15 s, 60 s
— still not enough as payloads grew).

Now (`src/main/api-server.ts`, `src/main/supervisor/index.ts`,
`src/main/ipc-handlers.ts`):

- `POST /api/agents/:id/input` queues the send and returns `{ queued: true }`
  in milliseconds. The typer drains in the background.
- `Supervisor` keeps a per-agent serial promise chain (`inputQueues`) so
  concurrent sends to the same agent type cleanly instead of interleaving
  bytes into a single prompt buffer.
- `Supervisor.isInputInFlight(id)` is surfaced through the API: while a send
  is in flight, `GET /agents/:id` overrides `status` to `'working'` (the status
  monitor cannot infer this on its own — typed-char echoes are explicitly *not*
  a "meaningful burst", so it would otherwise read `'idle'` for the entire
  typing duration).
- `POST /input` rejects with 409 if `isInputInFlight` is true, even when the
  DB still says idle. This closes the race where two callers send back-to-back
  before the agent's first response burst lands.
- The renderer chat input bar gets the same fire-and-forget treatment via
  the IPC handler, so the input UI no longer freezes for 30+ seconds on big
  sends.

Internal callers (`team-delivery.ts`, the resurrect path, `queryAgent`) keep
`await supervisor.sendInput(...)` and now get serialized-with-everything-else
delivery semantics for free.

### 3. `waitReady` requires sustained idle

`scripts/orchestration-spike.js` previously polled with `minReadyPolls: 1`,
which caught two distinct false-positive idle moments:

1. The brief idle gap between Claude Code's `'launching'` status clearing
   and the first prompt-UI render burst.
2. Mid-task idle pauses where an agent finishes one tool call and is
   thinking about the next — `WORKING_THRESHOLD_MS = 8 s` means the monitor
   reports `idle` after a single 8 s silence even though the agent isn't done.

Bumped to `minReadyPolls: 3, pollMs: 2000` (6 s of stable idle) for all
post-launch and post-turn waits. The fork-warmup wait was already at
`minReadyPolls: 5`.

### 4. Plan path moved out of `.claude/`

This is the key gotcha — see "Agent file-write conventions" below.

## Agent file-write conventions

**Worker / planner / persistent agents in this repo should not write or edit
files under `.claude/`.**

Claude Code's permission system gates edits to anything inside `.claude/`
(where `settings.json`, agent definitions, plans, and skills live) **even with
bypass-permissions on**. The harness shows an interactive confirmation dialog
asking the user to approve the edit, which blocks any non-interactive
orchestration mid-task.

We hit this in run `20260429160717-4327` when the worker fork wrote `hello.py`
successfully, then sat hung at this dialog trying to edit
`.claude/plans/spike-hello-world.md`:

```
Edit file
.claude\plans\spike-hello-world.md
...
Do you want to make this edit to spike-hello-world.md?
❯ 1. Yes
   2. Yes, and allow Claude to edit its own settings for this session
   3. No
```

The status monitor classified the agent as `'idle'` (no output burst, just a
static prompt rendered in the TUI), the script's `waitReady` returned, and the
worker was killed before anyone answered the dialog.

**Mitigation in the spike**: plan markdown moved from
`.claude/plans/spike-hello-world.md` to repo-root `spike-hello-world.md`. Run
logs and the orchestrator-internal artifacts can still live under
`.claude/plans/runs/` because the *script* writes those, not an agent.

**Generally**: when authoring agent prompts, instruct workers to write to
paths outside `.claude/`. If a plan or output genuinely belongs under
`.claude/`, the orchestrator (Node script, dashboard, or supervisor MCP) should
write it on the agent's behalf rather than asking the agent to do the edit.
