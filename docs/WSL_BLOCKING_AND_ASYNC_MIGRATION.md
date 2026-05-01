# Synchronous WSL Calls Freeze the Dashboard

**Status:** in progress - slice 1 validated; slice 2 implemented pending manual acceptance
**Severity:** high — manifests as full-app unresponsiveness whenever WSL is degraded
**Scope:** electron main process across ~9 source files

This document captures the architectural cause of the dashboard freezing whenever WSL is slow or unhealthy, and outlines the long-term fix (making WSL invocations asynchronous) at enough depth to support further research and planning.

## Implementation progress

### Completed slice 1 - WSL directory polling no longer blocks the main process

Implemented 2026-04-30:

- Added `wslExecCommand()` in `src/main/wsl-bridge.ts`, an async WSL command helper with timeout, maxBuffer, optional stdin, optional throw-on-error behavior, and the same Electron/Claude environment cleanup used by the older `wslExec()` helper.
- Added `listDirectoryEntriesAsync()` in `src/main/file-reader.ts`.
  - WSL directory listing now uses async `wsl.exe bash -lc`.
  - Windows directory listing keeps the existing local `fs.readdirSync` implementation.
  - The returned `DirectoryEntry[]` shape is unchanged.
- Updated `files:list-directory` in `src/main/ipc-handlers.ts` to await async directory listing.
- Reworked the polling fallback in `src/main/fs-watcher.ts`.
  - Polling uses async directory listing.
  - Polls are sequential; an in-flight poll is not overlapped by another tick.
  - On WSL failure, the watcher keeps the previous directory snapshot instead of emitting removals or clearing the tree.
  - Failures back off at 2s, 5s, 10s, then 30s; success resets to the normal 2s cadence.
  - Watcher close stops future retries.

Verified:

- `npm run build:main` passes.
- Compiled-helper WSL smoke test passes for create, write, read, rename, mkdir, and delete against a temp `/tmp` directory.

Still needs manual acceptance testing:

1. Open the dashboard with a WSL file tree expanded.
2. Run `wsl --shutdown` from PowerShell.
3. Confirm the dashboard remains clickable and Windows-side work still responds.
4. Confirm the WSL tree stays stale rather than disappearing.
5. Restart WSL and confirm polling recovers.

### Remaining risk after slice 1

This slice removes the repeated idle freeze caused by WSL polling. It does **not** remove every synchronous WSL call. Opening/saving WSL files, agent launch setup, persona scanning, and some supervisor config paths can still block the main process while they run.

### Completed passive WSL status indicator - health checks no longer start WSL

Implemented 2026-05-01:

- Added `getPassiveWslStatus()` in `src/main/wsl-bridge.ts`.
  - Uses `execFile('wsl.exe', ['-l', '-v'])`, not `wsl.exe bash -lc ...`.
  - Decodes null-padded UTF-16-style output returned by this machine.
  - Parses distro rows, the default distro marker (`*`), distro state, and WSL version.
  - Returns `running`, `stopped`, `unavailable`, `no-distro`, or `unknown` without starting WSL.
- Updated the shared `HealthCheck` type in `src/shared/types.ts`.
  - Existing booleans remain for compatibility.
  - Added `wslStatus` with passive distro details.
- Updated `system:health-check` in `src/main/ipc-handlers.ts`.
  - It now calls passive `wsl.exe -l -v` first.
  - It no longer calls `isWslAvailable()`, which uses `wsl.exe bash -lc` and can start WSL.
  - It checks `tmux` and Claude inside WSL only when passive status is already `running`.
  - If WSL is stopped, unavailable, or has no distro, `tmuxAvailable` and `claudeWslAvailable` return `false` without starting WSL.
- Updated the renderer footer in `src/renderer/components/layout/Sidebar.tsx`.
  - Replaced generic `Connected` text with `WSL Running`, `WSL Stopped`, `WSL Unavailable`, `No WSL distro`, or `Checking...`.
  - Added a manual refresh button.
  - Kept startup health checking event-driven; no interval polling was added.
