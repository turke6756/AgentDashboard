# Product Requirements Document
## Project: Workspace-Centric Claude Agent Dashboard
### Platform: Windows + WSL2
### Runtime backbone: tmux + Claude Code
### Document version: v1.0
### Status: MVP in progress
### Last updated: 2026-03-11

---

## 0. Implementation Status

### Architecture Decisions Made
- **Desktop shell**: Electron (chosen over Tauri for better terminal embedding / node-pty support)
- **Frontend**: React + Tailwind CSS v4 (CSS-first config) + Framer Motion + Zustand
- **Bundler**: Vite for renderer, tsc for main process
- **Persistence**: sql.js (pure JS SQLite — avoids native compilation since no VS Build Tools)
- **Terminal**: xterm.js + node-pty via pty-host.js bridge process (node-pty can't run inside Electron without VS Build Tools rebuild, so a separate Node.js child process hosts the PTY)
- **Windows agents**: Spawn via pty-host.js → cmd.exe /c → claude (node-pty needs cmd.exe to resolve PATH)
- **WSL agents**: tmux sessions via wsl.exe bash -lc
- **CLAUDECODE env var**: Must be stripped from all child process environments to avoid "nested session" detection

### Key Files
- `src/main/index.ts` — Electron app entry point
- `src/main/supervisor/index.ts` — AgentSupervisor orchestrator
- `src/main/supervisor/windows-runner.ts` — Windows PTY runner (via pty-host bridge)
- `src/main/supervisor/wsl-runner.ts` — WSL/tmux runner
- `src/main/supervisor/status-monitor.ts` — Polls agent status every 2.5s
- `src/main/database.ts` — sql.js SQLite persistence (async init)
- `src/main/ipc-handlers.ts` — All IPC handlers for renderer ↔ main
- `src/main/wsl-bridge.ts` — WSL/tmux command execution
- `src/main/path-utils.ts` — Windows ↔ WSL path translation
- `scripts/pty-host.js` — Standalone Node.js process hosting node-pty (runs outside Electron)
- `src/preload/index.ts` — Context bridge exposing IpcApi
- `src/renderer/App.tsx` — Three-column layout (sidebar, main, detail) + terminal panel
- `src/renderer/stores/dashboard-store.ts` — Zustand store
- `src/shared/types.ts` — All shared TypeScript types
- `src/shared/constants.ts` — Config constants (thresholds, default command, etc.)
- `tsconfig.main.json` — rootDir: "src", outDir: "dist/main" (output mirrors src structure)
- `package.json` — main: "dist/main/main/index.js"

### Build & Run
```bash
npx tsc -p tsconfig.main.json && npx vite build   # build
npx electron .                                       # run
```

### Completed MVP Requirements

| Requirement | Description | Status |
|---|---|---|
| FR-MVP-1 | Create workspace from directory path | DONE |
| FR-MVP-2 | Browse directories (Windows + WSL paths) | DONE |
| FR-MVP-4 | Launch agent with title, role, directory, command, auto-restart | DONE |
| FR-MVP-5 | Unique session per agent (tmux for WSL, pty-host for Windows) | DONE |
| FR-MVP-6 | Agent metadata persistence (SQLite) | DONE |
| FR-MVP-7 | Stop agent | DONE |
| FR-MVP-8 | Restart agent | DONE |
| FR-MVP-9 | Dashboard card view with status, role, directory, restart count | DONE |
| FR-MVP-10 | Status states: working, idle, done, crashed, restarting | DONE (partial — see remaining) |
| FR-MVP-12 | Recent output preview in detail panel | DONE |
| FR-MVP-14 | One-click attach (double-click agent card) | DONE |
| FR-MVP-15 | Embedded xterm.js terminal panel | DONE |
| FR-MVP-16 | Detach from session (close terminal panel) | DONE |
| FR-MVP-18 | Auto-restart on crash (up to 5 retries, 2s delay) | DONE |
| FR-MVP-19 | Resume-aware relaunch (uses `--continue` flag) | DONE |
| FR-MVP-20 | Restarting state visibility | DONE |
| FR-MVP-21 | Crash record (exit code, restart count, events table) | DONE |
| FR-MVP-22 | Workspace list in sidebar | DONE |
| FR-MVP-23 | Workspace tab/pane navigation | DONE |
| FR-MVP-24 | Workspace header with title, path, launch button | DONE |
| NFR-1 | App survives restart, reconciles agents with `--continue` | DONE |
| NFR-4 | Local-first, no cloud dependency | DONE |
| NFR-6 | Safe Windows/WSL path handling | DONE |
| NFR-7 | App restart reconciles and relaunches agents | DONE |

### Remaining MVP Requirements — NOT YET DONE

| Requirement | Description | Notes |
|---|---|---|
| FR-MVP-3 | Open workspace in VS Code | Backend `openInVSCode()` exists in `src/main/vscode-launcher.ts`, IPC handler wired, but UI button may not be connected or tested. Needs: verify sidebar/header button triggers `workspace:open-vscode` IPC. |
| FR-MVP-10 partial | "Waiting" status (Claude requesting user input) | Status monitor in `status-monitor.ts` does not detect "waiting" state. Needs: scan recent output for Claude's input prompt patterns (e.g., `?`, `(y/n)`, permission prompts). Add to `inferStatus()`. |
| FR-MVP-11 | Improved state inference with prompt markers | Related to "waiting" state above. The `inferStatus()` method in `status-monitor.ts` currently only checks alive + last output time. Needs: pattern matching on recent output content. |
| FR-MVP-13 | Dedicated agent log view | Detail panel shows last ~20 lines polled every 3s. No dedicated scrollable log panel. Needs: a full-screen or expanded log viewer component. |
| FR-MVP-17 | Attach indicator on agent cards | Database tracks `attached` boolean via `updateAgentAttached()`, but `AgentCard.tsx` and `StatusBadge.tsx` don't display it. Needs: visual indicator (e.g., eye icon or border glow) when agent is attached. |
| Sidebar filters | All agents / crashed / waiting quick filters | Sidebar has workspace list but no status-based filters. PRD section 20.1 specifies: all agents, crashed agents, waiting agents filters. |
| Workspace delete UI | Remove workspaces from UI | `deleteWorkspace()` exists in database, IPC handler `workspace:delete` is registered, but no UI button/confirmation dialog. |
| Health check UI | Show WSL/tmux/claude availability on startup | `system:health-check` IPC returns `{ wslAvailable, tmuxAvailable, claudeWindowsAvailable, claudeWslAvailable }`. No UI displays this. Needs: startup banner or settings panel showing system status. |
| FR-MVP-24 partial | Active agent count in workspace header | Header shows title/path but not active agent count. |
| Workspace fields | Visual theme, description, last opened timestamp | `createWorkspace` doesn't capture all PRD fields (theme, description). These are optional/cosmetic. |

### Known Issues & Gotchas
- `tsconfig.main.json` uses `rootDir: "src"`, so `src/main/index.ts` compiles to `dist/main/main/index.js` — all relative paths from `__dirname` must account for this extra nesting
- `scripts/pty-host.js` is at project root, 4 levels up from `dist/main/main/supervisor/`
- node-pty on Windows can't resolve commands from PATH directly — pty-host wraps commands in `cmd.exe /c` for Windows
- Status "working" uses output volume heuristic (>200 bytes in 3s window) to avoid false positives from terminal escape sequences and keystroke echo
- Status changes are debounced (5s hold) to prevent rapid flipping

---

## 1. Executive Summary

This product is a desktop dashboard for launching, supervising, monitoring, recovering, and re-entering multiple Claude Code agents across multiple working directories on a Windows machine using WSL2.

The system uses **tmux inside WSL** as the reliability and process-management layer, while the dashboard provides a visual control plane for:

- launching agents in different directories
- setting per-agent permissions and launch flags
- organizing agents by workspace or directory
- seeing detached agents without losing the ability to reattach to the real live Claude Code session
- detecting agent states such as working, idle, waiting, done, restarting, or crashed
- auto-restarting agents after failure
- restoring agent context using Claude resume/session identifiers where supported
- opening related workspaces in VS Code
- visually managing many agents at once in a high-information, visually rich interface

This is not just a tmux wrapper. It is a **workspace-centric local multi-agent operations console**.

---

## 2. Problem Statement

Current Claude Code workflows in WSL are fragile and inefficient when running multiple agents simultaneously.

### Current pain points

1. Users launch Claude Code manually in terminal tabs.
2. VS Code terminal instability or WSL connection drops can interrupt work.
3. tmux improves resilience, but manual tmux use is cumbersome.
4. Users must remember session names and attach commands.
5. There is no good visual overview of which agents are running, waiting, idle, or done.
6. There is no workspace-first organization for agents launched in different directories.
7. There is no integrated way to open the real live Claude terminal session from a visual dashboard.
8. Recovery after Claude exit or crash is manual.
9. There is no clear ownership model showing which agent is responsible for which files or outputs.
10. Existing terminal tools are reliable but not visually navigable enough for complex multi-agent workflows.

---

## 3. Product Vision

Build a visually rich desktop application that feels like a **trading desk for local AI agents**.

The app should allow a user to:

- browse and select working directories
- create named workspaces around those directories
- launch one or many Claude Code agents into those workspaces
- assign each agent a role, title, permissions, and launch command
- monitor all agents while detached
- click any agent card to enter the actual live session, not a reconstructed log view
- recover smoothly when Claude exits or crashes
- relaunch Claude with resume information where available
- open the underlying workspace in VS Code with one click
- see live status through color, motion, and dense visual state indicators

The app should be usable first as an MVP and then grow into a full-featured operations console for advanced local multi-agent workflows.

---

## 4. Goals

### MVP goals

1. Launch Claude Code agents in separate tmux sessions from user-selected directories.
2. Persist workspace definitions and agent metadata.
3. Visually monitor agent status without requiring manual tmux commands.
4. Allow one-click live attach into the actual Claude Code terminal session.
5. Auto-restart agents when Claude exits unexpectedly.
6. Track and reuse Claude resume/session identifiers where possible.
7. Support Windows + WSL2 reliably.
8. Open workspaces directly in VS Code from the dashboard.

### Full vision goals

1. Workspace-first multi-pane experience with swipeable directory views.
2. Rich card-based agent management.
3. File explorer integrated into the dashboard.
4. Attribution of files, folders, and outputs to specific agents.
5. Real-time visual activity states and alerts.
6. Launcher presets for agent swarms per workspace.
7. Notifications for waiting, crashes, and completions.
8. Embedded live terminal panes for attached sessions.
9. Resume-aware relaunch after failure.
10. Highly polished, visually stimulating UI.

---

## 5. Non-Goals

The initial versions should not attempt to solve the following:

- remote cloud orchestration across multiple machines
- multi-user collaboration
- replacing Claude Code itself
- semantic understanding of every Claude state with perfect accuracy
- full task decomposition or autonomous orchestration across agents
- replacing VS Code as the code editor
- surviving a full WSL VM shutdown with exact live terminal continuity

Important note: **tmux does not survive a full WSL VM crash or `wsl --shutdown`**. The product can restore structure and relaunch agents, but it cannot preserve an active terminal process across total WSL termination.

---

## 6. Core Product Principles

1. **Workspace-first, not agent-first**
   - The user thinks in terms of directories and projects.
   - Agents live inside workspaces.

2. **Live attach must be real**
   - Logs and previews are not substitutes for the actual live Claude session.
   - Clicking attach should show the true session state.

3. **Detached monitoring should be safe**
   - Monitoring should rely on logs and metadata, not multi-attaching interactive terminals everywhere.

4. **tmux is the reliability layer**
   - The UI is the control plane.
   - tmux inside WSL is the process/session layer.

5. **Recovery should be automatic where possible**
   - Agent exits should be detected.
   - Relaunch and resume should happen with minimal user effort.

6. **Dense but understandable visual information**
   - The app can be vibrant and high-information, but color and motion must map to real states.

---

## 7. Users

### Primary user
Power user running multiple Claude Code agents locally on Windows using WSL2, with many active directories and long-running coding/research workflows.

### Characteristics

- uses VS Code heavily
- works across multiple repos and folders simultaneously
- values visual status awareness
- wants local-first control
- is comfortable with terminals but wants to reduce terminal friction
- wants resilience and speed

---

## 8. Platform Scope

### Supported environments

- Windows 11 primary target
- WSL2 required
- Ubuntu on WSL assumed as baseline tested distro
- Claude Code installed inside WSL
- tmux installed inside WSL
- VS Code on Windows with WSL integration

### Out of scope initially

- native macOS support
- native Linux desktop support
- Docker-only workflows
- SSH remote hosts beyond WSL

---

## 9. Architecture Overview

### Recommended architecture

#### Desktop shell
- Tauri preferred for lightweight desktop app
- Electron acceptable if terminal embedding constraints favor it

#### Frontend
- React
- Tailwind CSS
- Framer Motion
- Zustand or Redux for client state

#### Local backend supervisor
- Node.js or Python service bundled with app
- Responsible for:
  - interacting with tmux
  - launching agents
  - monitoring processes
  - tailing logs
  - updating statuses
  - storing metadata
  - opening VS Code

#### Persistence
- SQLite for durable workspace/agent/session metadata
- Log files on disk
- Optional JSON sidecar files for human-readable status snapshots

#### Live terminal rendering
- xterm.js embedded terminal view
- PTY bridge connected to WSL/tmux attach process

### High-level data flow

1. User creates/selects workspace.
2. App stores workspace metadata.
3. User launches agent.
4. Supervisor creates tmux session inside WSL.
5. tmux launches wrapper process.
6. Wrapper launches Claude Code with configured flags.
7. Wrapper logs output and tracks session state.
8. App reads logs + status metadata for dashboard view.
9. On click attach, app opens embedded terminal attached to tmux session.
10. On crash/exit, supervisor restarts and attempts resume.

---

## 10. Why tmux is used

### tmux responsibilities

- isolate each Claude agent in its own named session
- allow terminal detachment without killing the session in normal cases
- provide stable attach/detach semantics
- enable process grouping and recoverable session names
- allow integration with supervisor tooling through shell commands

### Important implementation notes

1. Each Claude agent must run in its own tmux session.
2. The app should not rely on multiple simultaneous live attachments to the same interactive session unless carefully controlled.
3. Monitoring should be log-based for safety.
4. Attach mode should connect to the real tmux session only when the user explicitly requests it.
5. Session naming must be deterministic and unique.

### Example session naming convention

`workspaceSlug__agentSlug__shortId`

Example:

`orchard_v8__reward_debugger__a13f`

This should be stored in the database and used throughout monitoring and recovery.

---

## 11. Launch Command Requirements

The standard Claude launch command for this product is:

```bash
ccode --dangerously-skip-permissions --chrome
```

The launch system must support:

- configurable command template
- per-agent overrides
- per-workspace defaults
- future extension for additional flags

### Default launch command fields

- executable: `ccode`
- default flags:
  - `--dangerously-skip-permissions`
  - `--chrome`

### Future launch options

- resume/session id
- permissions presets
- environment variables
- startup prompt or bootstrap message

---

## 12. Functional Requirements: MVP

## 12.1 Workspace Management

### FR-MVP-1: Create workspace
User can create a workspace from a selected directory path.

Workspace fields:
- id
- title
- directory path
- visual theme
- description optional
- default Claude command
- default permissions preset
- created timestamp
- last opened timestamp

### FR-MVP-2: Browse directories
User can browse local accessible directories and select one as workspace root.

For Windows + WSL, the app must support:
- selecting Windows paths
- mapping to WSL-compatible paths where necessary
- selecting WSL paths directly

### FR-MVP-3: Open workspace in VS Code
User can click a workspace action to open that workspace in VS Code.

Expected behavior:
- use Windows-side VS Code command or URI
- support opening folder via WSL integration when applicable

---

## 12.2 Agent Management

### FR-MVP-4: Launch agent
User can launch a new agent inside a selected workspace.

Agent launch form fields:
- agent title
- role/description
- workspace
- working directory (defaults to workspace root but editable)
- permissions preset
- command template
- auto-restart enabled toggle

### FR-MVP-5: Unique tmux session per agent
Every launched agent must get its own tmux session.

### FR-MVP-6: Agent metadata persistence
The app must persist:
- agent id
- workspace id
- tmux session name
- command
- working directory
- status
- restart count
- last output timestamp
- last attach timestamp
- created time
- last known Claude resume/session id if available
- role description
- optional responsibilities text

### FR-MVP-7: Stop agent
User can stop an agent from the dashboard.

### FR-MVP-8: Restart agent
User can manually restart an agent.

---

## 12.3 Monitoring and Status

### FR-MVP-9: Dashboard card view
Each agent appears as a card within its workspace pane.

Card minimum fields:
- title
- status
- role description
- workspace name
- working directory subtitle
- last activity timestamp
- restart count
- quick actions

### FR-MVP-10: Status states
The MVP must support the following states:
- Launching
- Working
- Idle
- Waiting
- Done
- Crashed
- Restarting
- Attached

### FR-MVP-11: Basic state inference
State determination may be heuristic-based using:
- process alive or not
- log output recency
- tmux session alive or not
- clean exit code or non-zero exit code
- known prompt markers indicating input required

### FR-MVP-12: Recent output preview
Card or detail view should show recent output lines from the agent log.

### FR-MVP-13: Agent log view
User can open a detailed log panel for an agent.

---

## 12.4 Attach to Real Session

### FR-MVP-14: One-click attach
User can click an agent card to open the actual live Claude terminal session.

This must not be a log reconstruction.

### FR-MVP-15: Embedded terminal preferred
App should render attached session in an embedded terminal panel if feasible.

Fallback acceptable:
- open external terminal window attached to tmux session

### FR-MVP-16: Detach from session
User can detach from the live session and return to dashboard.

### FR-MVP-17: Attach indicator
Attached agents should visibly indicate they are open in live mode.

---

## 12.5 Recovery and Restart

### FR-MVP-18: Auto-restart on crash
If Claude exits unexpectedly, the app should relaunch it automatically when auto-restart is enabled.

### FR-MVP-19: Resume-aware relaunch
If a valid Claude resume/session identifier is stored and supported by the CLI, the app should relaunch using it.

### FR-MVP-20: Restart state visibility
While restarting, the card should clearly show a restarting state.

### FR-MVP-21: Crash record
The app should store:
- last exit code
- last restart timestamp
- restart count
- recent error excerpt where available

---

## 12.6 Explorer and Navigation

### FR-MVP-22: Workspace list
User can see all saved workspaces.

### FR-MVP-23: Directory pane navigation
User can switch between workspaces using a pane or tab interface.

In MVP, tabs are acceptable. Full swipe carousel can come later.

### FR-MVP-24: Workspace detail header
Each workspace view must clearly display:
- workspace title
- full path
- open in VS Code button
- launch new agent button
- active agent count

---

## 13. Functional Requirements: Full Vision

## 13.1 Workspace Experience

### FR-FULL-1: Swipeable workspace carousel
User can swipe left and right between workspaces.

### FR-FULL-2: Distinct visual identity per workspace
Each workspace has:
- custom color palette
- title styling
- optional icon
- optional background motif

### FR-FULL-3: Workspace explorer pane
User can browse folders and files in the selected workspace.

### FR-FULL-4: Open in VS Code
One-click open in VS Code from workspace pane.

### FR-FULL-5: Open in file explorer
One-click reveal workspace folder in system explorer.

---

## 13.2 Agent Card Expansion

### FR-FULL-6: Rich agent cards
Each card may include:
- name
- role
- live status chip
- last output
- assigned files/folders
- outputs generated
- restart count
- elapsed runtime
- ownership metadata

### FR-FULL-7: Agent responsibility metadata
User can define:
- purpose
- main files
- main folders
- expected outputs
- notes

### FR-FULL-8: Agent color/activity visualization
Cards animate according to state.

---

## 13.3 Output and File Awareness

### FR-FULL-9: Changed file feed
Workspace pane shows recently changed files.

### FR-FULL-10: Agent-to-file attribution
Where feasible, the app links files/outputs to agents.

### FR-FULL-11: Output panel
Workspace pane can show artifacts created by agents.

---

## 13.4 Alerts and Notifications

### FR-FULL-12: Waiting-for-user alerts
If Claude appears to request user input, the dashboard highlights that agent.

### FR-FULL-13: Completion alerts
User receives visual and optional desktop notification when an agent completes.

### FR-FULL-14: Crash alerts
User receives visual and optional desktop notification when an agent crashes.

---

## 13.5 Presets and Swarms

### FR-FULL-15: Workspace launch presets
User can define presets like:
- 3-agent debugging swarm
- 4-agent coding swarm
- 2-agent review pair

### FR-FULL-16: Role templates
User can define default roles/descriptions for agents in a preset.

---

## 13.6 Advanced Attach and Interaction

### FR-FULL-17: Embedded multi-terminal views
User can attach multiple agents into side-by-side live terminal tabs.

### FR-FULL-18: Click-to-focus terminal tabs
User can click cards and switch live session view instantly.

### FR-FULL-19: Send prompt shortcut
Optional future feature to send text into tmux session without full attach.

---

## 13.7 Session Timeline and Analytics

### FR-FULL-20: Agent event timeline
Track:
- launched
- attached
- detached
- waiting
- crashed
- restarted
- finished

### FR-FULL-21: Activity analytics
Show runtime, restart frequency, idle time, and recent activity.

---

## 14. Non-Functional Requirements

### NFR-1: Reliability
- App must survive normal UI closure and relaunch without losing metadata.
- tmux sessions should remain discoverable after app restart, assuming WSL remains alive.

### NFR-2: Performance
- Dashboard should handle at least 20 visible agents without major lag.
- Log tailing must be efficient.

### NFR-3: Responsiveness
- Agent status updates should appear within 1–3 seconds of state changes.

### NFR-4: Local-first
- No cloud dependency required.
- All process control is local.

### NFR-5: WSL compatibility
- All agent launch, status, and attach functionality must work reliably through WSL.

### NFR-6: Safe path handling
- Windows and WSL path translation must be robust and explicit.

### NFR-7: Recoverability
- App restart should re-read active tmux sessions and reconcile state.

---

## 15. Status State Machine

### Proposed states

1. Launching
2. Working
3. Idle
4. Waiting
5. Done
6. Crashed
7. Restarting
8. Attached

### Suggested transitions

- New launch -> Launching
- Launching -> Working
- Working -> Idle
- Idle -> Working
- Working/Idle -> Waiting
- Waiting -> Working
- Working/Idle/Waiting -> Done
- Working/Idle/Waiting -> Crashed
- Crashed -> Restarting
- Restarting -> Launching
- Any live state + user attached -> Attached overlay flag

### Notes

`Attached` should likely be modeled as an overlay or sub-state rather than a terminal lifecycle state.

---

## 16. State Inference Strategy

The system needs heuristics because Claude Code may not expose explicit machine-readable state.

### Inputs for state inference

- tmux session exists or not
- Claude process alive or not
- last log write timestamp
- exit code
- detected terminal markers indicating prompt/request for input
- restart loop state
- explicit user attach state

### Heuristic definitions

#### Working
- process alive
- recent output within threshold, e.g. last 10 seconds

#### Idle
- process alive
- no output within threshold but still running

#### Waiting
- process alive
- output contains likely prompt/input marker patterns or cursor/prompt state
- no new output after prompt marker

#### Done
- process exited cleanly with code 0 and not scheduled for restart

#### Crashed
- process exited unexpectedly or with non-zero code

#### Restarting
- supervisor actively relaunching

These heuristics should be explicit and configurable.

---

## 17. Data Model

## 17.1 Workspace table

Fields:
- id
- title
- path
- path_type (windows, wsl)
- theme_id
- description
- default_command
- default_permissions
- created_at
- updated_at
- last_opened_at

## 17.2 Agent table

Fields:
- id
- workspace_id
- title
- slug
- role_description
- working_directory
- command
- permissions_preset
- tmux_session_name
- auto_restart_enabled
- resume_session_id
- expected_outputs_json
- responsible_paths_json
- status
- restart_count
- last_exit_code
- created_at
- updated_at
- last_output_at
- last_attached_at

## 17.3 Session runtime table

Fields:
- id
- agent_id
- pid
- tmux_session_name
- attached_count
- launched_at
- last_seen_alive_at
- last_restart_at
- state_reason
- log_path

## 17.4 Event table

Fields:
- id
- agent_id
- event_type
- payload_json
- created_at

## 17.5 Preset table

Fields:
- id
- workspace_id optional
- title
- config_json
- created_at

---

## 18. Launch and Recovery Design

### Launcher responsibilities

When user launches an agent, supervisor must:

1. generate unique agent id
2. generate tmux session name
3. create log path
4. store metadata in database
5. create tmux session in WSL
6. run wrapper script inside session
7. wrapper starts Claude Code with configured flags
8. wrapper captures output to log
9. wrapper stores/updates resume session id if available
10. wrapper restarts on crash if configured

### Recovery on app restart

When app restarts:

1. query known agents from database
2. query active tmux sessions from WSL
3. reconcile agent/session mappings
4. mark stale entries if session absent
5. attach monitoring to live sessions/logs again
6. if configured, allow relaunch of missing agents

### Recovery on Claude exit

If tmux session exists but Claude is no longer running:
- mark crashed or done based on exit state
- if auto-restart enabled, relaunch Claude in same session or recreate session cleanly
- pass resume info if available

### Important note

A full WSL shutdown kills tmux and Claude. The system cannot preserve live interactive state across that. It can only:
- detect missing sessions
- restore dashboard metadata
- offer relaunch and resume

---

## 19. WSL/Windows Integration Requirements

### Path handling requirements

The app must support:
- Windows-native paths like `C:\Users\...`
- WSL paths like `/home/turke/...`
- conversion where necessary

### VS Code launch behavior

When opening a workspace in VS Code, app should:
- use appropriate command for WSL-backed folder
- preserve workspace path fidelity

### Supervisor execution options

Recommended supervisor model:
- desktop app backend on Windows
- executes commands into WSL using `wsl.exe`
- all tmux and Claude operations happen inside WSL

### Example execution pattern

Windows app invokes:

```powershell
wsl.exe bash -lc "tmux ls"
```

or

```powershell
wsl.exe bash -lc "cd /path && tmux new-session -d -s sessionName 'wrapper command'"
```

### Requirements for WSL bootstrap checks

App should verify on startup:
- WSL available
- target distro available
- tmux installed
- Claude Code command available
- required helper scripts installed or installable

---

## 20. UI Requirements

## 20.1 MVP UI layout

### Left sidebar
- workspace list
- add workspace button
- all agents quick filter
- crashed agents filter
- waiting agents filter
- settings

### Main content area
- selected workspace view
- workspace header with title/path/open buttons
- agent card grid

### Right detail panel
- selected agent details
- recent logs
- controls

### Bottom or modal terminal view
- embedded live terminal when attached

---

## 20.2 Full Vision UI layout

### Workspace carousel
- horizontal swipe navigation
- each workspace has distinct identity

### Agent cards
- animated, color-coded, information-dense

### Explorer panel
- browse directories/files
- launch from selected folder

### Activity bar/attention center
- waiting, crashed, done, restarting queue

### Terminal dock
- embedded live attached sessions
- multiple tabs supported

### Visual style goals
- dramatic and high-information
- smooth animation
- trading-desk inspiration
- flashing or pulsing only when semantically meaningful

---

## 21. UX Flows

## 21.1 Create workspace flow

1. User clicks Add Workspace.
2. User browses/selects directory.
3. User sets title and optional theme.
4. User saves workspace.
5. Workspace appears in sidebar and main pane list.

## 21.2 Launch agent flow

1. User opens a workspace pane.
2. User clicks Launch Agent.
3. User fills name, role, working directory, permissions, command.
4. User confirms.
5. Card appears as Launching.
6. Card transitions to Working or Idle.

## 21.3 Monitor flow

1. User views workspace pane.
2. Cards show live color/state.
3. User sees waiting/crashed/done states immediately.
4. User can inspect details without attaching.

## 21.4 Attach flow

1. User clicks an agent card.
2. Real live terminal opens in embedded terminal panel.
3. User sees true Claude Code session.
4. User interacts directly.
5. User detaches/closes terminal panel.

## 21.5 Crash recovery flow

1. Agent exits unexpectedly.
2. Card turns red or Restarting.
3. Supervisor attempts relaunch.
4. If resume id exists, relaunch with resume.
5. Card returns to Working/Idle or remains Crashed with error.

---

## 22. Risks and Constraints

### Risk: imperfect state detection
Claude Code may not expose clear machine-readable states.

Mitigation:
- use heuristics
- show confidence or reason
- allow manual override/restart

### Risk: embedding true live terminal is technically tricky
Mitigation:
- start with xterm.js + PTY bridge
- fallback to external terminal if needed

### Risk: WSL path translation complexity
Mitigation:
- centralize path translation layer
- store both Windows and WSL path representations where useful

### Risk: full WSL shutdown destroys tmux sessions
Mitigation:
- explicit product messaging
- fast relaunch/resume logic
- persistent metadata

### Risk: resume semantics may vary by Claude Code version
Mitigation:
- abstract resume strategy behind supervisor layer
- make support version-aware

---

## 23. MVP Implementation Plan

## Phase 1: Foundations
- bootstrap Windows + WSL command bridge
- workspace storage
- tmux integration
- launch wrapper with fixed Claude command
- log capture
- basic agent database

## Phase 2: Dashboard MVP
- workspace list
- workspace detail pane
- agent cards
- status polling
- log preview
- stop/restart controls

## Phase 3: Live attach
- embedded terminal or external fallback
- one-click attach
- detach handling

## Phase 4: Recovery
- auto-restart
- resume metadata tracking
- restart counts and crash handling

## Phase 5: Polish
- open in VS Code
- improved states
- better colors/animations

---

## 24. Full Vision Implementation Plan

## Phase 6
- workspace carousel
- explorer panel
- file activity feed
- richer card metadata

## Phase 7
- presets and swarm launching
- notifications
- event timeline
- attention center

## Phase 8
- agent responsibility metadata UX
- file/output attribution
- richer analytics

## Phase 9
- highly polished visuals
- advanced terminal docking
- optional prompt injection tools

---

## 25. Acceptance Criteria: MVP

The MVP is complete when a user can:

1. Create at least two workspaces from different directories.
2. Launch multiple Claude Code agents using the command:
   `ccode --dangerously-skip-permissions --chrome`
3. See each agent appear as a card in its workspace.
4. Observe at least working, idle, waiting, crashed, and done states.
5. Click an agent and enter the actual live terminal session.
6. Detach and return to monitoring view.
7. Stop and restart agents from the UI.
8. Auto-restart an agent after forced Claude exit.
9. Open the workspace in VS Code.
10. Close and reopen the app without losing workspace and agent metadata.

---

## 26. Open Questions for Engineering

1. What is the most reliable way to capture Claude resume/session ids?
2. Does Claude Code expose machine-readable signals we can parse instead of relying on heuristic log scraping?
3. Should the backend be Node or Python given terminal/PTTY constraints?
4. Is Tauri sufficient for embedded terminal handling, or does Electron reduce complexity materially?
5. Should the live attach terminal be single-instance or support multiple simultaneous embedded terminals?
6. How should Windows/WSL path mapping be represented internally?
7. What is the desired behavior when user launches an agent in a Windows-mounted path versus native WSL path?
8. What exact restart policy should be used to avoid endless crash loops?

---

## 27. Engineering Notes

### Recommended tmux pattern

- one tmux session per agent
- deterministic session name
- wrapper shell script per session
- wrapper responsible for logs and restarts
- dashboard monitors logs and tmux state, not by attaching everywhere

### Recommended wrapper responsibilities

- change to working directory
- launch Claude with required command
- tee output to log
- write/update metadata file with current status
- trap exits and write exit codes
- optionally relaunch with resume info

### Recommended bootstrap requirement checks

- `tmux -V`
- `ccode --help` or version check
- confirm WSL distro available
- confirm app has permission to invoke `wsl.exe`

---

## 28. Future Opportunities

- remote multi-machine execution
- support for other CLIs beyond Claude Code
- collaborative review modes
- artifact dashboards
- git branch awareness per agent
- workspace snapshots
- prompt history library

---

## 29. Final Product Statement

This product should make local multi-agent Claude Code workflows feel:

- resilient like tmux
- visible like a monitoring console
- organized by project and directory
- easy to re-enter at any moment
- visually exciting and operationally clear

The MVP should focus on **reliability, workspace organization, and one-click real-session access**.

The full vision should evolve that into a **beautiful workspace-centric agent operations dashboard** for Windows + WSL power users.

