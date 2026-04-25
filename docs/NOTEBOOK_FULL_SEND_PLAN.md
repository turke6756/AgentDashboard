# Notebook Renderer — Full-Send Plan

> **Audience:** an autonomous agent executing this rebuild.
> **Companion doc:** [`NOTEBOOK_PROTOTYPE.md`](./NOTEBOOK_PROTOTYPE.md) holds the *why*. This doc is the *how*, in execution order. Read the companion's "Crystallized product vision" and "CM6 research findings" sections before starting.

## Mission

Replace the iframe-embedded JupyterLab renderer with a custom React surface that (a) binds to the existing `jupyter-collaboration` ydoc for live sync, (b) exposes only the minimum affordances — run all / run cell / add cell / interrupt / restart, (c) shows clear per-cell and notebook-level execution status, (d) matches the dashboard's visual language, (e) lets agents drive the whole thing via existing + new MCP tools.

**Do not change the server side.** `src/main/jupyter-server.ts`, `src/main/jupyter-kernel-client.ts`, the HTTP API in `src/main/api-server.ts`, and the MCP servers in `scripts/mcp-*.js` all stay working. We are replacing the view only. The one exception is *adding* (never modifying) a new `execute_notebook` endpoint in Phase 3.

## Before any agent starts

**Human prerequisites** (the user handles these — the agent should refuse to start until confirmed):

1. `git status` is clean on a feature branch (suggested: `notebook-full-send`).
2. `git push` to remote — this plan deletes working code; the remote is the safety net.
3. `npm run build` is green before first commit of this plan.
4. User has accepted that **notebooks will be broken from end of Phase 0 until mid Phase 2** (~1 week of downtime). The existing renderer disappears and no replacement works until rendering lands.

## Rules of engagement (agent)

- **Commit at the end of every phase.** Message format: `notebook full-send phase N: <phase name>`. No amending.
- **`npm run build` must pass at the end of every phase.** If it doesn't, fix or stop — do not commit a broken build.
- **Stop and report to the human at every `STOP` marker in this doc.** Do not proceed past one without explicit confirmation.
- **Do not delete old code until Phase 5.** Orphan it with clear comments if needed; cleanup is its own phase.
- **If an acceptance check fails, stop.** Do not "try harder" through repeated variations. Report: what step, what error, what you tried, what you think the cause is.
- **Electron does not hot-reload the main process.** Any change under `src/main/` requires quitting and relaunching the app. This is documented in `NOTEBOOK_PROTOTYPE.md` section "Phase 1 outcome — Supervisor distribution: lessons from the live test", point 5.
- **Time estimates are budgets, not targets.** If a phase runs 50% over budget, stop and re-plan — something the research missed is biting.

## Version pins (from research)

All CM6-related packages must be installed at these versions. Mismatches cause the `"Unrecognized extension value in extension set"` runtime error.

```
yjs                      ^13.6
y-codemirror.next        ^0.3.5
y-websocket              ^2.0
@codemirror/state        ^6.4
@codemirror/view         ^6.26
@codemirror/commands     ^6.5
@codemirror/language     ^6.10
@codemirror/autocomplete ^6.18
@codemirror/lang-python  ^6.1
@codemirror/lang-markdown ^6.3
@jupyter/ydoc            ^3.0
@tanstack/react-virtual  ^3.10
lowlight                 ^3.3
react-markdown           ^9.0
remark-math              ^6.0
rehype-katex             ^7.0
katex                    ^0.16
anser                    ^2.1
```

---

## Phase 0 — Demolition + dependencies (~half day)

**Goal:** iframe code removed, stub component in place, new deps installed, Vite config updated, build green.

### Files

- **DELETE:** `src/renderer/components/fileviewer/InteractiveNotebookRenderer.tsx`
- **CREATE:** `src/renderer/components/notebook/NotebookView.tsx` (stub only)
- **MODIFY:** `src/renderer/components/fileviewer/FileContentRenderer.tsx` (route `.ipynb` → stub)
- **MODIFY:** `package.json`
- **MODIFY:** `vite.config.ts` (add `optimizeDeps.include` + `resolve.dedupe` for `@codemirror/state` and `@codemirror/view`)

