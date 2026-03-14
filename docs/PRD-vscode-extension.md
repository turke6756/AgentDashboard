# Product Requirements Document: AgentDashboard VS Code Extension

## Document Context

This PRD describes the conversion of **AgentDashboard** from a standalone Electron desktop application into a **VS Code extension**. The existing Electron app (v0.1.0) is a workspace-centric dashboard for managing and monitoring multiple Claude Code AI agents running across Windows and WSL environments. It was built to solve the problem of orchestrating many parallel Claude Code instances across different project directories, with features like agent lifecycle management, inter-agent communication (query/fork), terminal emulation, file activity tracking, and crash recovery via tmux session persistence.

The motivation for moving to VS Code is simple: the user already works in VS Code for file browsing and editing. Having a separate Electron window for the dashboard means constant window switching between the dashboard and multiple VS Code windows (one per project directory). The goal is **one VS Code window** that contains both the agent dashboard and VS Code's native file/editor capabilities, with the ability to slide between the fleet-wide dashboard view and per-directory workspace views without opening additional windows.

A critical design constraint is **WSL connection resilience**. VS Code's Remote-WSL extension frequently drops its connection. Agents must run inside tmux sessions in WSL so they survive any connection interruption. The extension must run as a **local Windows extension** that communicates with WSL via `wsl.exe` shell calls, never depending on Remote-WSL's connection stability.

---

## 1. Product Vision

### 1.1 Problem Statement

Working with multiple Claude Code agents across several project directories currently requires:
- The AgentDashboard Electron app (for agent management)
- Multiple VS Code windows (one per project directory, for file browsing/editing)
- Constant Alt-Tab switching between these windows

This creates cognitive overhead and window management friction. Additionally, VS Code's Remote-WSL connection instability means agents spawned directly through VS Code's terminal can die when the connection drops.

### 1.2 Solution

A VS Code extension that embeds the AgentDashboard directly into VS Code. The extension provides:
- A **dashboard home view** (full editor area webview) showing all workspaces and agents across the fleet
- The ability to **drill into any workspace** and have VS Code's file explorer, editor, and the agent sidebar all switch to that directory's context
- Agent terminals rendered in the bottom panel area, replacing VS Code's native terminal
- All agent processes managed via tmux in WSL through `wsl.exe`, independent of VS Code's remote connection

### 1.3 One-Window Mental Model

```
Dashboard Mode (home screen):
  Full webview showing all workspaces, all agent cards, fleet status

         double-click workspace
              |
              v

Workspace Mode (per-directory):
  File explorer = that directory's files
  Sidebar = that directory's agent cards
  Bottom panel = agent terminal viewer (xterm.js webview)
  Editor = files from that directory

         click "Dashboard" tab or keyboard shortcut
              |
              v

Dashboard Mode (back to fleet view)
```

One VS Code window. No other windows to manage. The dashboard follows you everywhere.

---

## 2. Architecture Overview

### 2.1 High-Level System Diagram

```
+-----------------------------------------------------------+
|  Single VS Code Window (Local, Windows)                   |
|                                                           |
|  +-----------------------------------------------------+ |
|  | Local Extension Host (Windows Node.js)               | |
|  |                                                      | |
|  |  Extension Entry Point (extension.ts)                | |
|  |    +-- Dashboard Webview Provider (full editor tab)  | |
|  |    +-- Agent Sidebar Provider (TreeView / Webview)   | |
|  |    +-- Terminal Webview Provider (bottom panel)       | |
|  |    +-- Workspace Switcher (folder swap logic)        | |
|  |    +-- Supervisor Client (WebSocket to daemon)       | |
|  +-----------------------------------------------------+ |
|           |                                               |
|           | localhost WebSocket / HTTP                     |
|           v                                               |
|  +-----------------------------------------------------+ |
|  | Supervisor Daemon (standalone Node.js process)       | |
|  |                                                      | |
|  |  AgentSupervisor (orchestration)                     | |
|  |    +-- WindowsRunner (pty-host.js + node-pty)        | |
|  |    +-- WslRunner (wsl.exe -> tmux sessions)          | |
|  |    +-- StatusMonitor (polls every 2.5s)              | |
|  |    +-- FileActivityTracker (parses agent output)     | |
|  |    +-- Database (SQLite via sql.js)                  | |
|  |    +-- AgentRegistry (~/.claude/agent-registry.json) | |
|  |    +-- WebSocket Server (for extension clients)      | |
|  +-----------------------------------------------------+ |
|           |                                               |
+-----------|-----------------------------------------------+
            | wsl.exe bash -lc "tmux ..."
            v
+-----------------------------------------------------------+
|  WSL (Ubuntu)                                             |
|                                                           |
|  tmux sessions (persistent, no VS Code dependency)        |
|    cad__agent-slug__a1b2c3d4 -> claude --session-id ...   |
|    cad__agent-slug__e5f6g7h8 -> claude --session-id ...   |
|    ...                                                    |
+-----------------------------------------------------------+
```

### 2.2 Why a Separate Supervisor Daemon

In the Electron app, the supervisor runs in the main process — there is exactly one. In VS Code, the extension host is per-window. If the user opens multiple windows (accidentally or intentionally), multiple extension instances would fight over agent management.

The supervisor daemon solves this:
- Runs as a standalone headless Node.js process on Windows
- Starts automatically when the extension activates (if not already running)
- Stays alive even if all VS Code windows close — agents keep running
- Multiple extension instances connect as clients via WebSocket on localhost
- Single source of truth for agent state, database, process management
- Identical to the current Electron main process logic, just extracted into a daemon

### 2.3 WSL Resilience Model

The extension **never** uses VS Code's Remote-WSL extension for agent management. All WSL interaction goes through `wsl.exe` shell calls from the local Windows side:

```
Extension (Windows) -> Supervisor (Windows) -> wsl.exe bash -lc "tmux ..." -> WSL
```

This means:
- Agents run in tmux sessions that have zero dependency on VS Code
- If WSL's network bridge hiccups, tmux sessions are unaffected
- The supervisor reconnects to tmux sessions by polling `tmux has-session` and `tmux capture-pane`
- File browsing via UNC paths (`\\wsl.localhost\Ubuntu\...`) may temporarily fail during WSL drops, but the dashboard and agent management remain fully operational
- When WSL comes back, everything resumes — terminal webviews reattach, file explorer resolves paths again

**Failure matrix:**

| Failure | Dashboard | Agent Processes | File Explorer | Terminal View |
|---------|-----------|-----------------|---------------|---------------|
| WSL connection drops | Stays up | Keep running (tmux) | Goes dead | Shows stale, then reconnects |
| VS Code window closes | Gone (UI only) | Keep running (daemon) | Gone | Gone |
| VS Code restarts | Reloads, reconnects | Still running | Reloads | Reattaches |
| Supervisor daemon crashes | UI shows disconnected | Orphaned but alive in tmux | Unaffected | Disconnected until daemon restarts |
| Full system reboot | Must relaunch | Dead (tmux gone) | Must reopen | Must reattach |

