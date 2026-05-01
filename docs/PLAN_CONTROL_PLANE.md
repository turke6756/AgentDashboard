# Plan Control Plane — v1 Specification

*Distilled 2026-04-29 from `CorePrimatives_EdTurk_042826.md` after two rounds of independent review. This document is the buildable contract; the source doc has the discussion that produced it.*

> **Naming locked 2026-04-29.** The umbrella product name is **orchestration** — see "Decisions Locked — 2026-04-29" in `CorePrimatives_EdTurk_042826.md`. New types, routes, and MCP tools that bridge this spec to the orchestration layer use the `Orchestration*` / `/api/orchestration/*` / `orchestration_*` prefixes. Names internal to the plan substrate (`Plan`, `PlanProjection`, `PlanCompact`, `/api/plans/...`) stay as-is — the plan is the artifact; the orchestration layer is what *drives* it.
>
> **Plans-location locked 2026-04-29.** Plan markdowns live at `<workspace>/plans/*.md`, **not** under `.claude/`. Run logs go in `<workspace>/plans/.runs/`. This doc has been updated in place; older path references in `CorePrimatives_EdTurk_042826.md` (Phase 1 Findings, Recon Findings, etc.) are historical record. All paths in this spec are workspace-relative.

---

## Goal

Track in-flight multi-agent work as live, shared state with a single canonical representation that simultaneously:

- Drives the dashboard UI live as agents make progress.
- Drives orchestration scripts that decide what to spawn / fork / delay next.
- Serves MCP read tools that worker agents call to orient themselves.
- Lives on disk as human-readable, git-committable markdown.

## Architecture

### Read path

```
plans/<slug>.md          (canonical, on disk)
        |
        | fs-watcher (existing dual-backend; requires polling fix — see "Required fixes")
        v
   plan-parser  (main process, pure TypeScript, testable)
        |
        v
   PlanProjection (typed, in-memory)
        |
        +-- renderer IPC push --> Zustand store --> Plans pane UI
        |
        +-- HTTP API consumers --> orchestration scripts
        |
        +-- MCP compact-read --> worker agents
```

The renderer never reads the markdown file directly. Every consumer reads the projection (or a derived shape).

### Write path

```
caller (script, MCP tool, UI button, worker agent)
        |
        v
   HTTP /api/plans/* (api-server.ts)
        |
        v
   plan-writer (new, sits on top of existing file-writer.ts)
        |
        v
   plans/<slug>.md       (canonical, source of truth)
        ^
        +-- fs-watcher fires --> parser reruns --> projection updates --> all consumers re-observe
```

Single coordinated mutation path for structured state changes. Status changes, assignments, blockers, run state, and other machine-readable fields go through the plan-writer.

Raw markdown edits are still possible because the markdown file is canonical and human-editable. Treat those as external mutations: the watcher sees the file change, the parser reconciles it, and the UI either updates the projection or falls back to raw markdown on parse failure. The system should make the structured API the normal path, but it should not pretend raw edits can be prevented.

### Boundary: orchestration script ≠ UI renderer

The orchestration script is a **state-transition engine**, not a UI renderer. It mutates canonical state via the write API and emits supervisor events through `event-payload-builder.ts`. It does **not** construct UI cards, panes, badges, or layout state. The dashboard observes `PlanProjection` and renders independently. UI redesigns must not require script changes.

---

## Three write modes

| Mode | Who | What | Mechanism |
|---|---|---|---|
| **Structured** | orchestration script, MCP tools, UI buttons | task status, assignment, blockers, phase run state | Plan-mutation API only. **Do not edit markers directly.** |
| **Append-only** | worker agents | notes, observations, findings | Prefer `append_note(...)`. Direct edits inside `<!-- notes: ... -->` blocks are tolerated for manual cleanup or tool fallback. |
| **Manual** | user | freeform — typo fixes, restructuring | Raw markdown edit. Parser revalidates on next watcher fire. UI falls back to "raw markdown + last-modified" on parse failure. |

