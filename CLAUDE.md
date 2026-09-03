# Lares

**Lares** is an agent-native workspace for orchestrating AI agents across
terminals, files, browsers, documents, and notebooks. It is an Electron + React
desktop app that launches agentic-CLI agents into a workspace and keeps every one
of them visible, addressable, and interruptible. (Formerly **AgentDashboard**.)

This file is read automatically by Claude Code on every session in this repo. It
is the short operational orientation; the full docs live in [`docs/`](docs/).

> ⚠ **Alpha — agents execute real commands.** Lares runs agents that execute shell
> in real terminals, drive a real browser, and read/write files. Read
> [SECURITY.md](SECURITY.md) before running it.

## Set up Lares

If a user asks you to **"set up Lares"** (or "install Lares" / "configure Lares"),
follow the setup skill at `.claude/skills/lares/` — it is an agent-followed wizard:
check Node/npm versions → `npm install` → offer optional integrations → write
non-secret settings → point the user to a **separate terminal** for any secrets
(never capture secrets in the AI session) → `npm run build` → launch → health
check. Do not write secrets into the session or into the user's `.claude/`.

## Build & run

There is **no main-process file-watcher**, so after any code change you must
rebuild before launching — a plain relaunch silently runs the previous `dist/`.

| Command | When to use |
|---|---|
| `npm run restart` | **Canonical restart** — build (main + renderer) + launch. Use this after edits. |
| `npm run build` | Compile both without launching. |
| `npm run build:dev` | Compile into `dist-dev/` without touching a running stable `dist/`. |
| `npm run dev:instance` | Launch the isolated `dist-dev/` copy beside stable Lares. |
| `npm run start` | Launch the existing `dist/` (only if you know it is current). |
| `npm run dev` | Vite HMR for the renderer; main-process edits still need a relaunch. |

New to the project? See [docs/setup.md](docs/setup.md) for prerequisites
(Node ≥ 20, a terminal-agent CLI, Windows + WSL, native-module build notes).

## Project structure

- `src/main/` — Electron main process (supervisor, runners, browser, plans, IPC)
- `src/renderer/` — React frontend (Vite)
- `src/preload/` — preload scripts (IPC bridge)
- `src/shared/` — shared types and constants
- `dist/` — compiled output

For how these fit together, read [docs/architecture.md](docs/architecture.md).

## Researcher lane posture

The researcher lane runs on three providers: Claude, Codex, and Antigravity
(agy). Grok researchers are unsupported and refused. No provider has an
OS-enforced researcher write boundary. The per-provider working directory
`.lares/researcher/<provider>/` remains active; only the per-agent provider-state
HOME redirect `.lares/agent-homes/<agent-id>/` was deleted. Researchers use the
human's normal provider home, including its settings and session history.

Enforcement is provider-specific and uneven. Claude has native CLI tool
allowlist/denylist enforcement plus a PreToolUse Write guard; a live out-of-shape
inbox write was denied. Codex researchers register no hook and have no researcher
write boundary; the identical live write landed. Antigravity's deny regexes and
`write_file` grants fail open through shell chaining, and its identical live write
also landed. Inbox promotion and reader rules improve downstream consistency;
they do not restrict provider-home persistence.

## Architectural invariant: agents share a working directory

Many agents run from the **same** working directory by design: every supervisor in
a workspace lives in `.lares/supervisor/`, and every Claude worker in
`.lares/workers/claude/`. (Formerly `.dashboard/` — existing workspaces are
renamed in place on first touch; see src/main/workspace-state-dir.ts.) The
Claude project slug is derived **purely from the
working directory**, so it is **not unique per agent** — many concurrent agents map
to one slug.

**Consequence:** any code that maps a session `.jsonl` (or any cwd-derived key)
back to a specific agent **cannot** assume one-agent-per-cwd. Disambiguate with a
per-agent signal — the agent whose own session file just went stale, an explicit
prior→successor session link, process identity, or tight per-agent timing — never
"there is exactly one agent in this folder." Don't reintroduce slug-uniqueness
assumptions.