### Steps

1. Read `NOTEBOOK_PROTOTYPE.md` end-to-end. Confirm you understand the product vision, known technical findings, and why the iframe is being removed.
2. Verify `git status` clean, on a feature branch.
3. Install deps — single `npm install` command with all packages from the version-pin table above. If install takes >5 min or errors, STOP.
4. Update `vite.config.ts`:
   ```ts
   optimizeDeps: {
     include: ['@codemirror/state', '@codemirror/view', 'yjs', 'y-codemirror.next']
   },
   resolve: {
     dedupe: ['@codemirror/state', '@codemirror/view']
   }
   ```
   Preserve any existing entries.
5. Create `src/renderer/components/notebook/NotebookView.tsx`:
   ```tsx
   // Stub only — real implementation lands in Phase 1+.
   export function NotebookView({ path }: { path: string }) {
     return (
       <div style={{ padding: 24 }}>
         <h2>Notebook renderer rebuild in progress</h2>
         <p>Phase 0 stub. File: {path}</p>
       </div>
     );
   }
   ```
6. In `FileContentRenderer.tsx`, replace the `InteractiveNotebookRenderer` import + usage with `NotebookView`. Keep the same prop shape the router expects.
7. Delete `InteractiveNotebookRenderer.tsx`.
8. `npm run build` — must pass.
9. `npm run start` — click any `.ipynb` file in the dashboard. Confirm the stub appears with the correct path.

### Acceptance

- [ ] `npm run build` passes.
- [ ] Grep returns nothing: search `InteractiveNotebookRenderer` across `src/`.
- [ ] App launches and the stub renders on any `.ipynb` click.
- [ ] `git diff --stat` shows only: package.json, package-lock.json, vite.config.ts, FileContentRenderer.tsx, NotebookView.tsx (new), InteractiveNotebookRenderer.tsx (deleted).

### Commit

`notebook full-send phase 0: demolition + deps`

### STOP

Report to the user. Confirm the stub works in the running app before proceeding.

---

## Phase 1 — Ydoc sync (1–2 days)

**Goal:** Opening a notebook file connects to `jupyter-collaboration`, the ydoc syncs, cells stream into the renderer and are logged to console. Still read-only.

### Riskiest step of the whole project

This is where we learn whether our understanding of the collaboration room addressing is correct. If the WebSocket won't connect or the ydoc doesn't populate, **do not invent workarounds** — stop, investigate with a throwaway script against the running jupyter-server, and report findings.

### Files

- **CREATE:** `src/renderer/lib/jupyterCollab.ts` — file_id resolution, WS URL assembly.
- **CREATE:** `src/renderer/hooks/useYNotebook.ts` — React hook wrapping the provider.
- **MODIFY:** `src/renderer/components/notebook/NotebookView.tsx` — wire to the hook, log cells.

### Steps

1. **Resolve `file_id` for a path.** Jupyter-server-fileid exposes file IDs via the contents API response when installed (metadata field). The exact endpoint/shape must be verified. Write a throwaway script `scripts/probe-collab-room.mjs` that:
   - Calls `ensureJupyterServer()` indirectly by reading `window.api.notebooks.ensureServer()` isn't applicable here — script runs in Node, so replicate: `fetch(baseUrl + 'api/contents/<path>')` with bearer token (empty) and log the response.
   - Documents the actual JSON shape of the response in a comment at the top of `jupyterCollab.ts`.
   - Delete after use.
2. **Build `jupyterCollab.ts`.** Functions:
   - `getFileId(baseUrl: string, path: string): Promise<string>`
   - `getCollabRoomUrl(baseUrl: string, fileId: string): string` → returns `ws://127.0.0.1:<port>/api/collaboration/room/json:notebook:<fileId>`