**For agents:** the MCP tool surface should make the API the obvious default for structured mutations and notes. Direct marker edits are a fallback, not a normal path. Tool descriptions reflect this.

---

## File format

Flat files at `plans/<slug>.md`, per-workspace. No nested directories in v1.

YAML front-matter for plan-level metadata. HTML-comment markers for addressable units. Free prose between markers is preserved verbatim. Notes blocks are explicitly delimited.

Use a real YAML parser; do not hand-roll front-matter parsing. Add an explicit dependency such as `yaml` during implementation, or document a different parser choice in the PR. The current repo does not already include `yaml` or `gray-matter`.

```markdown
---
id: plan-2026-04-29-foo
name: Migrate auth middleware
created_at: 2026-04-29T14:00:00Z
run_state: ready
agent_assignments:
  agent-abc: [phase-1, phase-2]
  agent-def: [phase-3]
---

# Migrate auth middleware

Free-form intro prose lives here. Parser ignores it.

## Phase 1: Set up infra <!-- phase: id=phase-1 status=todo -->

Phase-level prose lives here, also ignored by the parser for projection purposes.

- [ ] Provision DB <!-- task: id=t1 status=todo -->
- [ ] Wire CI <!-- task: id=t2 status=todo blocked_by=t1 -->

<!-- notes: phase-1 -->
Free-form scribbling from worker agents lands here. Parser tolerates anything inside notes blocks.
<!-- /notes -->

## Phase 2: Cutover <!-- phase: id=phase-2 status=todo -->
...
```

### Marker rules

- Every phase and task has a stable UUID-like `id`. Never reused. Never index-based.
- Status enum: `todo` | `running` | `done` | `blocked` | `failed`.
- Plan-level `run_state` enum: `ready` | `running` | `delayed` | `paused` | `done` | `failed`.
- Marker attribute order is irrelevant. Whitespace tolerated.
- Parser must tolerate: missing optional attributes, extra whitespace, agent prose interleaved between markers, malformed individual markers (skip the marker, continue parsing).
- Malformed phase markers are skipped. Tasks under a malformed or missing phase are skipped with warnings rather than promoted to top-level tasks.
- On recoverable issues: emit a projection with warnings.
- On unrecoverable parse failure: emit `PlanParseError`, no projection.

### Plan identity

There are three identifiers with different jobs:

- `id` in front matter is the stable `plan_id` used by APIs and stored references.
- `<slug>.md` is the filename and may change if the user renames the file.
- `name` is display text and may change freely.

`list_plans(workspace_id)` maps every `plans/*.md` file to its front-matter `id`. Duplicate `id` values in the same workspace are list/validation errors. Write APIs take `plan_id`, resolve it to exactly one file in that workspace, and reject ambiguous or missing IDs.

---

## Type contract

Lives in `src/shared/plans.ts`. Defined day one, even if not all consumers are wired immediately.

```ts
type PlanStatus = 'todo' | 'running' | 'done' | 'blocked' | 'failed';
type PlanRunState = 'ready' | 'running' | 'delayed' | 'paused' | 'done' | 'failed';

interface PlanCanonical {
  // Full parsed structure. All notes, all metadata, all markers.
  // Used by: read_plan API, validate_or_repair, the plan-writer for diffing.
  warnings: PlanParseWarning[];
}

interface PlanProjection {
  // Typed UI shape. What the renderer subscribes to.
  // Includes: phases, tasks, statuses, agent assignments, run_state, last-modified.
  warnings: PlanParseWarning[];
  // Excludes: full notes (only counts/previews) — UI fetches full notes on demand.
}

interface PlanCompact {
  // Bounded shape for MCP / worker-agent consumers.
  // Notes truncated to N chars (v1: 200). Metadata always full.
  // What every worker agent sees when reading a plan via MCP.
}

interface PlanParseError {
  filePath: string;
  error: string;
  rawMarkdown: string;
  mtimeMs: number;
}

interface PlanParseWarning {
  code: string;
  message: string;
  line?: number;
  markerId?: string;
}

type Plan = PlanProjection | PlanParseError;  // renderer's effective type
```

