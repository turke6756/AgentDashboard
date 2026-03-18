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