3. **Build `useYNotebook.ts`.** Hook signature: `useYNotebook(path: string): { ydoc: Y.Doc | null, ynotebook: YNotebook | null, status: 'connecting' | 'synced' | 'error', error?: string }`.
   - Use existing `useJupyterServer()` for baseUrl.
   - Create `Y.Doc`, `WebsocketProvider` from `y-websocket`.
   - Wrap with `YNotebook` from `@jupyter/ydoc`.
   - On `provider.on('sync')` → status = 'synced'.
   - Cleanup: `provider.destroy()`, `ydoc.destroy()` on unmount.
4. **Wire into `NotebookView.tsx`.** Log each cell's `cell_type` and first 80 chars of source to console. Show status in the UI as text ("connecting…" / "synced" / error).
5. `npm run build`, `npm run start`, open a real notebook.
6. DevTools console must show cells streaming in and `"synced"` status in the UI.

### Acceptance

- [ ] DevTools console logs every cell's `cell_type` + source preview.
- [ ] Status text in UI reads "synced" after connection.
- [ ] No WebSocket errors in DevTools Network tab.
- [ ] Quitting the app cleanly destroys the provider (no "WebSocket still open" warnings in next launch).

### Commit

`notebook full-send phase 1: ydoc sync`

### STOP

Show the human the console log of a synced notebook. Do not proceed to rendering until they confirm the data looks right.

---

## Phase 2 — Rendering layer (~1 week)

**Goal:** Read-only notebook surface. Cells render. Outputs render. Markdown renders. Scrolling is smooth with 100+ cell notebooks.

Execute subphases in order. Each is its own commit.

### 2a — Output renderer (standalone, ~1 day)

**Files:**
- **CREATE:** `src/renderer/components/notebook/OutputRenderer.tsx`
- **CREATE:** `src/renderer/components/notebook/outputUtils.ts`

**Steps:**
1. Build `OutputRenderer({ outputs }: { outputs: IOutput[] })`. Handles mime types in priority order: `image/png`, `image/jpeg`, `image/svg+xml`, `text/html` (sanitized via DOMPurify or equivalent — add dep if needed), `text/markdown` (via react-markdown), `application/json` (collapsible `<details>`), `text/plain` (fallback).
2. Stream outputs (`name: 'stdout' | 'stderr'`): coalesce consecutive same-name streams per nbformat spec, apply `\r` overwrite for tqdm, ANSI color via `anser`.
3. Images: convert base64 → Blob URL once on mount via `URL.createObjectURL`, revoke on unmount. Store URLs in a `useRef` Map to avoid re-creation on re-render.
4. Widget mimes (`application/vnd.jupyter.widget-view+json`, `application/vnd.bokehjs_exec.v0+json`): render placeholder `[Interactive widget — not supported in v1]`.
5. **Ringbuffer + rAF throttle:** outputs arrive via prop updates in this phase (read-only). Throttling matters in Phase 3 when live iopub streams. Structure the component so adding the throttle later is a one-line change (pass outputs through a ref that flushes to state on `requestAnimationFrame`).