---

## API surface

HTTP routes in `src/main/api-server.ts` under `/api/plans/*`. MCP wrappers in `scripts/mcp-supervisor.js`. Renderer IPC exposes the same behavior, but should not call localhost HTTP internally. Both HTTP and IPC should call a shared main-process plan service.

### Reads

- `read_plan(plan_id)` → `PlanCanonical | PlanParseError`
- `read_plan_compact(plan_id)` → `PlanCompact | PlanParseError`
- `list_plans(workspace_id)` → metadata-only summaries
- `validate_or_repair(plan_id)` → runs parser, surfaces errors. v1 surfaces only; does not auto-rewrite.

### Writes (structured mutations)

- `update_task_status(plan_id, task_id, status, expected_mtime?)`
- `update_phase_status(plan_id, phase_id, status, expected_mtime?)`
- `append_note(plan_id, phase_id, content, expected_mtime?)`
- `assign_agent(plan_id, agent_id, phase_ids[], expected_mtime?)`
- `set_plan_run_state(plan_id, state, resume_at?, expected_mtime?)`

`expected_mtime` is present from day one for compare-and-swap. If provided and the file's current `mtimeMs` does not match, return a conflict response and do not write. If omitted, allow last-write-wins. This keeps simple callers simple while giving scripts/UI a real concurrency guard.

---

## What we reuse from existing code

| Component | Path | Use |
|---|---|---|
| Dual-backend file watcher | `src/main/fs-watcher.ts` | Watches `plans/` direct children. Triggers parser reruns. |
| Whole-file writer | `src/main/file-writer.ts` | Plan-writer sits on top. It performs minimal textual mutations in memory, then persists the full markdown file through this writer. |
| Event payload builder | `src/main/supervisor/event-payload-builder.ts` | New event types for plan transitions emitted to supervisor's stdin. |
| Renderer IPC push pattern | `src/preload/index.ts`, `src/main/ipc-handlers.ts` | New channel `onPlanProjectionChanged` follows `onChatEvents` shape. |
| Zustand store | `src/renderer/stores/dashboard-store.ts` | New `plans` slice with per-plan subscriptions. |

Implementation boundary: create a main-process plan service used by both HTTP routes and IPC handlers. Do not make renderer IPC call localhost HTTP internally. HTTP exists for MCP/scripts; IPC exists for the renderer; both should share the same service functions.

---

## Required infrastructure fixes (must land before plans ship)

1. **fs-watcher polling fallback uses size only.** Same-size edits (`status=todo` → `status=done` are identical length) are silently missed. Switch to `mtimeMs` or content hash. Benefits every watcher consumer.
2. **plan-writer module.** New `src/main/plan-writer.ts` (or co-located with file-writer) exposing the structured-mutation API. Surgical marker mutations in memory, persisted as a full-file write through `file-writer.ts`.
3. **plan-parser module.** New `src/main/plan-parser.ts`. Pure TypeScript, testable in isolation. Returns `PlanCanonical | PlanParseError`, with recoverable issues represented as warnings. Reused for all read APIs and validate_or_repair.
4. **YAML parser dependency.** Add and use an explicit YAML/front-matter parser instead of ad hoc string parsing.

---

## Locked decisions

- **No Yjs / CRDT layer.** Last-write-wins at the file granularity is fine; agents don't edit at character grain.
- **Parser runs in main**, not renderer. Renderer receives typed projection.
- **Flat plan files** at `plans/*.md`, per-workspace only.
- **Compact-read shape** is part of the day-one type contract, not retrofitted.
- **`team_tasks` untouched.** Plan tasks live in markdown only. Decide team_tasks fate independently.
- **Teams `'groupthink'` enum value stays** (no DB migration). UI-visible label becomes "All-to-all".
- **GroupThink deletion is gated** until plan-writer + read-only Plans pane are in flight (Phase D below).
- **Per-plan IPC granularity.** Per-task IPC is a v2 concern; normalize in Zustand if perf bites.

---

## Implementation phases

Build in order. Each phase has an explicit definition of done.

