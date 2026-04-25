# Resource Monitor: A "What Is My Machine Doing?" Dashboard

## The problem

The dashboard already spawns and owns a lot of moving parts across two operating systems:

- A JupyterLab server in WSL with N kernels (one per open notebook), each an `ipykernel` subprocess holding arbitrary Python working-set memory.
- Node-pty sessions on Windows and inside WSL, one per agent card. Each runs Claude Code (or another CLI) with its own RSS, scrollback buffer, and child processes.
- Supervisor agents, teams, and background work-agents with lifecycles the user didn't hand-start.
- The Electron main + renderer processes themselves.

The user currently has no visibility into any of this. When the machine feels slow, the only question they can answer is "is the fan on." Real questions — *which kernel is hogging 6 GB?*, *did my supervisor go zombie?*, *are there leftover kernels from notebooks I closed an hour ago?* — require hand-rolled `curl /api/kernels`, `ps`, and `tasklist` incantations. We did exactly that in a conversation on 2026-04-20 to find nine idle kernels worth ~2.5 GB that the user thought had been cleaned up.

The opportunity is small and high-leverage: the app already knows about every process it cares about. We just haven't put that knowledge on screen.

**Non-goal:** this is not a full system monitor. Task Manager / htop / Activity Monitor already exist. We show the slice the dashboard itself is responsible for, and we make that slice *actionable* — kill, restart, clear.

## What it shows

Five sections, in priority order. Everything below is data the app either already has or can pull from a single documented API/process call.

**Design principle:** every row that represents a running process is *actionable*. You never have to leave the panel to fix what it's telling you about. Kill, restart, or interrupt buttons live on the row itself — no "open Task Manager and find the PID" moment. This is the whole reason the panel exists.

### 1. Jupyter kernels

One row per running kernel. Columns:

| Field | Source | Notes |
|---|---|---|
| Notebook name | `/api/sessions` (`name`) | Shown first — it's the human identifier |
| Kernel spec | `/api/kernels` (`name`) | `python3`, `claude-env`, `ir`, etc. |
| State | `/api/kernels` (`execution_state`) | `idle` / `busy` / `starting` / `dead` |
| Connections | `/api/kernels` (`connections`) | **0 = the iframe is closed; kernel is orphaned** |
| Last activity | `/api/kernels` (`last_activity`) | Relative: "12 min ago" |
| RSS | `ps` in WSL, correlated by kernel connection file | Memory the kernel's Python process holds |
| CPU% | `ps` in WSL | Instantaneous; averaged over a rolling window for display |

Row-level actions: **Interrupt**, **Restart**, **Shut down**. Row-level badges: `orphaned` (connections=0 for >5 min), `stale` (last_activity >30 min), `busy-long` (busy >5 min — possible runaway).

Bulk action: **Shut down all orphaned kernels** — exactly the command we hand-ran on 2026-04-20.

### 2. Agents

One row per agent the dashboard spawned (Claude Code, supervisors, custom teammates). Columns:

| Field | Source | Notes |
|---|---|---|
| Agent name | Dashboard store (`Agent.name`) | |
| Role | `Agent.isSupervisor`, team membership | Distinguishes user agents vs. supervisor vs. enricher |
| PTY PID | `node-pty` (`pty.pid`) — already logged | Windows or WSL depending on `Agent.launchMode` |
| Process tree RSS | `ps --ppid <pid>` recursively in WSL, `wmic` on Windows | The PTY PID is the shell; the real memory is in descendants (the CLI and its child processes) |
| CPU% | same | |
| Last output (s) | IPC ring buffer already in main | Silence for N minutes on a supposedly-active agent = suspect |
| tmux session | `tmux list-sessions` via `wsl.exe` | WSL agents only; confirms the tmux shell is still attached |

Row-level badges: `silent` (busy claim but no output >5 min), `zombie` (PTY dead but agent card still shown), `runaway` (sustained >80% CPU).

Row-level actions: **Interrupt (Ctrl+C)**, **Restart**, **Force kill tree**.

### 3. Host machine (real-time)

A strip pinned at the top of the panel with live gauges for the whole box. This is the "is my computer okay right now?" answer that doesn't require interpreting the tables below.

| Metric | Source | Display |
|---|---|---|
| Total RAM used / available | Windows: `GlobalMemoryStatusEx` via native or `wmic OS get TotalVisibleMemorySize,FreePhysicalMemory`. WSL: `/proc/meminfo`. | Horizontal bar + "18.4 / 32.0 GB" label |
| CPU load (all cores) | Windows: PDH perf counters or `wmic cpu get LoadPercentage`. WSL: `/proc/stat` delta between polls. | Sparkline over last 60 s |
| Disk space (workspace drive) | Node's `fs.statfs` / `diskusage` package | Bar, only if <20% free — otherwise just text |
| Swap / pagefile pressure | `/proc/meminfo` (`SwapFree`), Windows `wmic pagefileusage` | Only shown if non-zero — swapping is the signal that matters |