## Writing under `.claude/`

Claude Code gates edits to anything inside `.claude/` with an interactive
permission dialog **even with bypass-permissions on**. In a non-interactive
orchestration run an agent will hang at that dialog. When authoring agent prompts,
point agents at paths *outside* `.claude/`; if something genuinely belongs under
`.claude/`, have the orchestrator write it on the agent's behalf.

## Notebook execution

When running or debugging an `.ipynb` in this workspace, prefer the dashboard's MCP
notebook tools (`execute_notebook`, `execute_cell`, `execute_range`) over raw
`jupyter nbconvert`, so the notebook view, live kernel, and saved outputs stay in
sync. Use `nbconvert` only when the MCP tool is unavailable or a fresh-kernel
headless run is explicitly requested. Address cells by their nbformat `id`, never
by index.

## For non-Claude agents

If you are not Claude Code, see [AGENTS.md](AGENTS.md) for the neutral-core version
of this orientation.

## Reading the turn record

The turn record (every agent turn, the paths it witnessed touching, and its
before/after diff) is a working input, not just a human display. Workers have
the read-only `checkpoints-read` lens (`list_checkpoints` and `diff_turn`);
supervisors retain the full recovery tier. Reach for it in these situations
rather than guessing:

- **Review what an agent did (gate support).** Capture a pre-dispatch `turnSeq`
  cursor, then compare the worker's witnessed paths since that cursor against
  what it was briefed to touch before accepting its turn.
- **Pre-edit collision check.** `list_checkpoints({file:"src/path/to/file.ts"})`
  can reveal an uncommitted collision `git log` cannot, but an empty result is
  not a lock; keep the ordinary shared-tree precautions.
- **Continuation orientation after a mid-WP death.** Recover a dead
  predecessor's touched paths by `agent_id` with a time floor, corroborated by
  task and expected paths; the paths say where to inspect, not what remains (a
  build/test settles that).
- **Hand-rolled span rollback.** "Take me back to 9am, only the chat pane": a
  worker correlates the implicated turns, diffs the selected ones, edits the
  files back by hand, and commits `[worker] revert: <span>` with strict
  pathspecs. An ordinary gateable turn, selective by sentence. It does not
  serialize against other agents: confirm target paths are quiescent before
  dispatch, do not dispatch other writers to them while it runs, and re-scope
  if a new turn touches one.

Read honestly: check capture health (`beforeReady`/`afterReady`/
`failureReason`) before reading absence as silence, and even a healthy empty
set is not proof no unwitnessed write occurred; reading is directional and
bounded (an unfiltered listing is only the newest `limit` window; a `file:`
filter is the only lens across retained history on one file); witnessed
activity is never a quality or effort metric. Paths first; escalate to a diff
only for a turn already implicated. Automated undo-by-description is not part of
this; it stays gated on `prop_296c04e9`.

## Workspace operating rules

- **Worker mix (Edward's directive):** prefer Codex workers to conserve Claude
  credits; use grok for adversarial review, each grok reviewer launched from the
  grok worker lane `.lares/workers/grok` with its own session id (never from an
  ad-hoc directory); reserve Claude workers for the hardest
  concurrency problems.
- **Register main-process tests:** a new main-process test file MUST be added to
  `scripts/run-main-tests.mjs`. A green suite that is not registered there is a
  dead bridge and proves nothing; gating requires proof through the registered
  runner.
- **Reachability proofs:** the `prove_reachability` tool is unusable in this
  workspace (tsc ignores `NODE_PATH`). Discharge reachability obligations with a
  manual revert-refutation: a committed mutation patch that makes the entering
  suite fail through the registered runner, then a green run after revert.
- **Plan DB fields:** `supervisor_active_plan` has never contained rows — never
  read it. `responsible_supervisor_id` is BOTH the comment-reply authorization
  gate AND the sole agent-card badge source — never retire or repurpose it.
- **Windows ACLs on this host:** DENY ACEs do not bind. Enforce with
  default-deny plus positive grants; never widen ACEs on real provider homes
  (`~/.claude`, `~/.codex`).