---

## 3. Existing System — What Carries Over

The following modules from the current Electron app port directly into the supervisor daemon with minimal changes:

### 3.1 Supervisor Core (`src/main/supervisor/index.ts`)

**Ports to:** Supervisor daemon

All agent lifecycle methods carry over unchanged:
- `launchAgent(input)` — Create DB record, load agent.md (10KB cap), spawn runner
- `stopAgent(id)` — Kill process, kill tmux session, update status
- `restartAgent(id)` — Stop then relaunch with `--continue`
- `forkAgent(id)` — Clone session with `--fork-session --session-id <newId>`
- `queryAgent(targetId, question, sourceId?)` — Spawn isolated 1-turn Claude with `--resume --fork-session --max-turns 1 --output-format json`
- `attachAgent(id)` / `detachAgent(id)` — Manage terminal data streams
- `writeToAgent(id, data)` — Forward input to PTY or tmux send-keys
- `resizeAgent(id, cols, rows)` — PTY resize
- `deleteAgent(id)` — Stop, delete DB record, clean up log file
- `sendInput(id, text)` — Send text to idle/waiting agents
- `reconcile()` — On daemon startup, reconnect to tmux sessions for agents that were active
- `writeAgentRegistry()` — Update `~/.claude/agent-registry.json`

### 3.2 WSL Runner (`src/main/supervisor/wsl-runner.ts`)

**Ports to:** Supervisor daemon, unchanged

- Tmux session creation: `tmux new-session -d -s 'cad__<slug>__<id8>' -c '<workdir>'`
- Command injection: `tmux send-keys -t '<session>' '<command>' Enter`
- PTY attachment: `pty-host.js` running `wsl.exe bash -lc "tmux attach -t '<session>'"`
- Session naming convention: `cad__` prefix with slug and 8-char ID suffix
- Environment variable cleanup: Delete `CLAUDECODE`, `ELECTRON_RUN_AS_NODE`, set `WSLENV`

### 3.3 Windows Runner (`src/main/supervisor/windows-runner.ts`)

**Ports to:** Supervisor daemon, unchanged

- `pty-host.js` spawning with node-pty
- JSON message protocol on stdin/stdout (spawn, write, resize, kill)
- Meaningful output detection (>200 bytes in 3s window)
- Exit code tracking, PID management

### 3.4 Status Monitor (`src/main/supervisor/status-monitor.ts`)

**Ports to:** Supervisor daemon, unchanged

- Polls every 2500ms (`STATUS_POLL_INTERVAL_MS`)
- Working threshold: 30s since last output (`WORKING_THRESHOLD_MS`)
- Status inference: alive + recent output = working, alive + stale = idle, dead + code 0 = done, dead + code != 0 = crashed
- Debounce: Hold status for 5s minimum before changing
- Emits `statusChanged` events (now broadcast over WebSocket to connected extensions)

### 3.5 WSL Bridge (`src/main/wsl-bridge.ts`)

**Ports to:** Supervisor daemon, unchanged

- `wslExec(command)` — Execute via `wsl.exe bash -lc "<command>"`
- `tmuxListSessions()`, `tmuxNewSession()`, `tmuxKillSession()`, `tmuxHasSession()`
- `isWslAvailable()`, `isTmuxAvailable()`, `isClaudeAvailableInWsl()`
- Path conversion: `windowsToWslPath()`, `uncToWslPath()`

### 3.6 Database (`src/main/database.ts`)

**Ports to:** Supervisor daemon, unchanged

SQLite via sql.js with existing schema:

```sql
-- workspaces table
id TEXT PRIMARY KEY, title TEXT, path TEXT, path_type TEXT,
description TEXT, default_command TEXT, created_at TEXT, updated_at TEXT, last_opened_at TEXT

-- agents table
id TEXT PRIMARY KEY, workspace_id TEXT, title TEXT, slug TEXT,
role_description TEXT, working_directory TEXT, command TEXT,
tmux_session_name TEXT, auto_restart_enabled INTEGER, resume_session_id TEXT,
status TEXT, is_attached INTEGER, restart_count INTEGER, last_exit_code INTEGER,
pid INTEGER, log_path TEXT, created_at TEXT, updated_at TEXT,
last_output_at TEXT, last_attached_at TEXT

-- file_activities table
id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, file_path TEXT,
operation TEXT, timestamp TEXT

-- events table
id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, event_type TEXT,
payload TEXT, created_at TEXT
```

Database file location: `%APPDATA%/AgentDashboard/dashboard.db` (unchanged)

### 3.7 File Activity Tracker (`src/main/supervisor/file-activity-tracker.ts`)

**Ports to:** Supervisor daemon, unchanged

- Parses PTY output for file operations: `Read(filepath)`, `Edit(filepath)`, `Write(filepath)`
- Deduplication: Skip if same (agent, file, op) within 5s
- Relative path resolution against agent working directory
- Stores in `file_activities` table

### 3.8 PTY Host (`scripts/pty-host.js`)

**Ports to:** Ships with extension (or supervisor), unchanged

- Standalone Node.js script, not Electron-dependent
- JSON stdin/stdout protocol: spawn, write, resize, kill commands
- data, pid, exit, error responses
- Must NOT run under Electron's Node — uses standard Node.js with node-pty

### 3.9 Constants (`src/shared/constants.ts`)

All constants carry over:

```typescript
DEFAULT_COMMAND = 'claude --dangerously-skip-permissions --chrome'
DEFAULT_COMMAND_WSL = 'claude --dangerously-skip-permissions --chrome'
TMUX_SESSION_PREFIX = 'cad__'
STATUS_POLL_INTERVAL_MS = 2500
WORKING_THRESHOLD_MS = 30_000
LOG_DIR_NAME = 'agent-dashboard-logs'
```

### 3.10 Shared Types (`src/shared/types.ts`)

All type definitions carry over unchanged:

```typescript
type PathType = 'windows' | 'wsl'
type AgentStatus = 'launching' | 'working' | 'idle' | 'waiting' | 'done' | 'crashed' | 'restarting'
type FileOperation = 'read' | 'write' | 'create'

interface Workspace { id, title, path, pathType, description, defaultCommand, createdAt, updatedAt, lastOpenedAt }
interface Agent { id, workspaceId, title, slug, roleDescription, workingDirectory, command, tmuxSessionName, autoRestartEnabled, resumeSessionId, status, isAttached, restartCount, lastExitCode, pid, logPath, createdAt, updatedAt, lastOutputAt, lastAttachedAt }
interface FileActivity { id, agentId, filePath, operation, timestamp }
interface HealthCheck { wslAvailable, tmuxAvailable, claudeWindowsAvailable, claudeWslAvailable }
interface WorkspaceHeat { total, working, idle, crashed }
interface QueryResult { success, response?, error? }
```