Update rate: same 1–2 s poll as the rest. Sparklines keep ~60 samples (1 min of history) in a ring buffer; no disk persistence needed for v1.

**The payoff:** at a glance, the user sees "23 GB / 32 GB RAM, CPU at 12%, no swap" and knows the machine is fine — no need to guess from the kernel/agent tables.

### 4. Dashboard itself

A compact strip: Electron main RSS, renderer RSS, total child process count, total bytes in flight over agent IPC (we already have this metric in main). One line, not a table. Just so the user can tell the *app* apart from the *work it's running*.

### 5. Stuck / zombie sweep

A single "Things that look wrong" panel that surfaces anomalies from §1–§3 so the user doesn't have to scan rows:

- Kernels with `connections=0` for >5 min
- Kernels `busy` for >5 min with no output change
- Agents whose PTY died but whose card still claims `running`
- tmux sessions that exist for a dead agent (the mirror problem)
- Processes matching `python|ipykernel|node` in WSL that don't correspond to any kernel/agent the dashboard knows about — **true orphans** from crashed sessions or dev iterations

Each anomaly has a one-click resolve button. This panel is empty in the happy path; when it's non-empty, the user has a concrete list.

## Architecture

### Data layer: a single poller in main

One `setInterval` in `src/main/` — call it `resource-poller.ts` — ticks every 2 s (configurable). Each tick, in parallel:

```
resource-poller.ts
  ├── fetch http://127.0.0.1:18888/api/sessions + /api/kernels   (~5 ms)
  ├── wsl.exe bash -lc 'ps -eo pid,ppid,rss,pcpu,comm --no-headers'  (~30 ms)
  ├── tasklist /FO CSV                                            (~50 ms)
  └── read dashboard store: agents[], their pty pids
```

Correlate results into a single `ResourceSnapshot` object and emit over IPC to the renderer. Renderer just displays — no logic beyond formatting.

**Why one poller, not per-row polling:** avoids N `ps` spawns per tick when N is large. One `ps` output feeds everything.

**Correlation — the slightly hard bit:**

- **Kernel ID → OS PID.** `/api/kernels` doesn't expose the OS PID directly. Two reliable paths: (a) read the connection file (`~/.local/share/jupyter/runtime/kernel-<id>.json`) which has `pid` populated by `ipykernel` on startup; (b) `ps` filter for `ipykernel_launcher` and parse the `-f` connection-file argument, matching back to kernel ID. Path (a) is cleaner.
- **Agent → PTY PID.** Already known (`pty.pid` returned by `node-pty`; we log it — `[pty-host:...] PTY pid: 4800`). Need to start recording it in the agent store; a ~5-line change.
- **PTY PID → full tree RSS.** On WSL: walk `ps` output, build `ppid → [pid]` map, sum RSS of descendants. On Windows: `wmic process get ParentProcessId,ProcessId,WorkingSetSize` and same walk.

### UI placement

Two candidate surfaces:

**A. Collapsible right-side panel (recommended for v1).** Icon in the top-right of the main content area, toggles a 340-px-wide side panel. Default collapsed. Same interaction pattern as the existing Detail Panel (`src/renderer/components/layout/DetailPanel.tsx`), so nothing new to learn.

**B. Modal "Resource" overlay.** Full-screen takeover triggered by a status-bar click or keyboard shortcut. Better if the panel needs more room (e.g., once we add historical charts). Defer to v2.

v1 ships with A. When the zombie-sweep panel has non-empty content, the button gets a red dot — the only proactive surface.

### State + refresh UX

- Polling runs always (even when the panel is closed) — keeps the red-dot anomaly indicator live at all times.
- Rate: 2 s default, configurable in settings. `ps` at 2 s is cheap (<1% CPU on this box). If the user opens a notebook-heavy workspace, it might spike to 2–3% — add a "paused while panel is closed" mode as a knob.
- When the panel is open, slow the poll to 1 s for snappier feedback.
- Show last-refresh timestamp in the header. Manual refresh button next to it.

### Actions: kill / restart / interrupt

Everything destructive goes through a confirmation dialog with the specific target name inline ("Shut down kernel `SM_NDVI_10m_Raw.ipynb`?"). "Shut down all orphaned" requires typed confirmation of the count ("Type `9` to confirm"), since it's the highest-blast-radius action we offer.

Implementation: kernels hit `/api/kernels/<id>` DELETE (same path we proved on 2026-04-20). Agents use the existing `window.api.agents.stop()` / `.restart()` IPC. No new destruction primitives.

## Implementation phases

### Phase 1 — read-only kernel + agent list + host gauges (1–2 days)

