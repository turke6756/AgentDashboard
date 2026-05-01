# Reliability and Speed

A living document of what we want the app to feel like, where it currently falls short, and the concrete changes that would close the gap.

## Intentions

The dashboard should feel like a native desktop tool, not a web page running in Electron. Concretely:

- **Instant interactions.** Clicking a workspace, opening a file, switching detail tabs, and typing in chat should respond within one frame (~16ms). Nothing should "stutter" while a background agent is busy.
- **Bounded background work.** File watching, log tailing, and health checks should scale with what is *visible*, not with what *exists*. Closing a panel should stop its work.
- **Crash-resistant main process.** A misbehaving agent, a stalled WSL call, or a flood of filesystem events must not freeze the UI or take down the supervisor.
- **Predictable startup.** The app should reach an interactive state without waiting on WSL, network, or large dependency parsing.
- **No silent leaks.** Watchers, subprocesses, IPC listeners, and file handles must be torn down when their owner goes away.

The rest of this document records what we found when we audited against those intentions on 2026-04-25 (branch `notebook-full-send`).

## Validation notes

A second pass against the current source agrees with the main direction of this audit, but not every finding is equally accurate.

- **Confirmed high-value fixes:** narrow Zustand selectors, batch file-watch IPC events, reduce main-process sync I/O in session log polling, remove startup WSL blocking, and stop duplicate poll/push updates in detail panes.
- **Broader than written:** whole-store Zustand subscriptions affect more than the three listed components. They also show up in `App`, `DetailPanel`, `TerminalPanel`, `FileViewerPanel`, and `AgentCard`.
- **Partially accurate:** `DetailPaneContext` itself only mounts for the active detail tab, but `DetailPanel` still polls badge counts every 5 seconds while the panel is open and also starts that polling before the collapsed-panel early return. That is the visibility issue to fix first.
- **Partially accurate:** the WSL health probes already go through `wslExec(..., timeout = 10000)`, so the issue is responsiveness and timeout length, not a total lack of timeout. The Windows `claude --version` probe is still synchronous on the main process.
- **Stale or incorrect:** `fs-watcher` already pools backend watchers by `pathType:path`; `DirectoryTree` returns the watcher cleanup; `getFullToolResult` reads one recorded byte range rather than reparsing the whole log; thrown `ipcMain.handle` errors reject the invoke promise rather than leaving it unresolved.
- **Dev-only:** `vite.optimizeDeps.include` affects Vite dev cold-start and dependency discovery. It is worth tuning, but it is not runtime reliability.

## High-impact findings

These are the changes most likely to be felt by the user. They are ordered by likely user-visible impact.

### 1. Whole-store Zustand subscriptions cause cascading re-renders

Several large components subscribe to the entire dashboard store with no selector, so any state change anywhere re-renders them.

- `src/renderer/components/layout/Sidebar.tsx:116`
- `src/renderer/components/layout/MainContent.tsx:42`
- `src/renderer/components/detail/FileActivityList.tsx:74`

**Validation:** Agree, and the issue is broader than this list. Also audit `App`, `DetailPanel`, `TerminalPanel`, `FileViewerPanel`, `AgentCard`, and the inline workspace tree inside `Sidebar`.

**Fix:** Replace `useDashboardStore()` with narrow selectors, e.g. `useDashboardStore(s => s.workspaceHeat)` and `useDashboardStore(s => s.panelLayout)`. Use `shallow` equality where multiple fields are needed.

### 2. Synchronous disk I/O on the polling tick

`src/main/supervisor/session-log-reader.ts:31` runs `fs.statSync` + `fs.openSync` + `fs.readSync` per agent on every poll. With 10 active agents this is roughly 20 sync I/O ops per second on the Electron main thread, which blocks IPC and UI updates.

**Validation:** Agree. The exact rate depends on subscribed vs unsubscribed agents and whether the file has new bytes, but all of this still runs on the Electron main process and should not be synchronous.

**Fix:** Convert to async I/O (`fs.promises`) with a concurrency limit. Cache file descriptors between ticks instead of reopening.

### 3. File-watcher event storms cross IPC unbatched

`src/main/ipc-handlers.ts:287` forwards each filesystem event individually via `mainWindow.webContents.send`. A 1000-file copy or a `git checkout` produces a corresponding burst of IPC messages, and each one wakes the renderer.

**Validation:** Agree. This is one of the clearest high-impact fixes because it bounds renderer wakeups during known bursty operations.