---

## 4. New Components — What Gets Built

### 4.1 Supervisor Daemon

**Purpose:** Extract the current Electron main process into a standalone headless Node.js service.

**New functionality beyond current Electron main process:**
- WebSocket server on `localhost:<port>` (port stored in lockfile for extension discovery)
- Multi-client support — multiple VS Code windows can connect simultaneously
- Lockfile at `%APPDATA%/AgentDashboard/supervisor.lock` containing PID and port
- Graceful startup: Extension checks lockfile, pings daemon, starts it if not running
- Auto-shutdown: Optional, after configurable idle timeout with no connected clients and no active agents

**WebSocket API (replaces Electron IPC):**

The WebSocket protocol mirrors the existing IPC API exactly. Messages are JSON with a `type` field and a `requestId` for request/response correlation.

```typescript
// Request format
{ requestId: string, type: string, payload: any }

// Response format
{ requestId: string, type: string, payload: any, error?: string }

// Event format (server-pushed, no requestId)
{ event: string, payload: any }
```

**Request types (1:1 mapping from existing IPC handlers):**

```
workspace:list          -> Workspace[]
workspace:create        -> Workspace          (payload: CreateWorkspaceInput)
workspace:delete        -> void               (payload: { id })
agent:list              -> Agent[]            (payload: { workspaceId })
agent:list-all          -> Agent[]
agent:launch            -> Agent              (payload: LaunchAgentInput)
agent:stop              -> void               (payload: { id })
agent:restart           -> void               (payload: { id })
agent:get-log           -> string             (payload: { id, lines? })
agent:delete            -> void               (payload: { id })
agent:fork              -> Agent              (payload: { id })
agent:query             -> QueryResult        (payload: { targetId, question, sourceId? })
agent:send-input        -> void               (payload: { id, text })
agent:check-agent-md    -> { found, fileName } (payload: { workingDirectory, pathType })
agent:get-file-activities -> FileActivity[]   (payload: { agentId, operation? })
terminal:attach         -> void               (payload: { agentId })
terminal:detach         -> void               (payload: { agentId })
terminal:write          -> void               (payload: { agentId, data })
terminal:resize         -> void               (payload: { agentId, cols, rows })
system:health-check     -> HealthCheck
```

**Event types (server-pushed to all connected clients):**

```
agent:status-changed    -> { agentId, status, agent }
agent:file-activity     -> FileActivity
terminal:data           -> { agentId, data }
```

Terminal data events are scoped — only clients that have called `terminal:attach` for an agent receive that agent's terminal data. This prevents flooding all clients with all terminal output.

### 4.2 VS Code Extension Entry Point

**File:** `src/extension.ts`

**Activation events:**
- `onStartupFinished` — Always activate on VS Code launch (the dashboard is the home screen)

**On activation:**
1. Check for supervisor daemon (read lockfile, ping WebSocket)
2. If not running, spawn daemon as detached child process
3. Connect to daemon via WebSocket
4. Register all providers (dashboard webview, sidebar, terminal panel)
5. Register commands
6. Open the dashboard webview as the initial editor tab (pinned)
7. If a workspace folder is already open, switch to workspace mode for that folder