- `src/main/resource-poller.ts` with three data sources: Jupyter API, WSL `ps` + `/proc/meminfo` + `/proc/stat`, and Windows memory/CPU (`wmic` or native).
- IPC: `resources:subscribe`, `resources:snapshot`.
- `src/renderer/components/resource/ResourcePanel.tsx` with §3 host strip at top (live bars + CPU sparkline), §1 kernel table, §2 agent table. No actions yet.
- Red-dot anomaly indicator (computed from snapshot; no §5 panel yet).

Ships the emotional payoff of "I can finally see what's running, and I can see whether my machine is struggling" with none of the risk of action UX.

### Phase 2 — actions (2–3 days)

- Per-row kill/restart/interrupt for kernels (wraps existing Jupyter DELETE).
- Per-row actions for agents (wraps existing `window.api.agents.*`).
- Confirmation dialogs.
- Bulk "shut down all orphaned kernels."

### Phase 3 — zombie sweep + Windows agent tree (2–3 days)

- §4 panel with the anomaly rules.
- Windows process tree via `wmic` or a native module (`node-ps-tree` or direct `CreateToolhelp32Snapshot`). WSL side already works from Phase 1.
- "Orphaned Python in WSL that doesn't belong to any kernel we know about" scan.

### Phase 4 — historical (optional, 3–5 days)

- 5-min and 1-hr sparklines per kernel/agent (RSS + CPU).
- Ring buffer in main, persisted to disk on quit.
- Leak detection: "this kernel's RSS grew 50 MB/min for the last 10 min" → surface in §4.
- This is where modal (option B) starts to make sense.

## What's easy, what's hard

**Easy:**
- Jupyter API — everything is already on a singleton HTTP server we own.
- WSL `ps` — we already shell out to WSL all over the app. `wsl-bridge.ts` is the hook.
- Agent PTY PIDs — node-pty exposes them, we already log them.
- Rendering — tables with per-row actions is bread-and-butter React.

**Medium:**
- Kernel-ID → OS-PID correlation. Connection-file path is well-documented but reading it from WSL adds a call per new kernel (cache by kernel ID after first resolve).
- Windows process tree. `wmic` is deprecated, `Get-CimInstance` via PowerShell is the modern path. Shell-out is slow (~200 ms per call); cache aggressively and only refresh when the set of tracked PIDs changes.
- "Paused while panel closed" logic if the background poll load matters. Probably doesn't, measure first.

**Hard-ish:**
- Truly robust anomaly detection — "busy for 5 min" is easy, but "silent but also producing tqdm output" is a false positive. Err on the side of *flagging*, not *killing*, in v1. Let the user decide.
- Historical charts without a library bloat. Recharts / Chart.js add 100+ KB. Inline SVG sparklines (~30 lines) are probably enough for Phase 4.

## Deferred (not on the critical path)

- **Disk I/O per kernel.** Possible via `/proc/<pid>/io` in WSL. Useful for "is this cell writing to disk" but rarely the thing the user wants to know.
- **GPU utilization.** Only matters once the workspace starts using CUDA kernels. Add when needed.
- **Per-agent token spend.** Interesting, but orthogonal — belongs in a separate "cost dashboard" view, not here.
- **Cross-session history / leak reporting at the notebook level.** "This notebook always leaks 500 MB per run" is a pattern worth surfacing, but needs a persistent store and is better planned with the knowledge graph work.
- **Remote machine support.** The whole design assumes one local host (Windows + one WSL distro). Multi-host is a different shape entirely.

## Open questions before building

1. **Confirmation threshold for bulk actions.** "Type the count" is safe but annoying. Is single-click OK for "shut down all orphaned kernels," since orphaned by definition means no UI is watching them?
2. **Should agent RSS include descendants, or just the PTY shell?** Descendants is more informative but slower to compute and can flicker (child processes come and go). Lean toward descendants with 5 s smoothing.
3. **Where does Electron's own RSS belong?** §3 is one idea. Could also go in a footer status bar item and skip §3 entirely — fewer sections to build.
4. **Polling in packaged builds.** 2 s `wsl.exe` calls spawn a new WSL instance each time unless we keep one open. Check if the existing `wsl-bridge` uses a persistent session; if not, this is the first thing that'll need fixing.

## Reference

- `docs/NOTEBOOK_PROTOTYPE.md` — kernel/session API reference; same `/api/*` endpoints we'd call.
- `src/main/jupyter-server.ts` — the singleton we'd query (`ensureJupyterServer()`).
- `src/main/wsl-bridge.ts` — how we shell into WSL; `ps` calls go through here.
- `src/renderer/components/layout/DetailPanel.tsx` — reference pattern for the side-panel UX.

Originating context: conversation of 2026-04-20, debugging 10 concurrent soil-moisture notebooks on the user's box. Killed 9 idle kernels by hand via `curl -X DELETE /api/sessions/<id>` after the user asked "do you see these kernels?"