### Phase A — Watcher fix + parser

**Done when:**
- fs-watcher polling fallback tracks `mtimeMs` (or content hash). Existing tests still pass.
- `src/main/plan-parser.ts` lands as pure TypeScript with unit tests covering: full happy-path parse, missing optional attrs, prose between markers, malformed individual markers (skipped, parse continues), empty notes blocks, unrecoverable parse failure.
- Parser tests also cover duplicate plan IDs, tasks under malformed phases, and recoverable warnings.
- No UI yet. Tests are the surface.

### Phase B — Type contract + read API

**Done when:**
- `src/shared/plans.ts` lands with `PlanCanonical`, `PlanProjection`, `PlanCompact`, `PlanParseError`.
- HTTP routes for `read_plan`, `read_plan_compact`, `list_plans`, `validate_or_repair`.
- MCP read tools wrap the HTTP routes (compact by default).
- No write surface yet.

### Phase C — Plans pane (read-only)

**Done when:**
- `plans` slice in `dashboard-store.ts` with per-plan selectors.
- `onPlanProjectionChanged` IPC push channel.
- Read-only Plans pane: lists plans, click to view, live-follows file changes via watcher.
- Parse-failure fallback UI: raw markdown + last-modified timestamp.

This is the **forcing function**: any wrinkles in the format / parser / projection surface here before the write surface multiplies them.

### Phase D — plan-writer + write API

**Done when:**
- `src/main/plan-writer.ts` lands with all structured-mutation primitives.
- HTTP routes for all write ops.
- MCP write tools wrap the HTTP routes; tool descriptions make API-over-raw-edits the explicit preference.
- `expected_mtime` parameter accepted on all writes; enforced whenever provided.
- UI gains write affordances (status checkboxes, note appenders) calling the same routes.

### Phase E — GroupThink deletion + cutover

**Done when:** the deletion checklist in CorePrimatives is fully executed in a single PR. 2 DB tables, 6 HTTP routes, 4 MCP tools, supervisor methods, IPC handlers, renderer components all gone. Lands alongside or immediately after Phase D so the supervisor never has a window of dead tools.

### Phase F — Orchestration script + execution

**Done when:**
- First orchestration script (e.g. `scripts/orchestrate-plan-execution.js`) drives a plan from `run_state=ready` through each phase using the write API and existing supervisor MCP tools (`fork_agent`, `launch_agent`, etc.).
- Script emits `[DASHBOARD EVENT]` payloads via `event-payload-builder.ts` for phase transitions.
- Skill wraps the script (name pending umbrella decision — e.g. `/execute-plan`).
- Script never edits markdown directly. Script never renders UI.

---

## Out of scope for v1

Explicitly deferred. Do not add unless the v1 surface is shipped and load-bearing.

- Nested plan directories.
- Cross-workspace / global plans.
- Yjs / character-grain collaboration.
- CRDT-aware merge.
- Mandatory CAS on every write call; v1 enforces CAS only when `expected_mtime` is provided.
- Plans-as-DB-rows. Tasks remain markdown-only.
- Parser auto-repair (validate_or_repair surfaces errors only).
- Status-transition history / audit trail.
- Plan templates / scaffolding tools.
- Per-task IPC granularity.

---

## Cross-references

- Source discussion and rationale: `docs/CorePrimatives_EdTurk_042826.md` (esp. "Phase 1 Findings" and "Phase 1 Convergence" sections).
- Notebook canonical-on-disk pattern (the conceptual model): `src/main/jupyter-kernel-client.ts`, `src/renderer/hooks/useYNotebook.ts`, `src/renderer/components/notebook/NotebookView.tsx`.
- Compact-read pattern reference: `compactOutput` in `src/main/jupyter-kernel-client.ts:156-173`.
- Existing watcher behavior: `src/main/fs-watcher.ts`.
- Existing file writer: `src/main/file-writer.ts`.
- GroupThink deletion checklist: `docs/CorePrimatives_EdTurk_042826.md`, "Decision: delete the existing GroupThink system" section.