**On deactivation:**
1. Disconnect WebSocket (but don't kill daemon — agents keep running)
2. Dispose all providers

### 4.3 Dashboard Webview (Home Screen)

**Type:** `WebviewPanel` in editor area, pinned as first tab

**Purpose:** Fleet-wide view of all workspaces and agents. This is the "home screen" when no specific directory is active.

**Content:** The existing React dashboard UI, adapted for webview context. Includes:
- All workspaces displayed as cards/tiles with heat indicators
- Agent cards nested under each workspace showing status (launching/working/idle/waiting/done/crashed/restarting)
- Agent status badges with color coding and animations (same visual design as current app)
- Launch agent dialog (modal within the webview)
- Query dialog (modal within the webview)
- Drag-to-query between agent cards (within the webview)
- Fork agent via context menu
- Health check status display
- System load indicators

**Interactions:**
- **Double-click workspace** -> Triggers workspace mode switch (see Section 4.6)
- **Click agent card** -> Select agent, show details in sidebar or inline
- **Double-click agent card** -> Attach terminal in bottom panel
- **Right-click agent** -> Context menu: Fork, Stop, Restart, Delete
- **Drag agent onto agent** -> Query dialog
- **Click "+ New Agent"** -> Launch dialog
- **Click "+ New Workspace"** -> Workspace creation dialog

**Communication with extension:**
- Uses `vscode.webview.postMessage()` / `onDidReceiveMessage` for all actions
- Extension proxies commands to supervisor daemon via WebSocket
- Extension pushes status updates from daemon to webview

**Styling:**
The existing dark theme and color palette carries over. The webview loads its own CSS (Tailwind build output). The visual identity remains:
- Surface colors: `#0f0f15`, `#14141b`, `#1a1a22`, `#202028`
- Accent: cyan `#00f3ff`, green `#22c55e`, orange `#f9aa0a`, red `#ef4444`, yellow `#eab308`, purple `#a855f7`
- Glassmorphism, glow effects, monospace typography
- Framer Motion animations for card entrance/exit

### 4.4 Agent Sidebar Panel (Workspace Mode)

**Type:** `WebviewViewProvider` registered in the Activity Bar sidebar

**Purpose:** When in workspace mode (drilled into a specific directory), the sidebar shows agent cards for that directory only.

**Content:** A slimmed-down version of the dashboard showing:
- Agent cards for the active workspace only
- Status badges with real-time updates
- Launch new agent button
- Each card: title, status, role description, activity time, restart count
- Context menu per card: Fork, Stop, Restart, Delete, Query

**Interactions:**
- **Click agent card** -> Select agent, show detail info inline or in a secondary panel
- **Double-click agent card** -> Attach terminal in bottom panel webview
- **Right-click agent** -> Context menu actions
- **Click "Back to Dashboard"** -> Switch back to dashboard mode (see Section 4.6)

**The sidebar also shows in dashboard mode** with a different view: a workspace list with heat indicators, similar to the current Electron app's sidebar. The sidebar content switches based on mode.

### 4.5 Terminal Webview Panel (Bottom Panel)

**Type:** `WebviewPanel` positioned in the bottom panel area (where VS Code's integrated terminal normally lives)

**Purpose:** Renders agent terminal output using xterm.js, exactly like the current Electron app's terminal panel.

**Why not use VS Code's native terminal API:**
VS Code's `Terminal` API does not expose an `onData` event for reading stdout back. The `Pseudoterminal` API allows custom implementations but has limitations around scroll position tracking, custom styling, and the caching behavior the current app relies on. Using a webview with xterm.js gives full control and matches the existing implementation.

**Content:**
- xterm.js terminal emulator (same configuration as current app)
  - 5000-line scrollback
  - Cascadia Code / Consolas font
  - Dark background (#0a0a0f), light foreground (#e0e0e0)
  - Cursor blink enabled
  - Smooth scroll (150ms)
- Tab bar showing all agents for the active workspace (when in workspace mode) or the selected agent (when in dashboard mode)
- Scroll lock toggle
- Clear terminal button
- Scroll-to-bottom indicator when scrolled up
- Chat input bar for sending text to idle/waiting agents

**Terminal Caching:**
The existing terminal cache strategy carries over. Terminal instances (xterm.js `Terminal` objects) are cached in a `Map<agentId, CachedTerminal>` at the module level. When switching between agents, the DOM element is detached but the terminal is not disposed, preserving scrollback. When switching back, the element is reattached and `fitAddon.fit()` is called.

**Read-only by default:**
Terminal tabs display agent output but **do not** forward arbitrary keystrokes to the agent. User input goes through the structured chat input bar at the bottom of the terminal view, or through dashboard actions (query, send input). This preserves the dashboard as the single control plane for agent interaction and prevents unstructured input from confusing the status monitor.

**Escape hatch — manual takeover:**
A "Take Control" button on the terminal header switches the terminal to full read-write mode for that agent. A visual indicator (colored border, banner) shows the terminal is in manual mode. The status monitor pauses for that agent while in manual mode. Clicking "Release" returns to read-only dashboard-controlled mode.

### 4.6 Workspace Switcher (Mode Transitions)

**Purpose:** Manages the transition between dashboard mode and workspace mode, and between different workspaces in workspace mode.

**Dashboard Mode -> Workspace Mode (entering a directory):**

Triggered by double-clicking a workspace in the dashboard webview.

1. Save current state (which dashboard scroll position, etc.)
2. Call `vscode.workspace.updateWorkspaceFolders()`:
   - Remove all current workspace folders
   - Add the target directory as the only workspace folder
   - For WSL paths, use UNC format: `\\wsl.localhost\Ubuntu\<path>`
3. The file explorer automatically updates to show the new directory
4. Switch the sidebar from workspace-list view to agent-cards view (filtered to this workspace)
5. Switch the terminal webview to show this workspace's agents
6. The dashboard webview tab remains open but loses focus — a file or the sidebar takes focus
7. Store the active workspace ID in extension state

**Workspace Mode -> Dashboard Mode (going back):**

Triggered by clicking the dashboard webview tab, pressing a keyboard shortcut (configurable, default `Ctrl+Shift+D`), or clicking "Back to Dashboard" in the sidebar.

1. Save workspace view state to extension persistent storage:
   ```typescript
   {
     workspaceId: string,
     openEditorPaths: string[],     // paths of open editor tabs
     activeEditorPath: string,       // which tab was focused
     activeAgentId: string | null,   // which agent terminal was showing
     terminalScrollLock: boolean
   }
   ```
2. Close all editor tabs (or leave them — configurable preference)
3. Focus the dashboard webview panel (fullscreen editor area)
4. Switch sidebar back to workspace-list view
5. Optionally clear workspace folders (so file explorer is empty while on dashboard)

**Workspace Mode -> Different Workspace Mode (switching directories):**

1. Save current workspace view state (same as above)
2. Perform the workspace folder swap
3. Restore target workspace's saved view state if it exists:
   - Reopen previously open editor tabs
   - Focus the previously active editor
   - Reattach the previously active agent terminal
4. If no saved state, show a clean workspace view

**State persistence:**
Workspace view states are stored in `vscode.ExtensionContext.globalState` so they survive VS Code restarts. The active workspace ID is also persisted — on VS Code restart, the extension restores the last active mode (dashboard or specific workspace).

### 4.7 Commands and Keybindings

**Registered commands (via `package.json` `contributes.commands`):**

| Command ID | Title | Default Keybinding |
|---|---|---|
| `agentDashboard.openDashboard` | Agent Dashboard: Open Dashboard | `Ctrl+Shift+D` |
| `agentDashboard.launchAgent` | Agent Dashboard: Launch Agent | `Ctrl+Shift+L` |
| `agentDashboard.switchWorkspace` | Agent Dashboard: Switch Workspace | `Ctrl+Shift+W` |
| `agentDashboard.stopAgent` | Agent Dashboard: Stop Agent | None |
| `agentDashboard.restartAgent` | Agent Dashboard: Restart Agent | None |
| `agentDashboard.forkAgent` | Agent Dashboard: Fork Agent | None |
| `agentDashboard.queryAgent` | Agent Dashboard: Query Agent | None |
| `agentDashboard.toggleTerminal` | Agent Dashboard: Toggle Terminal Panel | `Ctrl+\`` |
| `agentDashboard.nextAgent` | Agent Dashboard: Next Agent Terminal | `Ctrl+Tab` (in terminal) |
| `agentDashboard.prevAgent` | Agent Dashboard: Previous Agent Terminal | `Ctrl+Shift+Tab` (in terminal) |

`switchWorkspace` opens a VS Code QuickPick listing all workspaces, allowing fast keyboard-driven switching without going back to the dashboard.

### 4.8 Configuration Settings

**Registered settings (via `package.json` `contributes.configuration`):**

```jsonc
{
  "agentDashboard.supervisorPort": {
    "type": "number",
    "default": 0,
    "description": "Fixed port for supervisor daemon. 0 = auto-assign."
  },
  "agentDashboard.defaultCommand": {
    "type": "string",
    "default": "claude --dangerously-skip-permissions --chrome",
    "description": "Default command for launching agents."
  },
  "agentDashboard.defaultCommandWsl": {
    "type": "string",
    "default": "claude --dangerously-skip-permissions --chrome",
    "description": "Default command for launching WSL agents."
  },
  "agentDashboard.autoStartSupervisor": {
    "type": "boolean",
    "default": true,
    "description": "Automatically start the supervisor daemon on extension activation."
  },
  "agentDashboard.closeEditorsOnWorkspaceSwitch": {
    "type": "boolean",
    "default": false,
    "description": "Close all editor tabs when switching workspaces. If false, tabs are saved and restored."
  },
  "agentDashboard.terminalScrollback": {
    "type": "number",
    "default": 5000,
    "description": "Maximum scrollback lines per agent terminal."
  },
  "agentDashboard.showDashboardOnStartup": {
    "type": "boolean",
    "default": true,
    "description": "Open the dashboard view when VS Code starts."
  }
}
```

---

## 5. Extension Project Structure

```
vscode-agent-dashboard/
├── package.json                          # Extension manifest, contributes, activation events
├── tsconfig.json
├── webpack.config.js                     # Bundle extension + webview separately
│
├── src/
│   ├── extension.ts                      # activate(), deactivate()
│   │
│   ├── daemon/                           # Supervisor daemon (standalone process)
│   │   ├── index.ts                      # Entry point, WebSocket server setup
│   │   ├── supervisor.ts                 # AgentSupervisor (ported from Electron)
│   │   ├── windows-runner.ts             # (ported)
│   │   ├── wsl-runner.ts                 # (ported)
│   │   ├── status-monitor.ts            # (ported)
│   │   ├── file-activity-tracker.ts      # (ported)
│   │   ├── wsl-bridge.ts                # (ported)
│   │   ├── database.ts                  # (ported)
│   │   └── path-utils.ts               # (ported)
│   │
│   ├── client/                           # Extension-side supervisor client
│   │   ├── supervisor-client.ts          # WebSocket client, reconnect logic
│   │   └── daemon-manager.ts             # Start/stop/discover daemon process
│   │
│   ├── providers/                        # VS Code UI providers
│   │   ├── dashboard-webview.ts          # WebviewPanel for dashboard home
│   │   ├── sidebar-view.ts              # WebviewViewProvider for Activity Bar
│   │   ├── terminal-panel.ts            # WebviewPanel for bottom terminal area
│   │   └── workspace-switcher.ts         # Folder swap + state save/restore
│   │
│   ├── commands/                         # Command registrations
│   │   └── index.ts                      # All registerCommand calls
│   │
│   └── shared/                           # Shared between extension and daemon
│       ├── types.ts                      # (ported from Electron)
│       ├── constants.ts                  # (ported from Electron)
│       └── protocol.ts                   # WebSocket message type definitions
│
├── webview/                              # React app for webviews (separate build)
│   ├── src/
│   │   ├── dashboard/                    # Dashboard home screen
│   │   │   ├── App.tsx
│   │   │   ├── WorkspaceCard.tsx
│   │   │   ├── AgentCard.tsx             # (adapted from Electron renderer)
│   │   │   ├── AgentLaunchDialog.tsx     # (adapted)
│   │   │   ├── QueryDialog.tsx           # (adapted)
│   │   │   ├── StatusBadge.tsx           # (adapted)
│   │   │   └── store.ts                  # Zustand store (adapted)
│   │   │
│   │   ├── sidebar/                      # Sidebar agent list + workspace list
│   │   │   ├── App.tsx
│   │   │   ├── AgentList.tsx
│   │   │   ├── WorkspaceList.tsx
│   │   │   └── store.ts
│   │   │
│   │   ├── terminal/                     # Terminal bottom panel
│   │   │   ├── App.tsx
│   │   │   ├── TerminalView.tsx          # (adapted from TerminalPanel.tsx)
│   │   │   ├── DetailPaneLog.tsx         # (adapted)
│   │   │   └── store.ts
│   │   │
│   │   └── shared/
│   │       ├── vscode-api.ts             # acquireVsCodeApi() wrapper
│   │       ├── types.ts                  # Shared types
│   │       └── theme.css                 # Tailwind + custom theme
│   │
│   ├── tailwind.config.js
│   └── vite.config.ts                    # Builds 3 entry points (dashboard, sidebar, terminal)
│
├── scripts/
│   └── pty-host.js                       # (ported, unchanged)
│
└── resources/
    ├── icon.png                          # Activity Bar icon
    └── icon-dark.png
```

### 5.1 Build Pipeline

The project has two separate build targets:

1. **Extension bundle** (`src/`) — Compiled with webpack/esbuild into a single `dist/extension.js`. The daemon code compiles to a separate `dist/daemon.js` entry point.

2. **Webview bundles** (`webview/`) — Built with Vite into `dist/webview/dashboard/`, `dist/webview/sidebar/`, `dist/webview/terminal/`. Each produces an `index.html` + JS/CSS bundle. These are loaded into webviews via `webview.html` with appropriate CSP headers and `asWebviewUri()` for resource paths.

---

## 6. Communication Flow

### 6.1 Extension <-> Supervisor Daemon

```
Extension                         Daemon
    |                                |
    |-- ws connect ----------------->|
    |                                |
    |-- { type: "agent:list-all" } ->|
    |<- { payload: Agent[] } --------|
    |                                |
    |-- { type: "terminal:attach",   |
    |    payload: { agentId } } ---->|
    |<- { event: "terminal:data",    |
    |    payload: { agentId, data }} |  (streaming)
    |<- { event: "terminal:data" } --|  (streaming)
    |                                |
    |<- { event: "agent:status-      |
    |    changed", payload } --------|  (push)
    |                                |
```

### 6.2 Extension <-> Webview

```
Extension Host                    Webview (React)
    |                                |
    |<- postMessage({ cmd:           |
    |    "launchAgent", ... }) ------|  (user action)
    |                                |
    |-- (proxy to daemon) ---------> |
    |                                |
    |-- postMessage({ event:         |
    |    "agentUpdated", agent }) --->|  (state update)
    |                                |
```

### 6.3 Full Round Trip Example: User Launches Agent

1. User clicks "Launch Agent" in dashboard webview
2. Fills in launch dialog, clicks Launch
3. Webview sends `postMessage({ cmd: 'agent:launch', payload: { title, command, workspaceId, ... } })`
4. Extension's `onDidReceiveMessage` handler receives it
5. Extension sends WebSocket message to daemon: `{ type: 'agent:launch', payload: { ... } }`
6. Daemon's supervisor creates DB record, spawns runner, returns new Agent object
7. Daemon sends WebSocket response: `{ type: 'agent:launch', payload: agent }`
8. Daemon also broadcasts: `{ event: 'agent:status-changed', payload: { agentId, status: 'launching', agent } }`
9. Extension receives response, forwards to webview: `postMessage({ event: 'agentLaunched', agent })`
10. Extension also receives status event, forwards to webview: `postMessage({ event: 'agentStatusChanged', ... })`
11. Webview Zustand store updates, React re-renders agent card with new status

---

## 7. Agent Lifecycle (Unchanged from Electron)

For reference, the complete agent lifecycle as it exists today and will continue to work:

### 7.1 Agent States

```
launching -> working -> idle -> working -> idle -> ... -> done
                |                                          |
                v                                          v
             crashed --> (auto-restart) --> restarting --> launching
                |
                v (after 5 retries)
             crashed (final)
```

### 7.2 Launch Flow

1. Generate agent ID (UUID), session ID (UUID), slug (from title)
2. Create log file: `%APPDATA%/AgentDashboard/logs/<agentId>.log`
3. Insert agent record in DB (status = 'launching')
4. Load `agent.md` or `AGENT.md` from working directory (cap 10KB)
5. Determine path type (Windows vs WSL) from workspace
6. **WSL path:**
   - Create tmux session: `tmux new-session -d -s 'cad__<slug>__<id8>' -c '<workdir>'`
   - Send command: `tmux send-keys -t '<session>' '<command> --session-id <sessionId> <agent.md content>' Enter`
   - Spawn PTY host: `wsl.exe bash -lc "tmux attach -t '<session>'"`
7. **Windows path:**
   - Spawn PTY host: `node pty-host.js`
   - Send spawn command: `{ cmd: 'spawn', args: ['claude', ...flags], cwd: '<workdir>' }`
8. Register runner in supervisor maps
9. Start status monitoring
10. Start file activity tracking on PTY output
11. Update status to 'working'
12. Emit `statusChanged` event

### 7.3 Auto-Restart Flow

1. Runner emits 'exit' with non-zero code
2. Supervisor sets status to 'crashed'
3. If `autoRestartEnabled` and `restartCount < 5`:
   - Wait 2 seconds
   - Set status to 'restarting'
   - Increment restart count
   - Relaunch with `--continue` flag (resumes conversation)
4. If `restartCount >= 5`:
   - Emit `restart_limit_reached` event
   - Leave in 'crashed' status

### 7.4 Reconciliation Flow (Daemon Startup)

1. Query DB for agents with status NOT IN ('done', 'crashed')
2. For each active agent:
   - Check if tmux session exists: `tmux has-session -t '<session>'`
   - If session alive: Spawn PTY host to reattach, resume monitoring
   - If session dead: Set status to 'crashed'
3. Check for orphaned `cad__*` tmux sessions not in DB (log warning)

### 7.5 Inter-Agent Query Flow

1. Source agent (or user) initiates query to target agent
2. Supervisor spawns isolated Claude process:
   ```
   claude --resume <targetSessionId> --fork-session --max-turns 1 --output-format json
   ```
   With prompt: identity-anchored question text
3. 60-second timeout
4. Parse JSON response (try clean parse, fallback to scanning for last `{` line)
5. If `sourceId` provided: inject response into source agent's terminal via `tmux send-keys`
6. Return `QueryResult { success, response?, error? }`

### 7.6 Fork Flow

1. User requests fork of agent A
2. Generate new agent ID and session ID
3. Create new agent record in DB with title `"<original title> (fork)"`
4. Launch new agent with:
   ```
   claude --resume <sourceSessionId> --fork-session --session-id <newSessionId>
   ```
5. New agent carries conversation history from source
6. Both agents continue independently

---

## 8. UI Specifications

### 8.1 Dashboard Webview (Home Screen)

The dashboard webview occupies the full editor area. It is the first thing the user sees when VS Code opens (if `showDashboardOnStartup` is true).

**Layout:**

```
+--------------------------------------------------------------+
| AGENT DASHBOARD                          [Health: W L T] [+] |
+--------------------------------------------------------------+
|                                                              |
|  +------------------+  +------------------+  +-------------+ |
|  | project-alpha    |  | project-beta     |  | project-    | |
|  | /home/user/alpha |  | /home/user/beta  |  | gamma       | |
|  | [WSL]            |  | [WSL]            |  | [WIN]       | |
|  |                  |  |                  |  |             | |
|  | +------+ +-----+|  | +------+         |  | +------+   | |
|  | |coder | |test ||  | |refact|         |  | |writer|   | |
|  | |●BUSY | |○IDLE||  | |●BUSY |         |  | |○IDLE |   | |
|  | +------+ +-----+|  | +------+         |  | +------+   | |
|  | +------+ +-----+|  |                  |  |             | |
|  | |docs  | |lint ||  |                  |  |             | |
|  | |○IDLE | |✓DONE||  |                  |  |             | |
|  | +------+ +-----+|  |                  |  |             | |
|  +------------------+  +------------------+  +-------------+ |
|                                                              |
+--------------------------------------------------------------+
```

Each workspace card shows:
- Workspace title and path
- Path type badge (WSL / WINDOWS)
- Heat indicator (color-coded border or dot based on agent activity)
- Nested agent mini-cards with status badges
- Double-click to enter workspace mode

### 8.2 Sidebar (Workspace Mode)

When drilled into a workspace, the Activity Bar sidebar shows:

```
+-------------------+
| < DASHBOARD       |
| project-alpha     |
| /home/user/alpha  |
+-------------------+
| AGENTS (4)        |
|                   |
| [coder]       ●B  |
| refactoring utils |
| 2m ago            |
|                   |
| [tester]      ○I  |
| running tests     |
| 5m ago            |
|                   |
| [docs]        ○I  |
| updating readme   |
| 12m ago           |
|                   |
| [linter]      ✓D  |
| code review done  |
| 1h ago            |
|                   |
| [+ Launch Agent]  |
+-------------------+
| DETAILS           |
| Agent: coder      |
| Status: BUSY      |
| PID: 12345        |
| Session: a1b2...  |
| Restarts: 0       |
|                   |
| [Stop] [Restart]  |
| [Fork] [Query]    |
+-------------------+
```

### 8.3 Terminal Panel (Bottom)

```
+--------------------------------------------------------------+
| [coder] [tester] [docs] [linter]     [Lock] [Clear] [Take]  |
+--------------------------------------------------------------+
|                                                              |
| ● Analyzing src/utils/parser.ts                              |
|   ⎿ Read src/utils/parser.ts (245 lines)                    |
|                                                              |
| I'll refactor the parser to use a visitor pattern...         |
|                                                              |
| ● Edit(src/utils/parser.ts)                                 |
|   ⎿ Updated parseExpression() to use visitor dispatch        |
|                                                              |
| ● Read(tests/parser.test.ts)                                |
|   ⎿ Read tests/parser.test.ts (180 lines)                   |
|                                                              |
|                                                  [v Scroll]  |
+--------------------------------------------------------------+
| > Type a message... (agent is idle)              [Send]      |
+--------------------------------------------------------------+
```

### 8.4 Visual Theme

All existing theme values from the Electron app carry over into the webview CSS:

```css
:root {
  --surface-0: #0f0f15;
  --surface-1: #14141b;
  --surface-2: #1a1a22;
  --surface-3: #202028;
  --accent-blue: #00f3ff;
  --accent-green: #22c55e;
  --accent-orange: #f9aa0a;
  --accent-red: #ef4444;
  --accent-yellow: #eab308;
  --accent-purple: #a855f7;
}
```

Glassmorphism, glow effects, monospace typography, decorative corner lines, scan-line overlays — all preserved. The webview has full CSS control; it does not use VS Code's theme variables (the dashboard has its own aesthetic).

---

## 9. Edge Cases and Error Handling

### 9.1 Supervisor Daemon Not Running

- Extension shows "Connecting to supervisor..." in dashboard
- Attempts to start daemon automatically
- If daemon fails to start (port conflict, missing Node.js, etc.), show error with manual start instructions
- Dashboard webview shows offline state with retry button

### 9.2 Multiple VS Code Windows

- Each window's extension instance connects to the same daemon
- All receive the same status events
- If Window A launches an agent, Window B sees it appear in real time
- If Window A and Window B both have the same workspace open, both show the same agents
- Terminal attachment is per-client — Window A can be attached to agent 1 while Window B is attached to agent 2
- No conflicts because the daemon serializes all state changes

### 9.3 Workspace Folder Already Open

- If VS Code opens with a folder already set (e.g., from "Open Folder"), the extension checks if that folder matches a known workspace
- If yes, auto-switch to workspace mode for that directory
- If no, show dashboard mode and offer to create a workspace for the open folder

### 9.4 UNC Path Failures

- `\\wsl.localhost\Ubuntu\...` paths fail when WSL is not running or after a connection drop
- File explorer shows "Unable to resolve" errors (VS Code native behavior)
- Dashboard remains functional — agent management doesn't require file access
- Extension shows an inline notification: "WSL file access unavailable — agents are still running"

### 9.5 Agent Log File Access

- Log files stored on Windows side (`%APPDATA%/AgentDashboard/logs/`)
- Always accessible regardless of WSL state
- Dashboard log viewer continues working even during WSL outages

### 9.6 Port Conflicts for Daemon

- Daemon lockfile (`%APPDATA%/AgentDashboard/supervisor.lock`) stores `{ pid, port, startedAt }`
- Extension reads lockfile first, attempts WebSocket connection
- If connection fails but lockfile exists, check if PID is alive
- If PID dead, delete stale lockfile and start new daemon
- If configured port is in use, fall back to auto-assign (port 0)

### 9.7 Extension Update / Reload

- `vscode.commands.executeCommand('workbench.action.reloadWindow')` kills the extension host
- Daemon keeps running (separate process)
- On reload, extension reconnects to existing daemon
- All agent state preserved

---

## 10. Migration Path

### Phase 1: Extract Supervisor Daemon

Take the existing Electron main process code and restructure it as a standalone Node.js process with a WebSocket server. This is mostly reorganization — the logic is identical.

**Input:** Current `src/main/` directory from Electron app
**Output:** `src/daemon/` directory with WebSocket server wrapping existing supervisor logic

**Validation:** Daemon starts, agents can be launched via WebSocket messages (test with a simple script client), tmux sessions persist, status monitoring works.

### Phase 2: Scaffold VS Code Extension

Create the extension manifest, activation logic, daemon manager (auto-start/discover), and WebSocket client.

**Validation:** Extension activates, starts daemon, connects via WebSocket, can list workspaces/agents.

### Phase 3: Dashboard Webview

Port the React dashboard UI into a webview. Adapt the Zustand store to use webview message passing instead of `window.api` IPC calls. The UI components (AgentCard, StatusBadge, QueryDialog, etc.) carry over with minimal changes — primarily replacing `window.api.*` calls with `vscode.postMessage()`.

**Validation:** Dashboard shows in VS Code editor area, displays workspaces and agents, launch/stop/restart work.

### Phase 4: Terminal Webview

Port the terminal panel into a bottom-area webview. xterm.js setup is identical. Wire terminal data streaming through the WebSocket.

**Validation:** Click agent card, terminal appears in bottom panel, output streams live, scroll lock works, chat input works.

### Phase 5: Sidebar + Workspace Switching

Build the sidebar provider and workspace switcher. Implement folder swap logic, view state save/restore, and mode transitions.

**Validation:** Double-click workspace in dashboard -> file explorer shows that directory, sidebar shows that workspace's agents, terminal shows that workspace's agents. Navigate back to dashboard. Switch between workspaces.

### Phase 6: Polish and Edge Cases

- Keyboard shortcuts
- QuickPick workspace switcher
- Multi-window support testing
- WSL drop/reconnect testing
- Daemon lifecycle (auto-start, stale lockfile cleanup, graceful shutdown)
- Extension settings
- VS Code marketplace packaging

---

## 11. Technical Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Webview in bottom panel area may not be positionable exactly where native terminal lives | Terminal appears in wrong location or requires manual dragging | Use `createWebviewPanel` with `ViewColumn.Two` or register as a Panel view. Worst case: user drags panel once, VS Code remembers position. |
| `updateWorkspaceFolders()` may prompt user for confirmation on first use | Breaks seamless switching flow | Test behavior, potentially pre-authorize via workspace trust settings. Worst case: user clicks "Yes" once. |
| xterm.js in webview may have CSP conflicts | Terminal doesn't render | Configure webview CSP to allow inline styles and blob URLs that xterm.js requires. Known solved problem. |
| Daemon WebSocket port discovery race condition on startup | Extension can't connect immediately | Retry with exponential backoff (100ms, 200ms, 400ms...) up to 10 seconds. Daemon writes lockfile before accepting connections. |
| Terminal data volume over WebSocket | High CPU/memory for active agents | Binary WebSocket frames for terminal data (not JSON-encoded). Only stream data for attached agents. Backpressure if client falls behind. |
| `node-pty` native module in daemon | Build/distribution complexity | Daemon uses `pty-host.js` which already isolates node-pty in a subprocess. Daemon itself doesn't link node-pty directly. Ship pre-built pty-host with appropriate Node.js version. |

---

## 12. Success Criteria

1. **Single window:** User can manage all workspaces and agents from one VS Code window without opening any other windows.
2. **WSL resilient:** Simulated WSL connection drop (kill WSL networking for 30s) does not crash agents, does not crash the dashboard, and recovers automatically.
3. **Feature parity:** All current Electron app features work: launch, stop, restart, fork, query, auto-restart, reconciliation, file activity tracking, agent registry, health checks.
4. **File browsing:** User can browse and edit files in any workspace directory using VS Code's native file explorer and editor.
5. **Workspace switching:** User can switch between workspaces in under 2 seconds (folder swap + sidebar/terminal update).
6. **Multi-window safe:** Opening a second VS Code window doesn't cause conflicts — both connect to the same daemon and show consistent state.
7. **Daemon independence:** Closing all VS Code windows does not stop running agents. Reopening VS Code reconnects to existing agents.

---

## Appendix A: Existing Electron Components Reference

For implementers porting from the Electron codebase, here is the mapping of source files:

| Electron Source | Extension Destination | Notes |
|---|---|---|
| `src/main/supervisor/index.ts` | `src/daemon/supervisor.ts` | Core logic unchanged, add WebSocket event broadcasting |
| `src/main/supervisor/wsl-runner.ts` | `src/daemon/wsl-runner.ts` | Unchanged |
| `src/main/supervisor/windows-runner.ts` | `src/daemon/windows-runner.ts` | Unchanged |
| `src/main/supervisor/status-monitor.ts` | `src/daemon/status-monitor.ts` | Unchanged |
| `src/main/supervisor/file-activity-tracker.ts` | `src/daemon/file-activity-tracker.ts` | Unchanged |
| `src/main/wsl-bridge.ts` | `src/daemon/wsl-bridge.ts` | Unchanged |
| `src/main/database.ts` | `src/daemon/database.ts` | Unchanged |
| `src/main/path-utils.ts` | `src/daemon/path-utils.ts` | Unchanged |
| `src/main/ipc-handlers.ts` | `src/daemon/index.ts` | Replace IPC handlers with WebSocket message handlers (same logic, different transport) |
| `src/preload/index.ts` | Deleted | Replaced by WebSocket protocol |
| `src/main/index.ts` | `src/daemon/index.ts` | Replace Electron BrowserWindow with WebSocket server |
| `src/shared/types.ts` | `src/shared/types.ts` | Unchanged |
| `src/shared/constants.ts` | `src/shared/constants.ts` | Unchanged |
| `src/renderer/App.tsx` | `webview/src/dashboard/App.tsx` | Replace `window.api` calls with `postMessage`, remove Electron-specific bootstrap |
| `src/renderer/stores/dashboard-store.ts` | `webview/src/dashboard/store.ts` | Replace `window.api` calls with `postMessage` |
| `src/renderer/components/agent/AgentCard.tsx` | `webview/src/dashboard/AgentCard.tsx` | Largely unchanged, adapt event handlers |
| `src/renderer/components/agent/QueryDialog.tsx` | `webview/src/dashboard/QueryDialog.tsx` | Unchanged |
| `src/renderer/components/agent/StatusBadge.tsx` | `webview/src/dashboard/StatusBadge.tsx` | Unchanged |
| `src/renderer/components/terminal/TerminalPanel.tsx` | `webview/src/terminal/TerminalView.tsx` | Same xterm.js setup, wire data through postMessage instead of IPC |
| `src/renderer/components/layout/Sidebar.tsx` | `webview/src/sidebar/WorkspaceList.tsx` | Adapted for sidebar webview |
| `src/renderer/components/layout/MainContent.tsx` | `webview/src/dashboard/App.tsx` | Merged into dashboard layout |
| `src/renderer/components/layout/DetailPanel.tsx` | `webview/src/sidebar/AgentList.tsx` | Split: detail info in sidebar, logs in terminal panel |
| `src/renderer/components/detail/DetailPaneLog.tsx` | `webview/src/terminal/DetailPaneLog.tsx` | Moved to terminal panel webview |
| `src/renderer/styles/globals.css` | `webview/src/shared/theme.css` | Unchanged (Tailwind config + custom properties) |
| `scripts/pty-host.js` | `scripts/pty-host.js` | Unchanged |

## Appendix B: WebSocket Protocol Reference

Complete message type definitions for the daemon WebSocket API:

```typescript
// --- Protocol envelope types ---

interface WsRequest {
  requestId: string        // UUID, for correlating response
  type: string             // e.g. "agent:launch"
  payload: any
}

interface WsResponse {
  requestId: string        // Matches the request
  type: string
  payload: any
  error?: string           // Present if request failed
}

interface WsEvent {
  event: string            // e.g. "agent:status-changed"
  payload: any
}

// --- Request/Response payload types ---

// workspace:list
// Request payload: (none)
// Response payload: Workspace[]

// workspace:create
// Request payload: { title: string, path: string, pathType: PathType, description?: string, defaultCommand?: string }
// Response payload: Workspace

// workspace:delete
// Request payload: { id: string }
// Response payload: (none)

// agent:list
// Request payload: { workspaceId: string }
// Response payload: Agent[]

// agent:list-all
// Request payload: (none)
// Response payload: Agent[]

// agent:launch
// Request payload: { workspaceId: string, title: string, command?: string, roleDescription?: string, workingDirectory?: string, autoRestartEnabled?: boolean }
// Response payload: Agent

// agent:stop
// Request payload: { id: string }
// Response payload: (none)

// agent:restart
// Request payload: { id: string }
// Response payload: (none)

// agent:delete
// Request payload: { id: string }
// Response payload: (none)

// agent:fork
// Request payload: { id: string }
// Response payload: Agent

// agent:query
// Request payload: { targetId: string, question: string, sourceId?: string }
// Response payload: QueryResult

// agent:send-input
// Request payload: { id: string, text: string }
// Response payload: (none)

// agent:get-log
// Request payload: { id: string, lines?: number }
// Response payload: string

// agent:check-agent-md
// Request payload: { workingDirectory: string, pathType: PathType }
// Response payload: { found: boolean, fileName: string | null }

// agent:get-file-activities
// Request payload: { agentId: string, operation?: FileOperation }
// Response payload: FileActivity[]

// terminal:attach
// Request payload: { agentId: string }
// Response payload: (none)
// Side effect: Client begins receiving terminal:data events for this agent

// terminal:detach
// Request payload: { agentId: string }
// Response payload: (none)
// Side effect: Client stops receiving terminal:data events for this agent

// terminal:write
// Request payload: { agentId: string, data: string }
// Response payload: (none)

// terminal:resize
// Request payload: { agentId: string, cols: number, rows: number }
// Response payload: (none)

// system:health-check
// Request payload: (none)
// Response payload: HealthCheck

// --- Event payload types ---

// agent:status-changed
// Payload: { agentId: string, status: AgentStatus, agent: Agent }

// agent:file-activity
// Payload: FileActivity

// terminal:data
// Payload: { agentId: string, data: string }
// Note: Only sent to clients that have terminal:attach for this agentId
```

## Appendix C: Lockfile Specification

**Path:** `%APPDATA%/AgentDashboard/supervisor.lock`

**Format:** JSON

```json
{
  "pid": 12345,
  "port": 47832,
  "startedAt": "2026-03-14T10:30:00.000Z",
  "version": "0.2.0"
}
```

**Lifecycle:**
1. Daemon writes lockfile immediately on startup, before accepting connections
2. Daemon deletes lockfile on graceful shutdown
3. Extension reads lockfile to discover daemon
4. If lockfile exists but PID is dead (checked via `process.kill(pid, 0)`), lockfile is stale — delete and restart daemon
5. If lockfile version doesn't match extension version, warn user (daemon may need restart for compatibility)