- Added post-action health refreshes after deliberate WSL actions that may start WSL:
  - WSL directory load.
  - WSL file read/edit/save/open-in-VS-Code.
  - WSL agent launch, including supervisor launch.

Verified:

- `npm run build:main` passes.
- `npm run build:renderer` passes.
- Direct `wsl.exe -l -v` sanity check returned null-padded output (`Ubuntu Running`), and the new decoder produces normal text.

Behavioral note:

- Passive health checks are now informational only and should not start WSL.
- Deliberate WSL user actions still may start WSL. After those actions complete, the footer refreshes so it can move from `WSL Stopped` to `WSL Running`.

### Slice 2 implemented - WSL file read/write and mutations are async

Implemented 2026-05-01:

- Converted `readFileContents()` WSL stat/read calls to `wslExecCommand()`.
- Converted `file-writer.ts` WSL write, create, mkdir, rename, and delete paths to async `wslExecCommand()` calls.
- Updated related `files:*` IPC handlers to await the async helpers.
- Kept Windows file read/write/mutation behavior and existing return shapes unchanged.
- Removed the unused synchronous WSL directory listing helper from `file-reader.ts`.

Verified:

- `npm run build:main` passes.

Still needs manual acceptance testing:

1. Open the dashboard with a WSL file tree expanded.
2. Run `wsl --shutdown` from PowerShell.
3. Try reading and saving a WSL file.
4. Confirm those operations fail or report errors without freezing unrelated UI.
5. Restart WSL and confirm file reads/writes and file mutations recover.

---

## 1. Symptom

Whenever WSL is degraded — partial network failure, service restart, distro hang, swap thrashing — the entire dashboard becomes unresponsive for many seconds at a time. Symptoms users report:

- The whole UI stops responding to clicks.
- Tabs don't switch, the agent list won't refresh.
- Even purely Windows-side work (Windows agents, Windows file viewer, agent settings) is frozen, despite WSL having no involvement in those paths.
- The freezes recur every few seconds — the app "thaws" briefly, then locks up again.
- Eventually log lines like `listDirectoryEntries error: spawnSync wsl.exe ETIMEDOUT` appear, often four or five in a row.

It is not a renderer bug, a React performance issue, or an Electron quirk. The freezes are caused by the **main process blocking on synchronous WSL calls**.

## 2. Architectural cause

### 2.1 The main process is single-threaded

The Electron main process (`src/main/`) is a single Node.js script with one event loop. It owns:

- The agent supervisor and all PTY runners (Windows + WSL)
- All IPC endpoints the renderer talks to (`src/main/ipc-handlers.ts`)
- File reading/writing, directory listing, file watching
- The SQLite database (via `sql.js`)
- Session log polling, agent status polling, MCP scaffolding

Every renderer interaction — clicking an agent card, switching tabs, sending input, scrolling chat, refreshing the file tree, pressing a notebook cell's run button — becomes an IPC call into this single Node process. While that process is busy, every IPC call queues up. When it unblocks, the queue drains.

### 2.2 Synchronous subprocess calls block the loop completely

Many places in the main process invoke WSL via `child_process.execFileSync` (or `spawnSync`). These functions **block the Node event loop until the child returns or times out**. Nothing else runs on that loop in the meantime: not other IPC handlers, not the SQLite save, not the status monitor, not the renderer's heartbeat.

When WSL is healthy each call returns in <100ms and the freeze is imperceptible. When WSL is degraded, calls hit their timeout (typically 5 000–10 000 ms, and one site has no timeout at all). For each blocked call, **the dashboard is frozen end-to-end for the timeout duration**.

### 2.3 Why "I'm not using WSL right now" doesn't help

Two reinforcing reasons the freeze affects Windows-side work too:

1. **All UI traffic flows through the same main-process event loop.** A click on a Windows agent's input field is still an IPC call queued behind whatever sync call is currently blocked.
2. **The directory-watcher polls on a timer.** `src/main/fs-watcher.ts:127` runs `setInterval(() => listDirectoryEntries(...))` for every WSL directory open in the file viewer. `listDirectoryEntries()` calls `execFileSync('wsl.exe', …)` (`src/main/file-reader.ts:68`). When WSL stalls, every poll tick blocks the loop for the full timeout — and the timer keeps firing. The dashboard ends up locked in a chain of repeated 5–10 s blocks even when the user is doing nothing.

A subtler effect: synchronous calls inside async functions still block the loop. `await listDirectoryEntries(...)` does **not** make a sync call non-blocking — `await` is sugar for "resume when the Promise resolves," but `execFileSync` returns synchronously, so the event loop is held the entire time. The migration to async (Section 4) is not just a syntax change.

## 3. Inventory of synchronous WSL call sites

Concrete list of every `execFileSync` / `spawnSync` invocation that can call into WSL or wait on a child. Captured 2026-04-29.

### Hot path (called per UI interaction or on a timer)

| File:Line | Purpose | Timeout | Notes |
|---|---|---|---|
| `src/main/file-reader.ts:29` | Stat WSL file size | 10 000 ms | Called when opening any WSL file |
| `src/main/file-reader.ts:40` | Read WSL file contents | 10 000 ms | Same path |
| `src/main/file-reader.ts:132` | List WSL directory entries | 10 000 ms | **Migrated in slice 1** to async for IPC and watcher polling |
| `src/main/path-utils.ts:36` | wslpath conversion | 5 000 ms | Still synchronous, but no longer has an unbounded hang |
| `src/main/file-writer.ts:145` | Write content to WSL file | (default) | Save path for the file editor |
| `src/main/database.ts:555` | Test for an agent's `agent.md` | 5 000 ms | Runs during agent launch |

### Launch / supervisor path (called once per agent launch or reconcile)

| File:Line | Purpose | Timeout |
|---|---|---|
| `src/main/supervisor/index.ts:637` | Test file existence in WSL | 5 000 ms |
| `src/main/supervisor/index.ts:648` | Generic WSL command exec | 5 000 ms |
| `src/main/supervisor/index.ts:718, 773, 850` | `wsl.exe ip route show default` (gateway lookup for MCP) | (default) |
| `src/main/supervisor/index.ts:740, 801` | Write `.mcp.json` via base64 + `wsl.exe bash -lc` | 5 000 ms |
| `src/main/supervisor/index.ts:783, 895, 921, 1141` | `cat` various config / prompt files in WSL | 5 000–10 000 ms |
| `src/main/supervisor/session-log-reader.ts:70` | One-shot `echo $HOME` to find WSL home | (default) |
| `src/main/persona-scanner.ts:32, 101` | Persona discovery in WSL | 5 000 / 10 000 ms |
| `src/main/ipc-handlers.ts:238` | `claude --version` — Windows-only | 5 000 ms |
| `src/main/ipc-handlers.ts:233` | `system:health-check` WSL availability probe | 5 000 ms | **Migrated 2026-05-01** to passive `wsl.exe -l -v`; no WSL shell startup unless WSL is already running and tmux/Claude checks are needed |

The launch-path calls are individually less painful (they fire once per launch, not per UI interaction), but they still freeze the dashboard during the launch they happen on.

## 4. Long-term fix: convert hot-path WSL calls to async

The right end state: **no synchronous subprocess call ever runs on the main-process event loop**. Every WSL call becomes async. Failures and timeouts no longer block other work.

### 4.1 Mechanism

Replace `execFileSync(...)` with `execFile(...)` (the callback version) wrapped in a Promise — or use `node:util`'s `promisify(execFile)`. There is already an example pattern in the codebase: `src/main/wsl-bridge.ts` uses `execFile` asynchronously for tmux commands, and that path is the model.

Each call site needs three things:

1. The function containing the call becomes `async` and returns a `Promise`.
2. Every caller `await`s it (or accepts a Promise).
3. IPC handlers that previously returned a value synchronously now return a Promise — Electron's IPC already supports this via `ipcMain.handle`.

The change cascades up the call graph because `await` propagates. Every function on the path from an IPC handler down to the WSL call has to become async.

### 4.2 Suggested order

Migrate in slices to keep diffs reviewable and ship incremental wins:

1. **Done: `fs-watcher.ts` polling loop + async directory listing.** This was the loudest source of repeated freezes. A sick WSL should no longer create a recurring multi-second freeze cycle while the app is idle.
2. **Next slice: `file-reader.ts:readFileContents` + `file-writer.ts`.** Removes user-visible freezes when opening, saving, creating, renaming, or deleting WSL files.
3. **Next slice: `path-utils.ts:36` (wslpath).** It now has a timeout, but it is still synchronous. Convert it to async or cache aggressively so frequent conversions do not block the main process.
4. **Follow-up slice: `session-log-reader.ts:70` and `database.ts:555`.** Touched at agent launch / reconnect; less visible to the user but still freezes the app during reconnect storms.
5. **Follow-up slice: `supervisor/index.ts` MCP/config-writing block.** These run during launch; least visible. Worth doing for completeness rather than urgency.
6. **Follow-up slice: `persona-scanner.ts`.** Runs on a triggered scan; lower priority.

Items 1–3 alone account for ~95% of the felt impact.

### 4.3 Effort estimate

Counted by call sites (~25) and call-graph depth (mostly shallow — IPC handler → helper → exec). Rough estimate:

- **Slice 1 (fs-watcher + async directory listing):** implemented 2026-04-30.
- **Slice 2 (file-reader + file-writer):** half a day. Linear, mostly mechanical.
- **Slice 3 (path-utils + wslpath):** an hour, plus thinking about whether to *cache* converted paths since wslpath is frequently called for the same input.
- **Slices 4–6:** another day in total, but skippable if the loud freezes stop after 1–3.

Total realistic budget: **2–3 days of focused work** to do all of it; **1 day** to do the high-value 1–3 and call it done.

### 4.4 Risks and design decisions to make

These are the questions worth thinking through before committing to a final plan:

1. **Concurrency control.** Right now the synchronous calls accidentally serialize themselves — only one runs at a time because the event loop is blocked. Once async, multiple WSL calls can fly in parallel. WSL itself can handle this fine, but the dashboard's polling watcher could end up with overlapping ticks (slow tick still in flight when next interval fires). Decide: skip-tick-if-busy? Bound to a single in-flight call per directory? Adopt an in-flight set keyed by directory path?

2. **Cancellation.** When a user closes a workspace, in-flight WSL calls for that workspace's files should be cancelled, not allowed to land late and stomp state. Pattern: pass an `AbortSignal` through the call path.

3. **Caching wslpath.** `path-utils.ts:36` is called many times for the same paths. Once async, the latency cost is no longer hidden. A simple `Map<string, string>` cache on input→output would help.

4. **Error-state UX.** When WSL is genuinely unreachable, async calls won't freeze the app — but they will fail. The UI needs sensible empty/error states for: file viewer, agent launches that depend on WSL, file-tree polling. Today these states get masked by the freeze; making things async will surface them. Decide what "WSL unreachable" looks like in each surface.

5. **Backpressure on the polling watcher.** Even after going async, polling every WSL directory every few seconds is wasteful. Consider: longer interval after consecutive failures, exponential backoff, or replacing polling with the existing inotifywait subprocess where available (`fs-watcher.ts:100` already has the scaffolding for it).

6. **One-time test surface.** Sync calls are easy to mock with `vi.spyOn`; async calls need awaitable mocks. Some existing tests may need updating — worth scoping during slice 1.

### 4.5 Definition of done

After the migration, the following should hold:

- The Electron main process never blocks on `execFileSync('wsl.exe', …)` from any code path reachable during normal operation.
- A `wsl --shutdown` while the dashboard is open does **not** freeze the UI; it surfaces error states gracefully and recovers when WSL returns.
- Windows agents remain fully interactive while WSL is unreachable.
- Polling watchers back off cleanly on WSL failure rather than fire-and-fail every interval.

## 5. Quick wins status

The original stop-gap work is now mostly covered:

- `path-utils.ts:36` already has a 5 000 ms timeout. It can still block briefly, but it is not an unbounded hang.
- Polling watcher backoff is implemented in slice 1, and the WSL poll itself is async.
- The footer health indicator is passive. Startup/manual health checks use `wsl.exe -l -v` and do not start WSL.

These reduce the worst symptoms but do not complete the architecture migration. Section 4 remains the full target.

## 6. Next slices

### Slice 2 - WSL file read/write and file mutations (implemented, pending acceptance)

Goal: opening or saving a WSL file should not freeze the app when WSL is down.

- Convert `readFileContents()` WSL stat/cat calls to async.
- Convert `file-writer.ts` WSL operations to use `wslExecCommand()`.
- Make the related IPC handlers `async`.
- Preserve current return shapes: file reads still return `FileContent`; mutations still return `FileMutationResult`.
- Use the helper's stdin support for whole-file writes instead of adding another subprocess wrapper.

Acceptance test:

- With a WSL file open, run `wsl --shutdown`.
- Try reading/saving a WSL file and confirm the operation fails or reports an error without freezing unrelated UI.
- Confirm Windows file reads/writes still behave as before.

### Slice 3 - WSL path conversion and launch/reconnect hot spots

Goal: remove remaining short but user-visible main-process blocks from common WSL workflows.

- Convert or cache `path-utils.ts` native WSL `wslpath` conversion.
- Convert `database.ts:555` agent `agent.md` checks.
- Convert `supervisor/session-log-reader.ts:70` WSL home detection.
- Prefer small async helpers with unchanged caller-visible results.

Acceptance test:

- Launch/reconnect WSL agents while WSL is down or restarting.
- Confirm Windows agents and existing renderer interactions remain responsive.
- Confirm failures are logged or surfaced without hanging the app.

## 7. Research questions for the user

Things that would benefit from a decision before writing a final implementation plan:

- Is there appetite for a 2–3 day focused migration, or should this be sliced into background work over weeks?
- Are there other sync calls worth folding into the same migration (database export-on-write, anything else that touches the disk synchronously on a hot path)?
- Should `wslExecCommand()` grow `AbortSignal` support before slice 2, or is timeout-only cancellation enough for now?
- For native WSL directories, should we keep preferring `inotifywait`, or make polling behavior more prominent because it now has backoff and async execution?

## Appendix A — Why `await` doesn't fix sync calls

It is tempting to think wrapping a sync call in an `async` function makes it non-blocking:

```ts
// Looks async, still blocks the event loop:
async function readWslFile(path: string) {
  return execFileSync('wsl.exe', ['cat', path], { encoding: 'utf-8' });
}
```

`async`/`await` is sugar over Promises; it does **not** move the work off the event loop. `execFileSync` blocks Node's main thread regardless of where it sits in the source. The migration must use the genuinely async API (`execFile` callback, or `promisify(execFile)`, or `child_process.spawn` with stream listeners) — not just sprinkle `async` on existing sync calls.

## Appendix B — Reproducing the freeze

To confirm a freeze is sync-call-induced rather than e.g. renderer jank:

1. Open the dashboard with a WSL workspace selected and the file tree expanded.
2. From a separate Windows terminal: `wsl --shutdown`.
3. Watch the dashboard log: polling failures should show retry/backoff messages rather than synchronous `spawnSync wsl.exe ETIMEDOUT` loops.
4. The UI should remain responsive while WSL polling fails.
5. `wsl` (without args) brings WSL back; freezes stop.

If the same test produces no freezes, the migration in this doc has succeeded.