**Acceptance:** manually feed the component canned outputs (hardcode a test notebook's outputs in a dev route). All mime types render. Stream with `\r` overwrites. Widget placeholder appears.

**Commit:** `notebook full-send phase 2a: output renderer`

### 2b — Markdown cells (~half day)

**Files:**
- **CREATE:** `src/renderer/components/notebook/MarkdownCell.tsx`

**Steps:**
1. `react-markdown` + `remark-math` + `rehype-katex`. Import `katex/dist/katex.min.css` once at renderer entry.
2. Respect `metadata.trusted` — untrusted markdown cells render but strip raw HTML (react-markdown default).

**Acceptance:** notebooks with markdown + LaTeX render correctly. Math inline and block.

**Commit:** `notebook full-send phase 2b: markdown cells`

### 2c — Code cells (CM6 + lowlight, ~2 days)

**Files:**
- **CREATE:** `src/renderer/components/notebook/CodeCell.tsx`
- **CREATE:** `src/renderer/components/notebook/codeMirrorSetup.ts` — module-scope extension/theme arrays (hoisted per research finding to share across instances).
- **CREATE:** `src/renderer/components/notebook/StaticCodeBlock.tsx` — offscreen `<pre>` + lowlight.

**Steps:**
1. In `codeMirrorSetup.ts`, build a single exported `extensions: Extension[]` array at module scope: base keymaps, history, `lang-python` (default), search, line numbers, theme via `EditorView.theme`. Use `Compartment` for language so we can switch per-cell if future cells tag R, SQL, etc. (Lab pattern — see research finding §3.)
2. `CodeCell` component: takes `{ cellId, ytext, language, onFocus }`. On mount, create `EditorView` with the shared extensions array + `yCollab(ytext, awareness, { undoManager })`. On unmount, `view.destroy()`.
3. `StaticCodeBlock` component: lowlight syntax-highlight the source to HTML, render in a `<pre>`. Used for offscreen cells in 2d.
4. **Critical:** at this point both components are testable in isolation. Don't virtualize yet — render every cell fully as CM6 and verify correctness first.

**Acceptance:** open a real notebook, every code cell is an editable CM6 editor with Python highlighting. Typing shows up in the ydoc (verify via DevTools — the iframe won't exist but you can verify the Y.Text updates by logging in the hook).

**Commit:** `notebook full-send phase 2c: code cells`

### 2d — Virtualization + mount-on-visible (~1.5 days)

**Files:**
- **MODIFY:** `src/renderer/components/notebook/NotebookView.tsx` — wrap cell list in `useVirtualizer`.
- **CREATE:** `src/renderer/components/notebook/CellShell.tsx` — picks CM6 or static-pre based on visibility.

**Steps:**
1. `useVirtualizer` from `@tanstack/react-virtual`, `estimateSize` = 200px (rough), `measureElement` to record real heights, overscan 5.
2. `CellShell` props: `{ cell, isVisible }`. Visible: `<CodeCell>` / `<MarkdownCell>`. Not visible: `<StaticCodeBlock>` / static rendered markdown.
3. **Do not unmount outputs.** Outputs render in both visible and static paths. Phase 3 will add live streaming; the output component must stay subscribed to the ringbuffer regardless of cell visibility.
4. Test with a 100+ cell notebook. Open DevTools Performance, scroll for 10 seconds, verify no long tasks > 50ms.

**Acceptance:**
- [ ] 100-cell notebook scrolls at 60fps (check Performance panel FPS meter).
- [ ] Scrolling a cell offscreen then back does not lose content (Y.Text survives — this is by design).
- [ ] No memory growth after 50 scroll cycles (Performance monitor).

**Commit:** `notebook full-send phase 2d: virtualization`

### STOP

Show the human the working read-only notebook surface. This is the first visible milestone since Phase 0 demolition. They should confirm visual direction before Phase 3 wires up execution.

---

## Phase 3 — Execution + interaction (~1 week)

**Goal:** All user actions work. `execute_notebook` MCP tool added. Per-cell and notebook-level status animations. Agents can drive the whole thing.

### 3a — Toolbar + per-cell run button (~1 day)

**Files:**
- **CREATE:** `src/renderer/components/notebook/NotebookToolbar.tsx`
- **CREATE:** `src/renderer/components/notebook/CellToolbar.tsx`
- **CREATE:** `src/renderer/hooks/useNotebookActions.ts` — wraps calls to existing `/api/notebooks/kernel/*` endpoints via `fetch`.

**Buttons (notebook toolbar):** Run all • Add code • Add markdown • Interrupt • Restart • Kernel status readout.
**Buttons (cell toolbar, shown on hover):** Run • Delete • Move up • Move down.

All execute actions hit existing HTTP API (already shipped Phase 1). Add cell / delete cell / move cell mutate the ydoc directly.

**Acceptance:** every button works end-to-end with a live kernel.

**Commit:** `notebook full-send phase 3a: toolbars + actions`

### 3b — Status ring + activity bar (~1 day)

**Files:**
- **CREATE:** `src/renderer/components/notebook/CellStatusRing.tsx`
- **CREATE:** `src/renderer/components/notebook/NotebookActivityBar.tsx`
- **CREATE:** `src/renderer/stores/cellStatus.ts` — Zustand or React context for per-cell status map `{ [cellId]: 'idle'|'queued'|'running'|'done'|'error' }`.

**Steps:**
1. Subscribe to iopub from the existing kernel connection. Messages carry `parent_header.msg_id` — map to `cellId` via an in-memory map populated when a cell's execute is dispatched.
2. Status ring: CSS keyframe `@keyframes pulse` on `opacity`/`transform` only. Idle = dim dot, queued = outlined ring, running = pulsing filled ring, done = brief flash + number, error = red persistent.
3. Notebook activity bar: thin top strip, hidden when idle, animated gradient fill while any cell is running, red when any cell errored in the last run.
4. Bar and rings use dashboard theme tokens (extracted in Phase 4; for now, hardcode a placeholder color).

**Acceptance:** run a cell, see the ring pulse then confirm. Run all, see the activity bar. Break a cell, see the error state persist.

**Commit:** `notebook full-send phase 3b: status animations`

### 3c — `execute_notebook` tool (~1 day)

**Files:**
- **MODIFY:** `src/main/jupyter-kernel-client.ts` — add `executeNotebook(path, timeout)` method.
- **MODIFY:** `src/main/api-server.ts` — add `POST /api/notebooks/kernel/execute-notebook` route.
- **MODIFY:** `scripts/mcp-supervisor.js` — add `execute_notebook` tool definition + handler.

**Steps:**
1. `executeNotebook` iterates cells in order, calls the existing `executeCell` for each code cell, stops on first non-`ok` status. Returns `{ status: 'ok'|'interrupted'|'failed', last_executed_cell_id, failed_cell_id?, error?, outputs_summary }`.
2. API route passes through to the client method.
3. MCP tool mirrors existing `execute_cell` tool shape. Document it in the supervisor's tool docs section in `src/shared/constants.ts` under `SUPERVISOR_AGENT_MD` (per companion doc's "Supervisor distribution" lesson #1, this only affects *future* scaffolds — that's fine for now; human can manually update their workspace CLAUDE.md).

**Acceptance:** from an MCP client, call `execute_notebook` on a real notebook. Verify `outputs_summary` shape. Break a cell and verify `failed_cell_id` is populated.

**Commit:** `notebook full-send phase 3c: execute_notebook tool`

### STOP

Show the human the fully functional notebook with execution. Debug loop is now testable: break a cell, ask supervisor to fix it via `execute_notebook` + `execute_cell` + content edits. They should confirm the agent workflow feels right.

---

## Phase 4 — Theme + agent skill (~3–4 days)

### 4a — Theme tokens (~1.5 days)

**Files:**
- Audit existing renderer for CSS variables. Most likely `src/renderer/index.css` or similar defines `--surface-*`, `--text-*`, `--accent-*`.
- Apply consistently across `NotebookView`, `CellShell`, toolbars, output renderer. Replace any hardcoded colors.

**Acceptance:** notebook visually matches the dashboard chrome. Dark/light mode (if the dashboard supports it) switches cleanly.

**Commit:** `notebook full-send phase 4a: theme`

### 4b — `notebook-debug-loop` agent skill (~1 day)

**Files:**
- **CREATE:** `.claude/skills/notebook-debug-loop/SKILL.md` (location may differ — check existing skills in `.claude/skills/` or wherever the agent dashboard stores its skills).

**Content:** short, example-driven. Documents the pattern:
1. `execute_notebook(path)`.
2. If status !== 'ok', read `failed_cell_id` and `outputs_summary`.
3. Edit the cell (via file edit through Contents API — or, if ydoc write is exposed to agents, via ydoc).
4. Re-run `execute_range` from failed cell to end, or just `execute_cell` if isolated.
5. Loop until status === 'ok' or a stopping condition (e.g., same error twice).

**Acceptance:** hand the supervisor a deliberately broken GIS notebook, watch it fix itself while the human scrolls the UI.

**Commit:** `notebook full-send phase 4b: agent skill`

### 4c — Edge cases (~1–1.5 days)

Run through:
- Empty notebook.
- Notebook with only markdown cells.
- Kernel restart mid-execution.
- WebSocket disconnect/reconnect (simulate by killing and restarting the jupyter-server).
- 10MB DataFrame repr in a cell output.
- Interrupt while cells are queued.
- Notebook file renamed externally (file_id invariant should hold).

For each: reproduce, fix or document as known caveat.

**Commit:** `notebook full-send phase 4c: edge cases`

---

## Phase 5 — Cleanup (~2 days)

**Goal:** No dead code. No TODO comments from the build. Final E2E.

### Steps

1. Grep for TODO/FIXME comments added during the build. Resolve or file as tracked issues.
2. Remove any debug `console.log` calls.
3. Remove the throwaway `scripts/probe-collab-room.mjs` if it still exists.
4. Update `NOTEBOOK_PROTOTYPE.md` "Phase 2 plan" section → add a "Phase 2 outcome" subsection summarizing what shipped, what deferred, and what surprised.
5. Full manual E2E: open a fresh notebook, add code cell, add markdown cell, run all, break a cell, have the supervisor fix it, restart kernel, close & reopen the notebook, verify state.

### Acceptance

- [ ] `npm run build` green.
- [ ] No `console.log`/`console.debug` left in new code.
- [ ] `NOTEBOOK_PROTOTYPE.md` updated with outcome section.
- [ ] Manual E2E checklist passes.

**Commit:** `notebook full-send phase 5: cleanup + docs`

### STOP

Final review with the human. PR-ready.

---

## Troubleshooting reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `Unrecognized extension value in extension set` | Multiple copies of `@codemirror/state` in bundle | Ensure `resolve.dedupe` in `vite.config.ts` includes `@codemirror/state` and `@codemirror/view`; check `npm ls @codemirror/state` shows only one version |
| WebSocket 403 on `/api/collaboration/room/...` | Trailing space in `Authorization: token ` header | Drop the Authorization header entirely from the `WebsocketProvider` params |
| Ydoc connects but no cells appear | Room URL format wrong | Verify it's `json:notebook:<file_id>`, not `<file_id>` alone. File_id comes from jupyter-server-fileid; confirm the extension is installed and returning IDs on `/api/contents` |
| CM6 editor renders but typing does nothing | `yCollab` not applied, or Y.Text is a placeholder that was `.set()` twice (ref stomped) | Use `@jupyter/ydoc`'s `YNotebook` — do not hand-create `Y.Text` on a `Y.Map` |
| Scrolling janks with 50+ cells | Themes/extensions being re-created per instance | Hoist `extensions` to module scope in `codeMirrorSetup.ts` |
| Image base64 outputs balloon memory | Base64 strings held in React state across renders | Convert to Blob URLs once, store URL (not base64) in state, revoke on unmount |
| Status ring never updates to "done" | Subscribed to `execute_reply` not `status: idle` | Use `future.done` or iopub `status: idle` matching parent `msg_id` — see `jupyter-kernel-client.ts` for the reference pattern |
| Main-process changes don't take effect | Electron doesn't hot-reload main bundle | Quit and relaunch the app |
| Cell source not syncing to disk | Writing via contents API instead of ydoc | With `jupyter-collaboration` on, ydoc is the only write path — contents PUT gets clobbered |
| IME (Chinese/Japanese) input broken | Known regression in `@codemirror/view` 6.28.2 | Pin to 6.26.x or the latest post-6.28.2 patch that fixes CM issue #1396 |

## Final note to the agent

This plan is ordered; don't skip ahead. Every phase has an acceptance check — run it, don't assume. Commits are load-bearing for anyone picking up the work if context is lost. When in doubt, stop and ask the human rather than invent.
