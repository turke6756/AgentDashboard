# Interactive Jupyter Notebook Prototype

## Why we did this

Two pain points converged on the same architectural fix.

**Problem 1 — Stale tabs.** In VS Code, when an agent edits a `.ipynb` that's already open in a tab, you don't see the changes until you close and reopen the tab. For an agent-driven workflow this is death by a thousand reloads.

**Problem 2 — Agents can't run notebooks *in* the notebook.** Today, when an agent tries to "run" a notebook, it extracts the cell source, runs it in a sandboxed subprocess, captures stdout, and forges nbformat output entries that *look* like the notebook was executed. The notebook itself never actually ran. To get a genuinely executed notebook, you have to run it manually after the agent is done.

Both collapse to the same root cause: **nothing owns a live Jupyter runtime that both the user and the agent share.** If we host a real Jupyter server inside the app, users *and* agents connect to the same kernel, cells really execute, outputs really land in the file, and changes really propagate.

## The architectural bet

```
Electron main                           Renderer (React)
─────────────                           ────────────────
jupyter-server.ts                       useJupyterServer() hook
 spawns `jupyter lab` in WSL            └─ calls notebook:ensure-server
 parses http://127.0.0.1:PORT/?token=…     receives { baseUrl, token }
 singleton; killed on will-quit             │
                                             ▼
ipc-handlers.ts                         InteractiveNotebookRenderer
 notebook:ensure-server                  └─ <iframe src="<base>doc/tree/<path>?token=…">
 notebook:list-kernelspecs
                                                │ HTTP + WebSocket
         WSL                                    ▼
         ───                       http://127.0.0.1:PORT (jupyter lab)
         wsl.exe bash -lc                        │ ZMQ
         '. .venv/bin/activate &&                ▼
          exec jupyter lab …'           ipykernel / IRkernel / etc.
```

One jupyter server per app session. First `.ipynb` click spawns it (~5 s). Subsequent opens reuse the server and just load a new iframe URL. The server's `root_dir` is `/`, so WSL-absolute paths from the file viewer translate trivially (strip the leading slash). Windows paths map to `/mnt/c/...`.

## What's in the prototype

### Files added

| Path | Role |
|---|---|
| `src/main/jupyter-server.ts` | Singleton spawn/kill, stdout URL+token parsing |
| `src/renderer/hooks/useJupyterServer.ts` | React hook that resolves `{ baseUrl, token }` once |
| `src/renderer/components/fileviewer/InteractiveNotebookRenderer.tsx` | Renders the iframe; falls back to the existing static viewer on error |

### Files modified

| Path | Change |
|---|---|
| `src/main/wsl-bridge.ts` | Added `wslSpawn()` streaming helper (sibling to `wslExec()`) |
| `src/main/ipc-handlers.ts` | Added `notebook:ensure-server` and `notebook:list-kernelspecs` handlers |
| `src/main/index.ts` | Shutdown hooks on `window-all-closed` and `will-quit` |
| `src/preload/index.ts` | Exposed `window.api.notebooks.*` |
| `src/shared/types.ts` | Added `JupyterServerInfo`, `KernelspecsResponse`, type entries in `IpcApi` |
| `src/renderer/components/fileviewer/FileContentRenderer.tsx` | Routes `.ipynb` to the interactive renderer instead of the static one |
| `package.json` | `@datalayer/jupyter-react`, `@jupyterlab/services` added (not actively imported — see pivot below) |

## The pivot — jupyter-react → iframe

Original plan: mount `@datalayer/jupyter-react`'s `<Notebook>` component inside React for tight integration with app UI. On first build this immediately hit the full well-known cascade of jupyter-react + Vite friction — webpack-style `~` CSS imports, `?text` query suffix, `.raw.css` default-string imports, json5 CJS interop. The datalayer team's own Vite example requires four plugins and a production-build patch to `@jupyter-widgets/controls`.

For a prototype we pivoted to iframe-embedding the spawned JupyterLab UI. It's strictly less work, proves the same architectural bet (shared kernel, real execution, on-disk output), and leaves `@datalayer/jupyter-react` installed as a ready swap-in when we need programmatic cell control.

