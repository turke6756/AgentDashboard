# AgentDashboard

Workspace-centric Claude Agent Dashboard built with Electron + React.

## Launching the App

### Production build (recommended for testing changes)

```bash
npm run build      # builds main (TypeScript) + renderer (Vite)
npm run start      # launches Electron, loads from dist/
```

### Development mode (hot-reload)

```bash
npm run dev        # builds main, starts Vite dev server + Electron concurrently
```

### Ghost Vite Server Warning

If UI changes aren't appearing after a rebuild, a stale Vite dev server is likely running in the background. Electron checks for a dev server on ports 5173-5175 and will silently connect to it instead of loading from `dist/`.

**Fix:** Kill the ghost process, rebuild, and relaunch:

```bash
# Find rogue processes
lsof -i :5173       # or: ps aux | grep vite

# Kill them
kill -9 <PID>

# Rebuild and launch
npm run build && npm run start
```

## Build Commands

| Command              | Description                              |
|----------------------|------------------------------------------|
| `npm run build`      | Full build (main + renderer)             |
| `npm run build:main` | TypeScript compile for Electron main     |
| `npm run build:renderer` | Vite build for React frontend       |
| `npm run start`      | Launch Electron (requires prior build)   |
| `npm run dev`        | Dev mode with Vite HMR + Electron       |

## Project Structure

- `src/main/` — Electron main process
- `src/renderer/` — React frontend (Vite)
- `src/preload/` — Preload scripts (IPC bridge)
- `src/shared/` — Shared types and constants
- `dist/` — Compiled output

## Agent file-write convention: avoid `.claude/`

Worker / planner / persistent agents launched in this workspace should not
write or edit files under `.claude/`. Claude Code's permission system gates
edits to anything inside `.claude/` **even with bypass-permissions on** —
because that's where `settings.json`, agent definitions, plans, and skills
live, the harness pops an interactive confirmation dialog asking the user to
approve the edit. In a non-interactive orchestration run, the agent hangs at
that dialog and the orchestrator times it out before anyone answers.

When authoring prompts, point agents at paths *outside* `.claude/`. If a plan
or output genuinely belongs under `.claude/`, the orchestrator (a Node script,
the dashboard, or a supervisor MCP call) should write it on the agent's
behalf. See `docs/ORCHESTRATION_SPIKE.md` for the run that surfaced this.

## Notebook execution convention

When asked to run or debug an `.ipynb` from this dashboard workspace, prefer the
dashboard MCP notebook tools over raw `jupyter nbconvert`. Use `execute_notebook`
for whole-notebook validation and `execute_cell` / `execute_range` for focused
iteration so the dashboard notebook view and persisted outputs stay in sync.
Use `nbconvert` only when the dashboard MCP tool is unavailable or the user
explicitly asks for a fresh-kernel headless run.