**Fix:** Buffer events for ~50ms in the main process and emit a single batched payload. The renderer should accept arrays.

### 4. Detail-pane polling runs even when the pane is closed

`src/renderer/components/detail/DetailPaneContext.tsx:20` polls `getFileActivities(agentId, 'read')` every 5 seconds for every known agent regardless of visibility.

**Validation:** Partially agree. `DetailPaneContext` only mounts when the Context tab is active, so it is not polling for every known agent. The more concrete issue is `DetailPanel` polling tab badge counts every 5 seconds for the selected agent, including before the collapsed-panel early return. `DetailPaneContext` and `DetailPaneProducts` also combine polling with `onFileActivity`, so recent activity can be written twice.

**Fix:** Gate detail/count polling on actual visibility. Prefer the existing `onFileActivity` push channel and use polling only as a reconciliation fallback.

### 5. Recursive trees and chat bubbles are not memoized

Lists that can grow into the hundreds re-render or re-mount every time their parent updates.

- `src/renderer/components/fileviewer/DirectoryTreeNode.tsx` — recursive tree node, mapped from `DirectoryTree.tsx:74`
- `src/renderer/components/chat/*` — `UserBubble`, `AssistantBubble`, `ToolBlock` mapped in `ChatPane.tsx:250`

**Validation:** Agree with the direction. For chat, `React.memo` will have limited effect until `pairEvents()` stops recreating new render item/result objects for every appended event.

**Fix:** Wrap each row component in `React.memo`, stabilize callback props (`onFileSelect`, `loadChildren`, `onClick`) with `useCallback` in the parent, and preserve stable render item object identities where practical.

## Medium findings

Reviewer status on this list:

- `src/renderer/App.tsx:54` - defensive cleanup is reasonable, but this is not a confirmed user-visible perf issue.
- `src/main/fs-watcher.ts:66` - stale as written. Backend watchers are already pooled by `pathType:path`; the remaining concern is one backend watcher per distinct expanded directory.
- `src/main/supervisor/session-log-reader.ts:135` - incorrect as written. `getFullToolResult` reads a recorded byte range for one JSONL line, not the whole log.
- `src/main/ipc-handlers.ts:234` - partially accurate. WSL probes already have a 10s timeout via `wslExec`; reduce the timeout for UI responsiveness and avoid the synchronous Windows `claude --version` probe.
- `src/main/supervisor/session-log-reader.ts:71` - confirmed. Move the WSL home lookup to lazy async init.
- `src/renderer/components/detail/DetailPaneContext.tsx:13` and `DetailPaneProducts.tsx` - confirmed. Polling and `onFileActivity` can both update the same state.
- `src/renderer/components/fileviewer/DirectoryTree.tsx:99` - incorrect as written. The effect returns `unsub`, so React cleans up the previous watcher.
- `vite.config.ts:20` - dev-only. This affects Vite cold-start/dependency discovery, not runtime reliability.
- `src/renderer/components/detail/FileActivityList.tsx:77` - confirmed but small. Memoize the lookups and `groupByFile(activities)`.

Original audit bullets, preserved for context:

- `src/renderer/App.tsx:54` — IPC listeners are registered in a single effect with no per-listener try/catch, so a throw during teardown can skip later cleanups. Wrap each `unsub` individually.
- `src/main/fs-watcher.ts:66` — One `inotifywait` subprocess per watch subscription. Twenty open trees means twenty subprocesses. Pool them by `path + pathType` and share.
- `src/main/supervisor/session-log-reader.ts:135` — `getFullToolResult` re-reads and re-parses the log file every call. Add a small LRU cache keyed by `toolUseId`.
- `src/main/ipc-handlers.ts:234` — `health-check` runs WSL probes via `Promise.all` with no timeout. A stalled WSL call freezes the renderer's health UI. Wrap each probe in `Promise.race` with a 5s timeout.
- `src/main/supervisor/session-log-reader.ts:71` — Synchronous `wsl.exe bash -lc 'echo $HOME'` runs during construction. Move to a lazy async init so app boot does not wait on WSL.
- `src/renderer/components/detail/DetailPaneContext.tsx:13` — Both the 5s poll and the `onFileActivity` listener write the same state, producing two re-renders per event. Pick one source of truth.
- `src/renderer/components/fileviewer/DirectoryTree.tsx:99` — File watcher subscription is recreated on every `refreshTick` change without releasing the previous one. Return the old `unsub` from the effect cleanup.
- `vite.config.ts:20` — `optimizeDeps.include` covers CodeMirror and Yjs but not the heavy GIS/notebook stack (`geotiff`, `leaflet`, `proj4`, `sql.js`, `@jupyterlab/services`). Cold-start spends extra time discovering these.
- `src/renderer/components/detail/FileActivityList.tsx:77` — `agents.find(...)` and `workspaces.find(...)` run on every render. Memoize against the relevant id.

