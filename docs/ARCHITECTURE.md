# AgentDashboard — Architecture & Core Primitives

A map of the codebase as it stands today, written so a fresh agent can load just this file and understand the shape of the project. If a section says "see X" go read that file — this doc is intentionally a directory, not an encyclopedia.

For Ed's vision of where the multi-agent primitives are *heading* (planning committees, plan-driven execution, the skills leaderboard), see `CorePrimatives_EdTurk_042826.md`. This doc is about what exists in `src/` right now.

---

## TL;DR

AgentDashboard is an Electron + React desktop app that launches Claude Code / Codex / Gemini CLI agents in a workspace, watches their session logs in real time, and exposes a **dashboard MCP server** so a designated *supervisor agent* can coordinate the others. It runs on Windows but supports both Windows-native and WSL workspaces transparently. Around the agent core, the app also bundles a workspace file browser with native renderers (PDF, code, GeoTIFF, shapefile, GeoPackage, notebook), a live Jupyter kernel, a tmux/node-pty terminal pane, and a Teams primitive that lets agents message each other through a structured channel graph.

---

## Process Architecture

Four cooperating processes:

| Process | Entry | Role |
|---|---|---|
| Electron main | `src/main/index.ts` | App lifecycle, IPC, supervisor, fs watching, file I/O, Jupyter spawn |
| Electron renderer | `src/renderer/App.tsx` | React UI, Zustand store |
| Preload bridge | `src/preload/index.ts` | `contextBridge.exposeInMainWorld('api', …)` — typed IPC surface |
| Jupyter server (child) | spawned by `src/main/jupyter-server.ts` on port `18888+` | Notebook kernel host, embedded as iframe and driven over MCP |

Two long-lived servers run inside the main process:

- **HTTP API** — `src/main/api-server.ts`, port `24678`. The MCP scripts and any curl-based fallback (see `SCRIPT_*` blocks in `src/shared/constants.ts`) talk to this. From WSL, hit the Windows host via `/etc/resolv.conf`'s nameserver — TCP 24678 is allowed in the user's firewall.
- **WebSocket** — `src/main/ws-server.ts`. Used for streaming events to external listeners.

`src/main/index.ts` is the front door: it wires up `AgentSupervisor`, `WsServer`, `ApiServer`, `registerIpcHandlers`, and the `media://` protocol that lets the renderer fetch images/PDFs through the main process.

---

## Core Domain Primitives

Defined in `src/shared/types.ts`. Treat this file as the single source of truth — every store, IPC handler, and DB row maps to one of these.

- **Workspace** — a directory (Windows path or WSL path). Has `pathType: 'windows' | 'wsl'`, a default CLI command, and is the unit of "what am I working on right now."
- **Agent** — a launched CLI process (`claude`, `gemini`, or `codex`) tied to a workspace. Status machine: `launching → working → idle → waiting → done | crashed | restarting`. Carries `logPath` (its session JSONL), `pid`, `tmuxSessionName` (WSL only), `isSupervisor`/`isSupervised` flags, optional persona/template metadata.
- **AgentPersona** — a folder under `<workspace>/.claude/agents/<name>/` with optional `CLAUDE.md` and `memory/MEMORY.md`. Scanned by `src/main/persona-scanner.ts`. The persona named `supervisor` (see `SUPERVISOR_AGENT_NAME`) is special — it gets the supervisor MCP toolset.
- **AgentTemplate** — DB-backed launch preset (system prompt, role description, command, supervisor flags). Templates can be workspace-scoped or global.
- **Team / TeamMember / TeamChannel / TeamMessage / TeamTask** — see Teams section.
- **GroupThinkSession** — deprecated, see GroupThink section.
- **FileTab / FsEvent / FileContent / FileMutationResult** — the file-viewer surface.
- **ContextStats** — token usage + context-window % per agent, derived from session log.

Session log events (`src/shared/session-events.ts`): `UserText`, `AssistantText`, `Thinking`, `ToolUse`, `ToolResult`, `Usage`, `SystemInit`. These flow from Claude Code's `~/.claude/projects/<slug>/<sessionId>.jsonl` through the session-log-reader into the renderer's chat pane.

---

## The Supervisor (`src/main/supervisor/`)

`AgentSupervisor` (`supervisor/index.ts`) is the orchestration core. Responsibilities split across siblings:

- **`windows-runner.ts`** — spawns CLI agents directly via `execFile` with PowerShell encoding. No tmux on Windows.
- **`wsl-runner.ts`** — spawns through `wsl.exe bash -lc` inside a tmux session (prefix `cad__`). Tmux gives detach/reattach, persistent terminals, and clean teardown.
- **`paths.ts`** — `detectPathType(workingDirectory)` routes a launch to the right runner.
- **`status-monitor.ts`** — polls process state and emits status transitions on the supervisor's event bus.
- **`session-log-reader.ts`** — tails the session JSONL, parses events into typed shapes, batches them, and pushes to subscribed renderers via IPC. This is what powers the chat pane.
- **`context-stats-monitor.ts`** — aggregates token usage from the session log and emits `ContextStats` updates. Triggers supervisor notifications at 80/90/95% thresholds (see `SUPERVISOR_CONTEXT_THRESHOLDS`).
- **`file-activity-tracker.ts`** — records read/write/create operations per agent for audit + UI heat maps.
- **`event-payload-builder.ts`** — formats `[DASHBOARD EVENT]` messages that the supervisor agent receives in its terminal when supervised agents change state, crash, or hit context thresholds.
- **`team-delivery.ts`** — the team message pump. Polls every `TEAM_MESSAGE_DELIVERY_POLL_MS` (10s) for undelivered messages whose recipient is idle; when found, it injects them into the recipient's stdin.

Two layered file paths matter for an agent debugging supervisor behavior:

- Per-agent session log: `~/.claude/projects/<workspace-slug>/<sessionId>.jsonl` (Claude Code's own log format).
- App database: SQLite, see `src/main/database.ts`. Holds workspaces, agents, file_activities, teams, team_messages, team_tasks, groupthink_sessions.

---

## The MCP Server

This is the primary interface for an agent inside the dashboard.

**Transport.** stdio JSON-RPC, but the MCP scripts (`scripts/mcp-supervisor.js`, `scripts/mcp-team.js`) are thin proxies: they translate MCP tool calls into HTTP requests against `api-server.ts` on `127.0.0.1:24678`. This means the same tools are also available to anything that can `curl` (see `SCRIPT_LIST_AGENTS` etc. in `src/shared/constants.ts`).

**Two scopes.** Each spawned agent gets injected with one of:

- `mcp-supervisor.js` — full toolset for the workspace's designated supervisor.
- `mcp-team.js` — narrower toolset scoped to a team membership (only message your own teammates, only see your team's tasks).

**Supervisor tool surface** (paste the MCP tool names you'd see in a transcript without the `mcp__agent-dashboard__` prefix):

| Group | Tools |
|---|---|
| Agents | `list_agents`, `read_agent_log`, `send_message_to_agent`, `get_context_stats`, `stop_agent`, `launch_agent`, `fork_agent`, `create_persona`, `list_templates` |
| Teams | `create_team`, `disband_team`, `add_team_member`, `remove_team_member`, `add_channel`, `remove_channel`, `get_team`, `list_teams`, `resurrect_team` |
| Notebooks | `execute_cell`, `execute_range`, `execute_notebook`, `interrupt_kernel`, `restart_kernel`, `get_kernel_state` |
| GroupThink (deprecated) | `start_groupthink`, `get_groupthink_status`, `advance_groupthink_round`, `complete_groupthink` |

**Team-member tool surface** (per team, gated by channels):

`send_message`, `get_messages`, `get_tasks`, `update_task`, `get_team_info`.

Where it's wired:

- HTTP routes & MCP-tool implementations: `src/main/api-server.ts`.
- Supervisor agent's system-prompt boilerplate (what the supervisor *believes* its tools do): `SUPERVISOR_AGENT_MD` in `src/shared/constants.ts`. **Update both sides when you add or change a tool.**
- Per-agent `.mcp.json` is written into the agent's working directory at launch (see supervisor `launchAgent` flow).

---

## Teams (the current multi-agent primitive)

Teams replaced GroupThink. Spec is `docs/TEAMS_SYSTEM.md`; implementation is in `api-server.ts` (HTTP routes), `supervisor/team-delivery.ts` (delivery pump), the `team_*` tables in `database.ts`, and the renderer's team views (`src/renderer/components/...`).

**Mental model.** A team is a directed graph of agents-with-channels plus a shared task board. Every member can only message agents they have a channel to — the API rejects unauthorized sends. Templates: `groupthink` (all-to-all), `pipeline` (chain), `custom`.

**Message flow.**
1. Sender calls `send_message` → POST `/api/teams/:id/messages`.
2. API checks the channel exists, runs loop detection (see below), inserts row with `delivered_at = NULL`.
3. `team-delivery.ts` polls; when recipient is idle, it dequeues the message and pushes it via `supervisor.sendInput()` directly into the recipient's stdin/tmux session.

**Loop detection** (constants in `src/shared/constants.ts`): a global rate cap (`TEAM_MAX_MESSAGES_PER_5MIN`), pair-alternation cap (`TEAM_MAX_ALTERNATIONS` in `TEAM_ALTERNATION_WINDOW_MS`), and a low-content / dedup filter for "acknowledged" pingpong. Trips emit a `[TEAM EVENT] Loop detected` notice to the supervisor.

**Disband / resurrect.** `disband_team` writes a manifest (members, channels, recent messages, tasks) so `resurrect_team` can rehydrate the same shape later — even with new agents standing in for the originals.

---

## GroupThink (deprecated, code still live)

Multi-agent deliberation across rounds. Tools: `start_groupthink` / `get_groupthink_status` / `advance_groupthink_round` / `complete_groupthink`. Sessions live in the `groupthink_sessions` table. Comment in `src/shared/constants.ts` is unambiguous: **"Group Think (deprecated — use Teams)."** New code should use a Team with template `groupthink` (all-to-all channels) instead. Spec doc: `docs/GROUP_THINK.md`.

---

## Notebooks (live kernel)

Status: Phase 1 shipped (live kernel via the iframe). Active rebuild in progress per `docs/NOTEBOOK_FULL_SEND_PLAN.md` — recent commits are phases 2c/2d/3a/3b/3c (custom React renderer + virtualization + toolbars + status animations + `execute_notebook` tool). The iframe is being replaced piece by piece with native components in `src/renderer/components/notebook/` (`NotebookView`, `CodeCell`, `MarkdownCell`, `CellShell`, `CellToolbar`, `NotebookToolbar`, `OutputRenderer`, `CellStatusRing`, `NotebookActivityBar`, `StaticCodeBlock`).

**Backend.**
- `src/main/jupyter-server.ts` — spawns `jupyter server` on `18888+`, holds the token.
- `src/main/jupyter-kernel-client.ts` — attaches to whichever kernel the iframe opened, so MCP `execute_*` tools drive the **same** kernel the user sees. Outputs land in the file via the contents API; the iframe view updates without "file changed on disk" prompts.

**Frontend.**
- `src/renderer/hooks/useJupyterServer.ts` + `useYNotebook.ts` — Yjs collaboration document binding.
- `src/renderer/lib/jupyterCollab.ts` — RTC plumbing.
- `src/renderer/stores/cellStatus.ts` — per-cell exec state for the activity bar.

**Critical conventions** (lifted from `SUPERVISOR_AGENT_MD`):

- `notebook_path` is **server-relative** — strip the leading slash. WSL `/home/u/foo.ipynb` → `home/u/foo.ipynb`; Windows `C:\Users\u\foo.ipynb` → `mnt/c/Users/u/foo.ipynb`.
- **Address cells by their nbformat 4.5 `id`, never by index.** Indexes shift on insert.
- `interrupt_kernel` affects the user's iframe too. `restart_kernel` clears in-memory state, both sides reattach.
- R kernels (IRkernel) buffer stdout until the cell completes — no streaming.

---

## File Viewer

`src/renderer/components/fileviewer/` is a tabbed, dirty-state-tracking viewer with a directory tree and a content area that picks a renderer per file type. The dispatcher is `FileContentRenderer.tsx`; type detection is `fileTypeUtils.ts`.

Renderers (one per file class):

| Renderer | File types |
|---|---|
| `CodeRenderer` / `CodeMirrorEditor` | source code, with edit mode for write-capable files |
| `PlainTextRenderer` | catch-all text |
| `MarkdownRenderer` | `.md` (remark-gfm + remark-math + KaTeX) |
| `ImageRenderer` | png/jpg/gif/webp/avif/bmp/ico/svg via `media://` |
| `PdfRenderer` | `.pdf` (react-pdf) |
| `CsvRenderer` | `.csv` |
| `NotebookRenderer` | `.ipynb` static viewer (the live one is the notebook subsystem above) |
| `GeoTiffRenderer` | `.tif`/`.tiff` (geotiff + leaflet) |
| `ShapefileRenderer` | `.shp` (shpjs + leaflet) |
| `GeoPackageRenderer` | `.gpkg` (sql.js + wkx + leaflet) |

Symbol outline + edit/save/dirty handling: `SymbolOutline.tsx`, `useFileContentCache.ts`, `applyFsEvent.ts`. File mutations land via the `files.*` IPC handlers and go through `src/main/file-writer.ts`.

### Dual file watcher

`src/main/fs-watcher.ts` is dual-backend by design: chokidar can't see WSL inotify events from the Windows host, and inotifywait can't reliably watch `/mnt/*` Windows mounts from WSL. The watcher picks per path:

- Windows path → chokidar.
- WSL native path (not under `/mnt/`) → `inotifywait` subprocess.
- WSL `/mnt/*` → polling fallback.

Live updates flow as `FsEvent` (`add` / `change` / `unlink`) into the renderer where `applyFsEvent.ts` reconciles tab state.

---

## Terminal Pane

`src/renderer/components/terminal/TerminalPanel.tsx`. xterm.js (`@xterm/xterm` + fit + webgl + web-links addons) front-end; node-pty (Windows agents) or tmux attach (WSL agents) backend. IPC channels: `terminal:attach`, `terminal:write`, `terminal:resize`, plus a `terminal:onData` push for streaming. The supervisor never writes to an agent's terminal directly — it uses `send_message_to_agent` (which `team-delivery.ts` and the MCP server route through `supervisor.sendInput()`).

---

## Renderer Architecture

Layout (`src/renderer/components/layout/`):

- **Sidebar** — workspaces, agents, teams, GroupThink (legacy), file search.
- **MainContent** — file viewer or live notebook for the active tab.
- **DetailPanel** — chat pane (`components/detail/ChatPane.tsx`) showing parsed session events, plus file activity, agent metadata.
- **Terminal** — pinned at the bottom.

Layout dimensions and collapse states persist via `PanelLayout` in localStorage.

State management is Zustand. Stores:

- `src/renderer/stores/dashboard-store.ts` — selected workspace/agent, file tabs, panel layout, team data, GroupThink data, context stats, chat subscriptions.
- `src/renderer/stores/theme-store.ts` — theme.
- `src/renderer/stores/cellStatus.ts` — notebook cell execution status.

Chat pane internals (`src/renderer/components/detail/chat/`) parse `SessionEvent`s into renderable blocks — tool calls, diffs, ANSI output, thinking blocks. Block components live in `chat/blocks/`.

---

## IPC Layer

`src/preload/index.ts` exposes a typed `window.api` (interface `IpcApi` in `src/shared/types.ts`) grouped into namespaces:

- `workspaces` — list/create/delete/openInVSCode
- `agents` — list/launch/stop/restart/delete/fork/query/sendInput, getLog, getFileActivities, getContextStats, chat events, supervisor management
- `terminal` — attach/detach/write/resize/onData
- `files` — readFile, listDirectory, writeFile, createFile, mkdir, rename, deleteEntry, watchDirectory
- `system` — pickDirectory, healthCheck, openFile
- `groupthink` — start/getStatus/list/cancel (deprecated)
- `teams` — full CRUD + messages + tasks + resurrect
- `templates` — full CRUD
- `personas` — list/create
- `notebooks` — ensureServer, listKernelspecs

Plus push subscriptions: `onAgentStatusChanged`, `onGroupThinkUpdated`, `onTeamUpdated`, `onTeamMessageCreated`, plus per-agent `onChatEvents`, `onContextStatsChanged`, `onFileActivity`.

Main-side handlers all live in `src/main/ipc-handlers.ts`.

---

## Where to Start (task → file)

| You're working on… | Open first |
|---|---|
| Agent launch / lifecycle | `src/main/supervisor/index.ts`, then `windows-runner.ts` / `wsl-runner.ts` |
| New MCP tool | `src/main/api-server.ts` (handler) + `scripts/mcp-supervisor.js` or `mcp-team.js` (proxy) + `SUPERVISOR_AGENT_MD` in `src/shared/constants.ts` (docs the supervisor sees) |
| Chat pane / session events | `src/main/supervisor/session-log-reader.ts`, `src/shared/session-events.ts`, `src/renderer/components/detail/ChatPane.tsx` |
| Notebook execution | `src/main/jupyter-kernel-client.ts` + `src/renderer/components/notebook/NotebookView.tsx` |
| Teams behaviour | `src/main/api-server.ts` (HTTP) + `src/main/supervisor/team-delivery.ts` + `database.ts` (schema) + `docs/TEAMS_SYSTEM.md` |
| File ops | `src/main/file-reader.ts` + `src/main/file-writer.ts` + `src/main/fs-watcher.ts` |
| New file-type renderer | `src/renderer/components/fileviewer/FileContentRenderer.tsx` (dispatcher) + `fileTypeUtils.ts` |
| UI state | `src/renderer/stores/dashboard-store.ts` |
| Adding an IPC channel | Add types to `IpcApi` in `src/shared/types.ts`, expose in `src/preload/index.ts`, handle in `src/main/ipc-handlers.ts` |

---

## Documentation Inventory

Spec / current behaviour:

- `TEAMS_SYSTEM.md` — current multi-agent primitive.
- `MCP_CONFIGURATION.md` — MCP tool config, gating.
- `NOTEBOOK_PROTOTYPE.md` — Phase 1 design (live kernel) — shipped.
- `FILE_EDITING_MVP.md` — file write/mkdir/delete/rename surface.
- `GROUP_THINK.md` — legacy, partially superseded by Teams.

Active proposals / in-flight:

- `NOTEBOOK_FULL_SEND_PLAN.md` — custom React notebook renderer (currently mid-rebuild).
- `RELIABILITY_AND_SPEED.md` — perf / log caching.
- `MICRO_CLEANUPS.md` — small refactors / debt.
- `FILE_MANAGEMENT_EDITING_EXECUTION_PLAN.md`, `DOCUMENT_NOTES_ANNOTATION_PLAN.md`, `CHAT_PANE_OVERHAUL.md` — open design docs.
- `CorePrimatives_EdTurk_042826.md` — Ed's vision for where multi-agent primitives go next (planning committee, plan-driven execution, skills leaderboard). Read this for direction; this `ARCHITECTURE.md` for current state.

Reference / proposals:

- `KNOWLEDGE_GRAPH_PROPOSAL.md`, `RESOURCE_MONITOR_PROPOSAL.md`, `COMPANION_EXTENSION_PROPOSAL.md`, `SUPERVISOR_AGENT_PROPOSAL.md`, `SUPERVISOR_BEHAVIORS.md`, `TILLDONE_SYSTEM.md`, `PERSISTENT_PERSONAS.md`, `native-file-viewer.md`, `TMUX_SEND_KEYS_FIX.md`, `TESTING_WARNING.md`.

---

## Conventions & Gotchas

- **Path types are explicit.** Every file/agent operation carries `pathType: 'windows' | 'wsl'`. Don't assume — branch on it. `src/main/path-utils.ts` does the conversions.
- **WSL and `wsl.exe` from Bash.** Calls to `wsl.exe` from Claude Code's Bash tool that pass `/home/...` paths need `MSYS_NO_PATHCONV=1` to avoid Git-Bash mangling them.
- **MCP API host detection.** From WSL, the dashboard API isn't on `localhost` — it's on the Windows host. The `SCRIPT_*` blocks in `constants.ts` show the canonical "read `/etc/resolv.conf` nameserver" pattern. The user's firewall has TCP 24678 open for this.
- **Cell IDs not indexes.** Always.
- **Notebook paths are server-relative**, no leading slash, with WSL/Windows roots collapsed (`/mnt/c/...`).
- **`webSecurity: false`** is intentional in `BrowserWindow` — needed so the `file://` renderer can iframe-embed the local Jupyter server. Headers from Jupyter responses are sanitized in `index.ts`'s `onHeadersReceived` shim. Don't "fix" this without understanding what breaks.
- **Single-instance lock.** A second launch focuses the existing window rather than spawning a duplicate.
- **Production vs. dev.** `npm run start` loads from `dist/`. `npm run dev` runs Vite on 5173–5175; the main process probes those ports and falls through to `dist/` if none answer. A stale Vite server on those ports will be silently picked up — see `CLAUDE.md` "Ghost Vite Server Warning."
- **Build native deps.** node-pty and friends need an Electron-targeted rebuild. `npm run rebuild` handles it; `npm run dist` chains it before electron-builder.