Tradeoffs the iframe accepts:
- JupyterLab styles instead of the app's.
- No React state bridge (we can't, e.g., read the current cell selection from our sidebar).
- Single-document mode (`doc/tree/<path>`) keeps it focused, but the full Lab chrome is always a URL away.

## Prerequisites

The user's WSL venv (`/home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis/.venv`) needs JupyterLab:

```bash
pip install jupyterlab
```

This pulls in `jupyter-server` and the `/lab` UI assets. Already installed — no action needed.

## Current status

- [x] Main process spawns `jupyter lab` in WSL, parses the URL/token
- [x] IPC `notebook:ensure-server` and `notebook:list-kernelspecs` wired end-to-end
- [x] Renderer swaps `.ipynb` dispatch to the interactive (iframe) viewer
- [x] Shutdown on app quit kills the spawned server
- [x] Full `npm run build` green
- [x] **Manual smoke test** — iframe loads, kernel connects, cells execute, outputs write to disk
- [x] **Phase 0** — `jupyter-collaboration==4.0.2` installed; full RTC stack enabled (ydoc + fileid + docprovider + pycrdt)
- [x] **Node-side smoke test** — `scripts/notebook-kernel-smoke.mjs` attaches to the iframe's kernel, executes a cell via `@jupyterlab/services`, persists outputs through RTC, iframe live-refreshes with no dialog

## Gotchas hit during the smoke test

Four independent Chromium/Electron security layers bit us in sequence. Documented here so the next person doesn't have to re-derive them.

1. **`--ServerApp.port=0` logs literal `0` in Jupyter 2.17.** The URL banner prints `http://127.0.0.1:0/...` even though the server bound an OS-assigned port. Chromium then rejected the iframe URL as `ERR_UNSAFE_PORT` (-312). Fix: pin a fixed safe port (`18888`) with `port_retries=50`.
2. **`frame-ancestors *` doesn't match `file://` per CSP spec.** `*` only matches network schemes (`http/https/ws/wss`). Our renderer loads from `file://` so Jupyter's CSP blocked the iframe with `ERR_BLOCKED_BY_RESPONSE` (-27). Fix: strip `Content-Security-Policy` and `X-Frame-Options` from Jupyter responses via `session.webRequest.onHeadersReceived` in `src/main/index.ts`.
3. **`webSecurity: true` on the BrowserWindow blocks `file://` → `http://127.0.0.1` iframe loads entirely**, even with permissive headers. Fix: set `webSecurity: false` + `allowRunningInsecureContent: true`. Safe for this app since it only embeds its own locally-spawned server.
4. **WebSocket auth fails silently on the kernel channel (403 "Couldn't authenticate WebSocket connection").** Jupyter's `Set-Cookie` doesn't set `SameSite=None`, so Chromium strips cookies on WS upgrades from `null`-origin iframes. Fix: disable token auth (`IdentityProvider.token=''`). Safe because the server binds to `127.0.0.1` only, and `--ServerApp.token=` is deprecated in Jupyter 2.x anyway (IdentityProvider is the new canonical location — using the deprecated flag leaves the WS auth handler unable to see the token).

Also disabled Chromium's Private Network Access preflights via `app.commandLine.appendSwitch('disable-features', '...')` as a belt-and-suspenders — probably not strictly needed once `webSecurity: false`, but cheap insurance.

## Known caveats

1. **Hardcoded venv path** in `src/main/jupyter-server.ts`. Fine for prototype, needs per-workspace config before shipping.
2. **WSL-only.** Server runs inside WSL → sees only Linux kernelspecs (`python3`, `ir`, `ir43`, etc.). A Windows-side user's kernels would be invisible. Out of scope until needed.
3. **No `webSecurity` adjustments.** The iframe loads cross-origin (app on `file://` or `localhost:5173`, jupyter on `localhost:<rand>`). Jupyter Lab's `/lab` sends `Content-Security-Policy: frame-ancestors *` via our tornado_settings override, so the iframe embeds cleanly. If that stops working, check that header first.
4. **No save-back logic from the app side.** That's fine — the kernel writes outputs directly through the server's contents API, so edits and executed outputs land on disk without our help. User edits made in the iframe likewise save via the Lab UI's own save button.
5. ~~**No file watcher yet.** The "agent edits file, UI sees it immediately" loop depends on whether JupyterLab notices external changes to the open document. This is milestone 5 and needs an actual test.~~ **Resolved by Phase 0** (`jupyter-collaboration` install). External writes via `contents.save()` are detected as out-of-band, merged into the ydoc, and broadcast to connected clients — the iframe's execution-count gutter updates live without refresh or dialog. Verified end-to-end by `scripts/notebook-kernel-smoke.mjs` (2026-04-18).

## Roadmap to a full agent-native notebook experience

> **Note (2026-04-18):** The phase ordering below was revised after the de-risk research further down. What was originally "Phase 2 — `jupyter-collaboration`" is now Phase 0 and **is already done**. Phases 1/3/4 keep their descriptions; Phase 2 is struck. The [Phase 1 de-risk research section](#phase-1-de-risk-research-2026-04-18--outcome-and-revised-plan) has the authoritative current plan.

The endgame is a notebook surface where agents and the user collaborate as first-class peers: agents execute real cells through the live kernel, their edits propagate instantly, and the UI shows who is working on what (highlighted cells, presence markers, click-to-send-to-agent). The iframe architecture can't deliver all of that — but each capability needs a different piece of plumbing, and only the *last* one needs the iframe gone. The cost-effective path is to build the plumbing first and swap the renderer last.

### Phase 1 — MCP kernel tools (1–2 days)

Agents stop forging outputs. `execute_cell`, `execute_range`, `interrupt_kernel`, `restart_kernel` — all hit the spawned server via `@jupyterlab/services` (REST + WebSocket). Pure backend work, no UI changes. Everything downstream depends on this because it's what makes agent actions real instead of simulated.

### ~~Phase 2 — `jupyter-collaboration` + Yjs~~ — **promoted to Phase 0, DONE 2026-04-18**

Pulled forward after research showed every downstream phase benefits from it. `pip install 'jupyter-collaboration==4.0.2'` + `jupyter-server-ydoc` + `jupyter-server-fileid` + `jupyter-docprovider` + `pycrdt` stack. Lab 4.x auto-enables on install; no config flag needed. Verified: the notebook document is a CRDT; external writes land in the ydoc; iframe redraws live. Caveat #5 above is resolved.

### Phase 3 — Agent presence (two forks)

- **Shallow (a few hours):** a status bar *above* the iframe rendered by your app showing "Supervisor is executing cell 3 / Hello is reading cell 7", driven by MCP tool activity. No iframe changes. Delivers most of the emotional payoff of "I can see what the agent is doing" without touching the notebook surface.
- **Deep (days):** a small JupyterLab extension (TypeScript plugin) that subscribes to a WebSocket from the main process and paints borders / avatars / colored backgrounds on cells as agents touch them. Lives *inside* Lab's world. Coexists with the iframe today and survives the phase 4 swap if it's still useful.

### Phase 4 — Renderer swap (~1 week realistically)

Replace `<iframe>` in `InteractiveNotebookRenderer.tsx` with `@datalayer/jupyter-react`'s `<Notebook>` component pointed at the same `{ baseUrl, token }` the iframe uses now. All the backend work from phases 1–3 stays; only the view layer changes. Cells become your own React components inside your app's layout — you control every pixel, inject agent-presence overlays natively, and the chrome is yours. The Vite friction we pivoted around earlier is real but documented — four plugins plus a patch to `@jupyter-widgets/controls`. Known cost, not a mystery.

What the transition file looks like: today's 60-line `InteractiveNotebookRenderer.tsx` doing `<iframe src=...>` becomes a 60-line file doing `<JupyterReactNotebook path=... serviceManager=...>`. The iframe was always a pluggable renderer — that was the architectural bet. During transition the two can coexist behind a settings toggle.

### Why this order

Each phase pays off on its own without depending on later phases. Stop after phase 2 and you already have a dramatically better experience (live agent edits, no stale-file issues). Phase 3 shallow gives visible agent presence without the renderer swap. Phase 4 is only necessary once you want cells themselves to be your UI primitives, not windows into a foreign app.

### Deferred (not on the critical path)

- **Per-workspace Python / venv config.** Replace the hardcoded venv path with a setting so other projects can use this.
- **Kernel picker UX.** Today the iframe shows Lab's default picker. A VS-Code-style MRU + grouped spec list is a small React component using `notebook:list-kernelspecs`. Becomes more valuable after phase 4 when it lives in your chrome.
- **Bundle Python.** Once the UX is proven, decide whether to ship a `python-build-standalone` payload (~40 MB) for zero-setup onboarding.

## Phase 1 de-risk research (2026-04-18) — outcome and revised plan

Before writing any kernel MCP tool code we ran a deep research pass against the `@jupyterlab/services` source, `jupyter_server` internals, the messaging spec, and the handful of open-source "agent + notebook" projects that already exist. The headline finding **inverts the phase ordering in the roadmap above**: `jupyter-collaboration` moves from Phase 2 to Phase 0. Everything else in Phase 1 becomes dramatically simpler once it's installed.

### The one decision that matters

**GO — install `jupyter-collaboration` before writing any MCP code.**

Without it, kernel outputs only stream to the *connected client* (iframe) and only land on disk when Lab autosaves. An external MCP client that PUTs via contents API races the iframe's save and triggers JupyterLab 4.x's "file changed on disk" conflict dialog — unacceptable for agent workflows. With it, the notebook becomes a Yjs CRDT, the server debounces to disk (1s default), and the iframe auto-reloads from the ydoc. No dialog, no race. Your MCP tool's PUT still works — it just routes through the ydoc with CRDT conflict resolution.

Every serious prior-art MCP server (Datalayer `jupyter-mcp-server`, Block `mcp-jupyter`) depends on RTC. Pin `jupyter-collaboration==4.0.2` + `jupyterlab==4.4.x` — Datalayer's tested combo. Lab 4.x auto-enables on install (no `--collaborative` flag needed).

### P1 answers (de-risk resolved)

**Session sharing is real and supported.** `jupyter_server/services/sessions/handlers.py` dedupes `POST /api/sessions` by path — if the iframe already opened `foo.ipynb`, your Node client gets the *same* kernel back, not a parallel one. But `@jupyterlab/services` client-side doesn't lean on that; you must do the dance yourself:

```ts
await manager.sessions.refreshRunning();
const existing = await manager.sessions.findByPath(path);
const session = existing
  ? manager.sessions.connectTo({ model: existing })
  : await manager.sessions.startNew({ path, type: 'notebook', name: path, kernel: { name: 'python3' } });
```

Never uniquify the path. Use `session.dispose()` (client-side only) — never `session.shutdown()`, which deletes the session server-side and kills the iframe's kernel.

**"Cell truly done" = `await future.done`.** It resolves after *both* the shell `execute_reply` *and* the iopub `status: idle` matching parent `msg_id`. `onReply` fires too early. Pass `{ allowStdin: false, storeHistory: true }` to `requestExecute` — stdin-disable prevents `input()` from hanging the kernel; storeHistory keeps `In[n]` counters correct for real cells.

**Node setup.** `@jupyterlab/services` claims to auto-detect WebSocket but doesn't in practice — pass `WebSocket: require('ws')` explicitly into `ServerConnection.makeSettings`. Native `fetch` in Node 20+ works fine. Use a singleton `ServiceManager` in Electron main; dispose on app quit.

### Prior-art tool conventions worth stealing

Closest production reference is [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) (Python). Conventions converge across projects:

- **Address cells by `cell_id` (nbformat 4.5 UUID), not index** — so inserts don't break agent state across tool calls.
- **Every execute tool takes an explicit `timeout` arg** (default 60s).
- **Truncate text outputs ~5KB, base64-ref images** before returning to the LLM.
- **Return `{ status, execution_count, outputs_summary }`** — don't dump raw iopub.

### Gotchas discovered during research

1. **Empty-token auth is fragile.** Some `jupyter-server` 2.x versions reject `Authorization: token ` (trailing space) on WS upgrades. If intermittent 403s appear, drop the token param entirely from `makeSettings` rather than passing empty string.
2. **IRkernel buffers stdout until cell end** — no live streaming possible without patching IRkernel. Design agent UX around "output lands when cell finishes" for R kernels (which is what the user primarily runs).
3. **Confirm kernel culling is off** — `--MappingKernelManager.cull_idle_timeout=0` (default). Otherwise long agent sessions die silently.
4. **`contents.save()` over raw PUT** — emits `fileChanged` signal local subscribers rely on.
5. **Address cells by `cell_id`, not index** (see above) — nbformat 4.5 writes UUIDs since Lab 3.2.

### Revised next steps

1. **Install RTC:** `pip install 'jupyter-collaboration==4.0.2'` into the WSL venv (`/home/turke/GIS_Analysis/NEON_GIS_CrestedButte_Analysis/.venv`). Verify Lab 4.4.x compatibility. Confirm iframe still loads.
2. **Add `ws` to `package.json`:** `npm i ws @types/ws`.
3. **Write `scripts/notebook-kernel-smoke.ts`:** ~40 lines, uses already-installed `@jupyterlab/services`. Does exactly: `refreshRunning → findByPath/startNew → requestExecute → collect iopub → contents.save`. Run against a live iframe session to prove attach-don't-duplicate + persist-survives-reload.
4. **Only then design MCP tool shapes,** taking Datalayer's `jupyter-mcp-server` as the starting point. Tool signatures: `execute_cell(notebook_path, cell_id, timeout?)`, `execute_range(path, from_cell_id, to_cell_id)`, `interrupt_kernel(path)`, `restart_kernel(path)`, `get_kernel_state(path)`.

The Phase 2 row in the roadmap above can be struck — it's now Phase 0.

## Phase 0 outcome — smoke test passed (2026-04-18)

`jupyter-collaboration==4.0.2` installed into the WSL venv; `scripts/notebook-kernel-smoke.mjs` executed against a live iframe session.

**Result:**

```
[server] ready at http://127.0.0.1:18888
[cell] found code cell [1] (253 chars)
[session] reused — kernel id: 99dca0d8-c3de-4d93-ac1a-cd561bc94448   ← matches iframe
[exec] status: ok — execution_count: 2 — outputs: 0
[save] wrote 0 outputs to disk
[verify] disk has 0 outputs
```

Within ~1 second of the smoke test completing, cell 1's left gutter in the dashboard iframe flipped to `[2]:` **without refresh and without a "file changed on disk" dialog.** That confirms:

1. Node-side `@jupyterlab/services` (with `ws` polyfill) talks to jupyter-server correctly over empty-token auth.
2. `sessions.findByPath → connectTo` attaches to the iframe's existing kernel. Contrast: when the script was earlier called with a mistyped path, `findByPath` returned undefined and the permissive version of the script silently spawned a parallel kernel. The current script refuses this — it errors out, forcing the operator to fix the path.
3. `kernel.requestExecute → future.done` is a reliable "cell truly finished" signal.
4. `contents.save()` triggers jupyter-collaboration's "out-of-band change" detection, which updates the ydoc in memory AND broadcasts Y patches to connected clients. Result: disk is persisted, iframe is live, no dialog.

**Gotchas encountered during smoke:**

- Several zombie kernels accumulated from mistyped-path runs of the old permissive script. Cleaning them up requires either `curl -X DELETE /api/sessions/<id>` per zombie, or a dashboard restart (the `will-quit` hook kills the whole jupyter server).
- The original first attempt ran cell index 0 (a markdown cell). nbformat allows `outputs` and `execution_count` on markdown cells, but JupyterLab correctly *ignores* them when rendering markdown. That's why the error output appeared invisible — it was on disk, just not rendered. The updated smoke test refuses to execute non-code cells to prevent this confusion.

## Next: Phase 1 — MCP kernel tools

Smoke test proves the three moving pieces (session attach, kernel execute, contents save with RTC) all work. Now build the actual MCP tools, modeled on Datalayer's `jupyter-mcp-server`:

| Tool | Signature | Notes |
|---|---|---|
| `execute_cell` | `(notebook_path, cell_id, timeout?=60)` | Address by nbformat 4.5 `id`, not index — agent inserts don't shift addresses |
| `execute_range` | `(notebook_path, from_cell_id, to_cell_id, timeout?=60)` | Sequential, stops on first error |
| `interrupt_kernel` | `(notebook_path)` | `POST /api/kernels/<id>/interrupt`; affects iframe too (intended) |
| `restart_kernel` | `(notebook_path)` | Session is preserved; both iframe and MCP auto-follow via `KernelConnection` reconnect |
| `get_kernel_state` | `(notebook_path)` | Returns `{ busy, idle, dead, execution_count }` |

Output handling: truncate text to ~5KB per cell, base64-ref images, return a compact `{ status, execution_count, outputs_summary }` blob to the LLM rather than raw iopub. All of this is conventional across Datalayer/Block/Jupyter-AI MCP servers — steal the patterns.

Implementation lives alongside existing MCP servers in `scripts/mcp-*.js`. Attach to the same `ensureJupyterServer()` singleton the iframe uses (don't spawn a second server). The throwaway `.mjs` script stays in `scripts/` as the regression-proof that the underlying plumbing still works — useful when something breaks later.

## Phase 1 outcome — kernel MCP tools shipped (2026-04-18)

Implemented end-to-end. The supervisor MCP server now exposes five new tools that route through the Electron main process to the same `jupyter-server` the iframe uses:

| Tool | Endpoint | Notes |
|---|---|---|
| `execute_cell` | `POST /api/notebooks/kernel/execute-cell` | Address by nbformat 4.5 `cell_id`. Default 60s timeout interrupts a runaway cell. |
| `execute_range` | `POST /api/notebooks/kernel/execute-range` | Sequential, stops on first non-`ok` cell. |
| `interrupt_kernel` | `POST /api/notebooks/kernel/interrupt` | Affects iframe too (intentional). |
| `restart_kernel` | `POST /api/notebooks/kernel/restart` | Both iframe and MCP auto-reattach via session preservation. |
| `get_kernel_state` | `GET /api/notebooks/kernel/state` | `{ attached, kernel_id, kernel_name, status, execution_state, last_execution_count }`. |

### Files added / changed

| Path | Role |
|---|---|
| `src/main/jupyter-kernel-client.ts` | Singleton `ServiceManager` bound to `ensureJupyterServer()`. `attachSession()` does `refreshRunning → findByPath → connectTo`, falling back to `startNew()` only if the iframe hasn't opened the notebook. Output compaction (text→5 KB, image data→`{mime, bytes, preview}`). Disposes session client-side only — never `session.shutdown()`. |
| `src/main/api-server.ts` | Five new routes under `/api/notebooks/kernel/*`. |
| `src/main/index.ts` | `disposeKernelClient()` on `window-all-closed` and `will-quit`. |
| `scripts/mcp-supervisor.js` | Five new tool defs + handlers proxying to the API. |

### Conventions adopted from prior art

- **Address by `cell_id`, not index.** Inserts that shift indices won't break agent state across calls.
- **Snake-case payload fields on the kernel API** (`allow_stdin`, `store_history`) — `@jupyterlab/services` `requestExecute` uses the wire-protocol field names directly, not camelCase.
- **`future.done` is the only true "cell finished" signal.** Resolves after both shell `execute_reply` and iopub `status: idle`. `onReply` fires too early.
- **Compact output shape**, not raw iopub: `{ status, cell_id, execution_count, outputs_summary }`. One matplotlib figure won't fill the LLM's context.
- **Per-call session attach + dispose.** No connection pooling; the underlying HTTP/WS keepalives in `jupyter-server` make this cheap, and avoids a class of leaks if the iframe restarts the kernel out from under us.

### Build status

`npm run build` passes (main + renderer). The throwaway `scripts/notebook-kernel-smoke.mjs` is unchanged and remains the regression-proof for the underlying plumbing.

### End-to-end verified (2026-04-18)

Hand-driven test from the GIS workspace's WSL supervisor. The supervisor invoked `execute_cell` via MCP against a notebook the user had open in the iframe; the cell ran on the live kernel, outputs persisted via `contents.save()`, and the iframe's gutter flipped from `[ ]` to `[1]` with no refresh and no "file changed on disk" dialog. The full path the call traversed was: WSL agent → MCP server (node) → HTTP API on Windows (port 24678) → `jupyter-kernel-client.ts` → `@jupyterlab/services` → `jupyter-server` → ipykernel → iopub → ydoc broadcast → iframe.

### Supervisor distribution: lessons from the live test

Three problems surfaced once the supervisor tried to actually use the new MCP tools — none were in the kernel-client itself, all were in how supervisor instances reach the dashboard. Documented here because they're easy to re-debug from scratch.

1. **`SUPERVISOR_AGENT_MD` is per-workspace, not global.** Every workspace gets its own scaffolded `.claude/agents/supervisor/CLAUDE.md` from the constant in `src/shared/constants.ts`. Adding new tool docs only affects future scaffolds — existing workspaces keep their old `CLAUDE.md`. `ensureSupervisorScaffold` intentionally skips files that already exist (preserves user edits). For a "force upgrade" workflow we'd need a scaffold-version mechanism; deferred.

2. **`ensureMcpConfig` only fires from `launchAgent`, not `reconcile`.** Original behavior meant a supervisor's `.mcp.json` was written once and persisted through everything — including switches between dev and packaged builds. Result: supervisors would point at stale paths like `release/win-unpacked/resources/scripts/mcp-supervisor.js` indefinitely. Fixed by calling `ensureMcpConfig` for `agent.isSupervisor` agents inside `reconcile()` so stale configs self-heal on next dashboard launch.

3. **WSL → Windows host IP detection was wrong on default-NAT WSL2.** Original code parsed `/etc/resolv.conf` for the nameserver IP, which is **not** necessarily the gateway. On this user's box: nameserver = `10.255.255.254` (custom DNS), gateway = `172.22.208.1`. They differ. Fixed by switching to `ip route show default` (parses `default via X.X.X.X dev eth0`). The earlier awk-based version (`grep nameserver | awk '{print $2}'`) had its own bug too — wsl.exe pre-processes args and mangled `$2`, causing awk to print whole lines. Don't pipe through awk via wsl.exe; read the file/route table and parse in Node.

4. **Windows Firewall blocks WSL→Windows on unsolicited ports.** The dashboard binds `0.0.0.0:24678`, but WSL traffic arrives on a separate vEthernet adapter that Windows treats as a foreign network. Manifests as instant ECONNREFUSED (not timeout). One-time fix: `New-NetFirewallRule -DisplayName "AgentDashboard API" -Direction Inbound -LocalPort 24678 -Protocol TCP -Action Allow` in admin PowerShell. Switching WSL to mirrored networking mode (`networkingMode=mirrored` in `~/.wslconfig`) eliminates the issue entirely — gateway disappears and 127.0.0.1 routes to Windows directly — but requires `wsl --shutdown`.

5. **Electron does NOT hot-reload its main bundle.** `npm run build:main` updates `dist/` on disk, but the running Electron process keeps executing the bundle it loaded at startup. Any time you change main-process TS code, the dashboard must be closed and relaunched for changes to take effect. Twice during this session, "I patched the file" was followed by "the dashboard immediately overwrote it again" — because the patch was on disk but the running code was still the old version.

### Open follow-ups (not blocking Phase 1)

- **Kernel-state hint in the dashboard.** Phase 3 shallow (a status bar showing "Supervisor is executing cell …") slots in naturally on top of these handlers — most of the data flow already exists; it's a renderer-side change.
- **Scaffold-version upgrade mechanism.** When `SUPERVISOR_AGENT_MD` content meaningfully changes (new tools, changed conventions), existing workspaces keep their stale `CLAUDE.md`. A small marker file (`.scaffold-version`) plus an "is this content unmodified from the previous default?" check would let the dashboard safely re-write managed sections without clobbering user customizations.
- **Drop the WSL gateway parse if mirrored networking becomes the default.** The auto-detect's `127.0.0.1` fallback already handles mirrored mode; if the user (or future users) adopt it, the `ip route` call becomes dead code.

## Phase 2 plan — strip the chrome, then own the renderer (planned 2026-04-18)

### Product clarification: what agents-first actually means here

After Phase 1 shipped, the natural-sounding next step looked like a "collaboration UI" with diff-mode proposals, approval queues, provenance ribbons, prompt-as-source cells, etc. — patterns borrowed from Hex / Deepnote / Cursor. **Discarded after talking through the actual workflow.**

Agents already have the autonomous loop we want via the Phase 1 MCP tools: execute → read output → edit cell → re-execute → repeat until error-free. They don't need approval gates, diff previews, or speculative forked kernels — they're capable enough to just do the work. The UI's job is **to stay out of the way and keep the human view clean while agents touch any aspect of the notebook they need to.** Humans still run cells themselves when they want.

This significantly simplifies the build. Things explicitly *not* on the roadmap:

- Diff mode / cell-edit proposals
- Approval queues
- Provenance ribbons / per-cell author attribution
- Speculative execution in forked kernels
- Tab completion via kernel
- Inline `/commands`
- Whole-notebook generation from a prompt
- AI chat sidebars

What *is* on the roadmap is the opposite of UI growth — it's UI subtraction. The iframe today shows the entire JupyterLab UI (menubar, file browser, status bar, etc.), which is visually overwhelming when all you want to see is cells. We're skipping the iframe-CSS-surgery half-step and going straight to the custom renderer.

### Crystallized product vision (2026-04-20)

The notebook should feel like it belongs inside the dashboard — same theme tokens, same chrome, same typographic scale. Visually spare. No JupyterLab legacy UI.

**User affordances (that's it, nothing more):**

- Run all cells
- Run a single cell
- Add a code cell
- Add a markdown cell
- Interrupt / restart kernel

**Status feedback the user must always see:**

- Notebook-level activity indicator at the top (running / idle / errored), with a thin progress strip while a run-all is in flight.
- Per-cell status ring: idle, queued, running (subtle pulse), done (brief flash + execution count), errored (red edge, persists).
- "Just finished" micro-animation so the eye catches completion without reading the gutter.

Animations are CSS keyframes on `transform` / `opacity` only — never width / height / top, which would thrash layout.

**Agent affordances (same buttons, exposed as MCP tools):**

- `execute_cell` / `execute_range` / `interrupt_kernel` / `restart_kernel` / `get_kernel_state` — already shipped in Phase 1.
- **New: `execute_notebook(notebook_path)`** — sequential run-all, stops on first error. Returns `{ status: ok | interrupted | failed, last_executed_cell_id, failed_cell_id?, error?, outputs_summary }`. Datalayer's `execute_notebook` is the prior art to mirror.
- **New: `get_notebook_state(notebook_path)`** — returns per-cell status so an agent mid-run can ask "which cell is running, which errored, which haven't started yet" without replaying iopub.

**New agent skill — `notebook-debug-loop`:** documents the pattern so agents don't have to re-derive it.
  1. `execute_notebook` to run the whole thing.
  2. If `status !== 'ok'`, inspect `failed_cell_id` and its `outputs_summary` to read the traceback.
  3. Edit the failing cell (through the same ydoc path we use elsewhere — not raw contents PUT).
  4. Re-run either just that cell or the range from there to the end, depending on whether earlier cells have side effects.
  5. Repeat until `status === 'ok'`.
  Skill lives alongside existing agent skills; should be short and example-driven.

### Execution plan — full send (2026-04-20)

No fail-fast spikes. We're committing to the rebuild. The iframe renderer comes out on Day 1, notebooks break for ~1 week until read-only rendering lands mid-Phase 2, and the whole replacement ships in ~4 weeks + buffer.

The step-by-step plan — written to be followable by an autonomous agent, with phase boundaries, acceptance checks, commit points, and explicit stop-points — lives in **[`NOTEBOOK_FULL_SEND_PLAN.md`](./NOTEBOOK_FULL_SEND_PLAN.md)**. That document is the execution spec; this one is the background.

High-level phase map from the plan:

- **Phase 0** — Demolition + deps (~½ day). iframe renderer deleted, stub in place, pinned CM6 + Yjs + virtualizer stack installed.
- **Phase 1** — Ydoc sync (1–2 days). WebSocket connected to `jupyter-collaboration`, cells streaming into the renderer. Riskiest single step of the project.
- **Phase 2** — Rendering layer (~1 week). Output renderer → markdown cells → code cells (CM6 + lowlight) → virtualization. Read-only surface at end.
- **Phase 3** — Execution + interaction (~1 week). Toolbars, status animations, `execute_notebook` MCP tool. Agents can drive the notebook end-to-end.
- **Phase 4** — Theme + agent skill + edge cases (~3–4 days). Visual match with the dashboard, `notebook-debug-loop` skill authored, reconnect/interrupt/empty-notebook handled.
- **Phase 5** — Cleanup + final E2E (~2 days).

### Build milestones (revised)

1. **Render-only cells + dashboard-themed chrome.** CodeMirror 6 for code, `react-markdown` + `remark-math` + KaTeX for markdown, output renderer covering `text/plain`, `text/html` (sanitized), `image/png`/`image/jpeg` (base64 → blob URL), `image/svg+xml`, `application/json` (collapsible), `text/markdown`, ANSI streams with `\r` overwrite. Theme tokens wired. Read-only, no execution. Validates the rendering and scrolling layer in isolation against a real GIS notebook.
2. **Yjs sync + execution + status animations.** Live ydoc binding against `jupyter-collaboration`. Wire up run-cell, run-all, add-cell, interrupt, restart. Per-cell status ring and notebook-level activity bar. Functional parity with the iframe *plus* the new visual grammar.
3. **`execute_notebook` + `get_notebook_state` + agent skill.** Backend tools shipped alongside renderer, skill file authored, end-to-end tested with the supervisor running the debug loop unsupervised on a broken notebook.
4. **Agent-presence polish (deferred, re-evaluate after M3).** If it still feels needed — a soft halo on the cell an agent is touching, driven by Yjs awareness. Likely unnecessary once the debug loop is working.

### Load-bearing technical findings (from 2026-04-18 research)

These are the constraints the custom renderer build has to respect. Failing to plan for any of these is a rewrite, not a refactor:

1. **Yjs from day one — do not poll.** With `jupyter-collaboration` enabled, the contents API is no longer the source of truth; the ydoc is. Polling races the server's flush, gives stale reads, and loses local edits. The renderer must be a proper Yjs client using `@jupyter/ydoc` (which wraps the JupyterLab schema) + `y-websocket` against `/api/collaboration/room/<format>:<type>:<file_id>`. Bind `Y.Text` to CM6 via `y-codemirror.next`. Awareness protocol (cursors of other clients) is a separate, easy add later.
2. **CodeMirror 6, not Monaco.** Counter to Electron-default instinct. CM6 is what JupyterLab uses, the kernel `complete_request` / `inspect_request` glue is battle-tested there, and CM6 tree-shakes small enough that 1000 cells is feasible. 1000 Monaco editors is not. Monaco also fights Electron over global keybindings.
3. **`status: idle` on iopub, not `execute_reply`, is the only true "cell done" signal.** Same rule we already learned in `jupyter-kernel-client.ts` — applies identically in the UI.
4. **Stream coalescing + `\r` overwrite for tqdm.** A `for i in range(1000): print(i)` produces 1000 DOM nodes if you don't merge consecutive same-name streams the way nbformat specifies. tqdm progress bars depend on `\r` overwriting the current line. Use `anser` for ANSI color (not `ansi_up` — historical XSS).
5. **Punt ipywidgets, Bokeh, Holoviews in v1.** They aren't render formats — they're comm-managed object graphs (Backbone models for ipywidgets, runtime script injection for Bokeh/Holoviews). Each is 2–4 weeks of work to support properly. Render `[Interactive widget — open in JupyterLab]` placeholder. Add later if needed.
6. **Trusted vs untrusted cells.** nbformat has `metadata.trusted` per cell; JupyterLab refuses to render `text/html` and `image/svg+xml` in untrusted cells. Mirror this or the renderer becomes a phishing vector for shared notebooks.
7. **Save conflicts under RTC.** With `jupyter-collaboration` on, write *only* through the ydoc. Any contents-API PUT will be clobbered by the next ydoc flush — pick one write path.
8. **Virtualize, but carefully.** `@tanstack/react-virtual` with `measureElement` (cells have variable height; `react-window` is too rigid). Don't naively unmount CM6 instances on scroll — persist `EditorState.toJSON()` or use a windowed-but-large overscan, otherwise scrolling away loses cursor and undo history.
9. **Output throttling.** Buffer chatty cells in a ref, flush to React state on `requestAnimationFrame`. Without this, the kernel WebSocket backpressures and execution slows.
10. **Image base64 → Blob URL once.** Don't keep multi-MB base64 strings in React state across renders; convert via `URL.createObjectURL` once, store the URL, revoke on unmount.
11. **Kernel reconnect message loss.** `@jupyterlab/services` `KernelConnection` reconnects but messages sent during the gap are lost — no replay. Track pending `msg_id`s and surface "reconnected — output may be incomplete" rather than pretending it's fine.
12. **`@jupyterlab/services` ESM/CJS in Vite.** Historically painful — pinned versions and `optimizeDeps.include` entries needed. We already wrangle this in `jupyter-kernel-client.ts` (main process); renderer-side will likely need similar treatment.

### Cell component shape (plain english)

Each cell is a small React component that knows three things:

1. **Who it is** — `cell_id` (nbformat 4.5 UUID) and cell type (`code` or `markdown`).
2. **What it contains** — source text, held in the Yjs document, *not* in React state. The CM6 editor binds to a `Y.Text` via `y-codemirror.next`. React subscribes but doesn't own.
3. **How it's feeling** — runtime status (`idle | queued | running | done | errored`), kept in a separate per-cell atom so a status change doesn't re-render the editor.

The cell itself is a dumb presenter. It doesn't decide when to execute and doesn't own content or kernel state. A parent `NotebookView` owns the ydoc, owns the `ServiceManager` / `KernelConnection`, and owns the kernel-event bus that fans iopub messages out to the right cell.

Outputs are a third subcomponent. They subscribe to an output ringbuffer that buffers iopub messages in a ref and flushes to React state on `requestAnimationFrame`. Without that flush throttling, a chatty `print` loop melts the renderer and back-pressures the WebSocket.

Why this three-part split matters for "silky smooth": a status change (running → done) must not trigger an editor re-render, and an output arriving must not trigger an editor re-render. Separating `source` / `status` / `outputs` into three subscriptions is the difference between a 5 ms update and a 50 ms one.

### Virtualization harness (plain english)

A notebook is a vertical list of cells with variable heights. `@tanstack/react-virtual` with `measureElement` handles the math: each cell reports its height on first mount, we cache it, off-screen cells become `<div style={{height: cachedHeight}} />` placeholders so the scrollbar stays honest.

The rules that keep this from breaking:

- **Never unmount a running cell.** A cell that scrolled offscreen mid-execution must keep receiving iopub messages. Unmount the CM6 editor and the output renderer if we must — but keep the cell's entry in the kernel-event bus and keep its output buffer alive.
- **Persist editor state across unmount.** When a cell unmounts, snapshot `EditorState.toJSON()` into an in-memory map keyed by `cell_id`. Re-mount reads from that map so scrolling back doesn't lose cursor, selection, or undo history.
- **Reserve image space early.** Images arriving asynchronously cause height churn and scroll jumps. When iopub delivers an image, if the metadata carries dimensions, reserve them before the Blob URL loads.
- **Overscan generously for small notebooks, tightly for huge ones.** A 20-cell notebook should just render all 20; a 1000-cell notebook renders ~10 around the viewport. Overscan tuning is a knob we'll set empirically after the benchmark.

### Before we start coding — research checklist

1. ~~**CM6 mount/unmount benchmark.**~~ **Resolved by research pass 2026-04-20.** See [CM6 research findings](#cm6-research-findings-2026-04-20) below — the answer is that "200 editors mounted" is a risk area, so the design pivots to mount CM6 only for visible cells and use static syntax-highlighted HTML for offscreen cells (the Observable / Pluto / Marimo pattern). Replaces the originally-planned "aggressive mount/unmount" strategy.
2. **Output renderer in isolation first.** This is where perceived snappiness lives or dies. Prototype against a real GIS notebook with matplotlib figures, pandas `DataFrame` reprs, folium maps. If this feels janky, nothing else matters.
3. **Yjs room addressing dry-run.** `jupyter-collaboration` rooms are `<format>:<type>:<file_id>`. Confirm how to get `file_id` from a path (probably via `jupyter-server-fileid`'s contents API extension), and that `y-websocket` connects cleanly using the same empty-token auth the iframe uses.
4. **Dashboard theme token audit.** Does the renderer expose a reusable CSS variable set today, or do we need to extract one? Affects whether "matches the dashboard" is a CSS import or a full design pass.
5. **Status animation prior art.** Reference Hex and Deepnote — Jupyter's indicators are too busy. A single pulsing dot + thin top progress bar is probably sufficient; verify by prototyping on a static mock before wiring kernel state.
6. **`execute_notebook` error semantics.** Decide upfront: stop-on-first-error (matches Datalayer) vs continue-through (matches nbconvert `--execute`). Stop-on-first-error is simpler for agents and matches how humans debug. Lock this in before writing the tool.
7. ~~**Confirm Yjs + CM6 binding version compatibility.**~~ **Resolved by research pass 2026-04-20.** Known-good version pins documented below.

### CM6 research findings (2026-04-20)

Deep research pass before committing to CM6 as the editor primitive. **Bottom line: GO, with caution.** CM6 is what JupyterLab 4, Pluto.jl, and Marimo all ship. ~75 KB gzipped lean, ~40–60 KB more for the Yjs binding. Confirmed right choice. Three findings reshape the plan:

**Finding 1 — "mount 500 editors" is not safe. Mount only visible cells.**

No public benchmarks exist — the CM6 team explicitly says so. The one real-world data point (100 simultaneous editors) hit forced-reflow jank from `readSelectionRange` → `getBoundingClientRect` with no clean workaround. Mount-cost math is dominated by extension-tree resolution and initial DOM measure; themes and extensions can be hoisted to module scope to share across instances, but per-view DOM + measure is unavoidable.

**Design pivot:** offscreen cells render as static `<pre>` with `lowlight`-produced syntax highlighting. CM6 is mounted only when a cell enters the viewport. This is the Observable / Pluto.jl / Marimo pattern. Crucially, the underlying `Y.Text` stays alive regardless of mount state — remote edits accumulate via CRDT, and remounting reads current state from the Y.Text with no reconstruction loss. The "never unmount a running cell" rule from the virtualization harness section still applies (keep the output buffer alive), but it no longer requires keeping CM6 mounted — the output renderer is separate.

**Finding 2 — use `@jupyter/ydoc`, not raw Yjs.**

JupyterLab stores cell source as a nested `Y.Text` inside a `Y.Map`. Raw Yjs has a well-known footgun there: if each client does `new Y.Text()` + `ymap.set()` at init, clients stomp each other's refs. `@jupyter/ydoc` is the adapter the JupyterLab team built to wrap this correctly — cell ymaps are pre-initialized, each holding a stable `source` Y.Text. **Do not hand-roll the cell schema.** Pulling in the full `@jupyterlab/codemirror` class drags Lab scaffolding (`IEditorExtensionRegistry`, `IEditorLanguageRegistry`, etc.) — roll a thin ~200-line wrapper instead, and steal three patterns from Lab's source:

- `Compartment` for language / theme reconfiguration (see their `editor.ts` lines 82–110).
- `ensureSyntaxTree` for token extraction — useful for context-aware completion later.
- `EditorView.domEventHandlers` with `Prec.high` for keybinding precedence (the old `addKeydownHandler` is gone in Lab 4.x).

**Finding 3 — Vite + CM6 has a multi-copy footgun.**

Multiple copies of `@codemirror/state` in the bundle break `instanceof` checks with `"Unrecognized extension value in extension set"`. Fix is both `optimizeDeps.include` for CM6 packages *and* `resolve.dedupe: ['@codemirror/state', '@codemirror/view']`. Also worth pinning: IME regression in `@codemirror/view` 6.28.2 (Chinese input), focus-trap issue #1414 (closing a dialog while CM6 is focused can brick sibling inputs). Neither blocks us; both warrant choosing a known-good patch version at pin time.

**Known-good version pins:**

```
yjs                      ^13.6
y-codemirror.next        ^0.3.5
@codemirror/state        ^6.4
@codemirror/view         ^6.26
@codemirror/commands     ^6.5
@codemirror/language     ^6.10
@codemirror/autocomplete ^6.18
@codemirror/lang-python  ^6.1
@jupyter/ydoc            ^3.0
```

Do **not** adopt the WIP `@y/codemirror` rewrite or Yjs v14 — both still in flux.

**Alternative worth a second look:** [`@marimo-team/blocks`](https://www.npmjs.com/package/@marimo-team/blocks). Marimo's team shipped React cell components (`CellEditor`, `CellOutput`, `CellRunButton`) on CM6 for their own notebook product. If the schema and licensing fit our needs, this could save weeks. Worth a 30-minute evaluation before M1 coding starts.

**The one-hour de-risk spike that replaces the original CM6 benchmark:**

Mount 200 CM6 editors bound to a single `@jupyter/ydoc` `YNotebook` inside a `@tanstack/react-virtual` list, scroll hard. Covers three compound risks at once: the nested-Y.Text footgun (via the real adapter, so we know `@jupyter/ydoc` works as advertised), the virtualizer × mount/unmount interaction, and the `readSelectionRange` forced-reflow scenario at scale. **If 60fps holds with mount-on-enter / unmount-on-exit, the entire CM6 risk pile is cleared.** If it janks, the Observable static-pre pattern is the bulletproof fallback and is what a disciplined implementation ends up at anyway.

**Sources:** CodeMirror discuss forum (perf benchmarks, forced reflows, memory leaks threads), Yjs docs + discuss (nested shared types), JupyterLab `@jupyterlab/codemirror` source + extension migration guide, Sourcegraph's Monaco → CM6 migration writeup, Pluto.jl and Marimo source. Full source list in the research agent transcript.

### Discarded ideas (and why) — for the record so we don't re-litigate

- **Diff-mode proposals / approval queue** — adds friction to the autonomous loop. Agents are competent enough to edit and re-run; if they break something, git is the rollback.
- **Provenance ribbon / per-cell author attribution** — clutter for marginal value. Git history attributes changes; per-cell display is visual noise.
- **Speculative execution in forked kernels** — only useful as input to a diff/approval UI we're not building.
- **Prompt-as-source cells (Hex pattern)** — interesting in isolation but pulls the workflow toward "describe and regenerate," which is the opposite of the autonomous-edit loop.
- **`@datalayer/jupyter-react` swap-in** — still installed, but the iframe-CSS-then-custom-React path skips it entirely. It inherits JupyterLab's CSS, which doesn't solve the visual-overwhelm problem.
- **AI chat sidebar** — universally underwhelming in shipped products (Jupyter AI, Copilot Chat in notebooks). Context-switch kills flow; users abandon it within a week.

## Reference — the approved plan file

`C:\Users\turke\.claude\plans\wsl-side-only-wobbly-lamport.md`

That file has the full context, architecture diagrams, milestone-by-milestone verification steps, and the risk list. This document is a post-implementation summary; the plan is the spec.