## Low / nits

- `src/main/ipc-handlers.ts:165` — `terminal:attach` listeners stored in `activeListeners` but not removed on re-attach for the same agent.
- `src/preload/index.ts:71` — `watchDirectory` mints a fresh subscription per call; the same dir watched ten times yields ten watchers. Dedupe by `dirPath + pathType`.
- `src/main/supervisor/session-log-reader.ts:224` — Repeated `Buffer.byteLength()` per line during offset tracking. Cache or stream-parse.
- `src/renderer/components/fileviewer/FileTabBar.tsx:56` — `getDisplayLabel()` recomputes per-tab on every render. Memoize.
- `src/main/fs-watcher.ts:41` — `chokidar.watch(..., { depth: 0 })` only watches the root level. Either raise the depth or document the limit so callers do not assume recursion.
- `src/main/ipc-handlers.ts:108` — Each team mutation broadcasts immediately. Five mutations in 100ms produce five broadcasts. Debounce.

## Reliability concerns specifically

Reviewer validation:

- Startup WSL lookup is a confirmed blocking risk because it is synchronous during `SessionLogReader` construction.
- Health-check responsiveness is a real concern, but WSL calls already have a 10s timeout. Shorter per-probe timeouts plus moving the Windows `claude --version` check off sync main-process I/O would be more accurate.
- `inotifywait` subprocesses are already pooled per watched path. The remaining risk is unbounded distinct watched directories, not duplicate subprocesses for the same directory.
- `ipcMain.handle` throws reject renderer promises; they do not normally hang forever. Uniform try/catch is still useful for consistent error messages and logging.
- `DirectoryTree` watcher re-subscription cleanup exists. Keep an eye on duplicate subscriptions at the preload/caller level, but this specific leak was not confirmed.

Original concerns, preserved for context:

The audit surfaced a few items that are not perf issues but are listed here because they can manifest as "the app froze" or "things stopped updating":

- A stalled WSL call during startup or health-check will block the renderer because there is no timeout.
- `inotifywait` subprocesses are not currently pooled; if the user opens and closes file trees many times, processes accumulate until app exit.
- IPC handlers in `src/main/ipc-handlers.ts` do not uniformly try/catch — an unexpected throw leaves the renderer waiting on a promise that will never resolve.
- File watcher re-subscriptions in `DirectoryTree` can leak the previous subscription, so over time the same directory is watched multiple times.

## Suggested order of attack

Reviewer revised order:

1. Narrow Zustand selectors across all broad subscribers, not only the first three listed.
2. Batch file-watcher events before crossing IPC.
3. Gate detail/count polling on visibility and make push events the primary update path.
4. Move startup WSL path resolution out of the constructor and reduce health-check blocking.
5. Convert session-log polling to async/bounded I/O if profiling still shows main-process stalls.
6. Add targeted memoization for directory rows and chat rows, including stable chat render item identities.

Original proposed order:

**First pass (likely a single small PR, ~1 hour):**

1. Narrow Zustand selectors in Sidebar, MainContent, FileActivityList, DetailPanel.
2. `React.memo` on `DirectoryTreeNode` and the chat bubble components, with `useCallback` on the parent's handlers.
3. Memoize `agents.find` / `workspaces.find` lookups.

This is the change most likely to be *felt* by the user without touching main-process logic.

**Second pass (~half day):**

4. Batch file-watcher events with a 50ms window before crossing IPC.
5. Gate `DetailPaneContext` polling on subscriber count.
6. Add per-call timeouts to `health-check` and lazy-init the WSL home-dir lookup.

**Third pass (structural, ~half day):**

7. Convert `session-log-reader` to async I/O with bounded concurrency and FD caching.
8. Pool `inotifywait` subprocesses by path.
9. Add an LRU cache for `getFullToolResult`.

## Implementation log — first pass (2026-04-25)

Landed in one batch on branch `notebook-full-send`. Build (`npm run build`) is clean for both main and renderer.

### Renderer — narrowed Zustand subscriptions

Replaced bare `useDashboardStore()` calls with selectors. Multi-field reads use `useShallow` from `zustand/react/shallow`; actions are pulled individually since their references are stable for the store's lifetime.

- `src/renderer/App.tsx:48` — five fields split into individual selectors.
- `src/renderer/components/layout/Sidebar.tsx:116` — ten fields split; `InlineWorkspaceTree` now collapses to the active `filePath` primitive instead of subscribing to the whole `openTabs` array, so opening/closing tabs no longer re-renders the workspace tree.
- `src/renderer/components/layout/MainContent.tsx:42` — state via `useShallow`; dropped `agents` (was unused). Actions individual.
- `src/renderer/components/layout/DetailPanel.tsx:89` — state via `useShallow`, actions individual.
- `src/renderer/components/detail/FileActivityList.tsx:74` — derives just the `agent` and `workspace` it needs via `useShallow`, so unrelated agent updates do not re-render the list. `groupByFile(activities)` now wrapped in `useMemo`.
- `src/renderer/components/terminal/TerminalPanel.tsx:92` — subscribes only to its current agent (not the whole `agents` array). Sibling status changes no longer re-render the terminal.
- `src/renderer/components/fileviewer/FileViewerPanel.tsx:28` — state via `useShallow`, actions individual. Dropped unused `closeAllTabs`.
- `src/renderer/components/agent/AgentCard.tsx:42` — biggest change for list scenarios. Each card now subscribes only to its own slice (`s.contextStats[agent.id]`, `s.groupThinkSessions.find(...)`, `s.selectedAgentId === agent.id`). One agent's status flip no longer re-renders every other card.

### Renderer — visibility-gated polling

- `src/renderer/components/layout/DetailPanel.tsx:101` — the 5s `setInterval` for tab badge counts now early-returns when `collapsed === true`, and `collapsed` is part of the effect deps so polling tears down on collapse and restarts on expand.

### Main — fs-watcher events batched at IPC boundary

- `src/main/ipc-handlers.ts:286` — events are now queued per subscription id and flushed every 50ms. Wire format changed from `{ id, event }` to `{ id, events: FsEvent[] }`. A `git checkout` or 1000-file copy now produces a handful of IPC messages instead of one per file. Pending queues are cleared on `mainWindow.closed` and `files:watch-stop`.
- `src/preload/index.ts:71` — listener iterates `msg.events` and dispatches each event to the user-supplied callback. Behavior from the renderer's perspective is unchanged.

### Memoization

- `src/renderer/components/fileviewer/DirectoryTreeNode.tsx` — wrapped in `React.memo`. The recursive children mapped from `loadChildren` already had stable callback props (`useCallback` on the parent), so memo short-circuits on prop equality.
- `src/renderer/components/detail/chat/blocks/ToolBlock.tsx` — wrapped in `React.memo`.
- `src/renderer/components/detail/ChatPane.tsx` — `UserBubble`, `AssistantBubble`, `ThinkingNote`, `SystemNote` wrapped in `React.memo`. To make `React.memo(ToolBlock)` actually short-circuit (the reviewer flagged this would otherwise be cosmetic), `pairEvents` now uses a module-level `WeakMap<ToolResultEvent, ResultWrapper>` so the `result` prop reference is stable across calls when the underlying event is unchanged. `input`, `toolUseId`, `toolName`, and `agentId` were already reference-stable.

### Not yet done

The reviewer's plan still has these items waiting:

- Move WSL home-dir lookup in `src/main/supervisor/session-log-reader.ts:71` out of the synchronous constructor.
- Reduce `wslExec` per-call timeout from 10s for UI-blocking probes; move the Windows `claude --version` check off sync I/O on the main process.
- Convert `session-log-reader.ts` polling to async I/O with bounded concurrency and FD caching.
- Stabilize render-item identity beyond just `result` if profiling shows chat re-renders are still hot.

## How we will know it worked

- Opening or closing a file tree of 1000+ items should not stutter the rest of the UI.
- Typing in chat while an agent is actively writing logs should stay at 60fps.
- Closing the detail pane should drop background CPU noticeably (visible in Task Manager).
- A `git checkout` that touches hundreds of files should produce a single visible refresh, not a cascade.
- App startup should reach an interactive state without waiting on a WSL probe.
