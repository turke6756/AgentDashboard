# Core Primitives for the Agent Dashboard

*Ed Turk — 2026-04-28*

> **Update 2026-04-29**: A first end-to-end implementation of these primitives
> (planner committee → consensus → fork → worker → artifact verification) ran
> green. See `docs/ORCHESTRATION_SPIKE.md` for the run record and the
> dashboard-side changes that got it there.
>
> **Update 2026-04-29 (later)**: The two open meta-decisions blocking new code
> are now locked — see "Decisions Locked — 2026-04-29" at the bottom of this
> doc. Umbrella name = **orchestration** (layer concept; the spike is one
> instance, the planning-committee orchestration). Plan markdown moves to
> **`<workspace>/plans/`**, with `.claude/` reserved for saved agents,
> skills, memories, settings, and orchestration scripts.

## Related documents

This doc is the *vision and discussion record*. Other docs cover specific slices and should be read alongside it:

- [`docs/PLAN_CONTROL_PLANE.md`](./PLAN_CONTROL_PLANE.md) — buildable v1 spec for the plan data substrate (parser, types, read/write API, Plans pane). Implementation contract.
- [`docs/ORCHESTRATION_SPIKE.md`](./ORCHESTRATION_SPIKE.md) — first end-to-end orchestration spike, ran green 2026-04-29. Run record, phase table, and the four load-bearing fixes that had to land first.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — directory-style map of the existing codebase. Read for *what exists today*; read CorePrimatives for *where we're going*.
- [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md) — provider-aware Windows `sendInput` fix. One of the four spike-blocking bugs, resolved.
- [`docs/SEND_INPUT_WSL_BUG.md`](./SEND_INPUT_WSL_BUG.md) — WSL kitty-keyboard-protocol fix. Sibling of the Windows fix; required for cross-provider parity.
- [`docs/CODEX_INPUT_HANDOFF.md`](./CODEX_INPUT_HANDOFF.md) — Codex-specific input handling investigation that fed into the provider-aware dispatch.

## Leaning Into Skills

For the Agent Dashboard, I'm thinking of really leaning into skills. Skills can be:

- **Step-by-step instructions** for a specific task
- **Examples for agent behavior**, acting somewhat like memory but more general
- **Most importantly, programmatic execution via scripts**

Take the MCP server, for example, which allows agents to create other agents and communicate with them. The thing is, this multi-agent coordination often falls within the same pattern for repeat tasks. It almost doesn't matter what the task is — we know we are going to want to follow a workflow where we **plan, research, re-plan, delegate, monitor context and results of worker agents, and document**.

This workflow and its sub-components effectively become the **core primitives of multi-agent coordination**. Asking the supervisor to use the MCP tools to craft this workflow could be a skill expressed as a markdown file, but that's token-heavy because the supervisor would be required to do a lot of thinking. If, however, the skill references a script that the supervisor can run, and that script calls the MCP tools, then the script can construct the core agentic primitives and the supervisor can perform the role its name implies — **supervise**.

## What a Core Primitive Workflow Script Looks Like

What would a core primitive agentic workflow organized by a script look like?

- The script is **modular**, so all components can be run independently by the supervisor and are easily editable.
- The supervisor can change key parameters to fine-tune it.
- If a script is often fine-tuned to, for example, include defined persistent agents that exist in a directory, then over time that script could become a new skill — because this version of it specifically references a persistent agentic team with memory that grows over time.

So what might an agentic script do, referenced inside a `skill.md` that makes the supervisor aware of its editable parameters and what to monitor during the run? We'll start with the most fundamental element: **GroupThink**.

## Primitive 1: GroupThink (the Planning Committee)

GroupThink — i.e., the planning committee — is at least two agents from at least two different model providers who:

1. Plan and scope projects independently
2. Convene to debate, raise concerns
3. Ultimately come to consensus

The beauty of GroupThink in the Agent Dashboard is that **each model is sitting within the agent harness that model provider designed**, so all agents in the committee have their own independent tools to explore the local codebase and come to their own conclusions.

### Skills as Layers of an Onion

This is an example of how meta-skills can be like layers of an onion. If you imagine a planning committee with Claude Code and Codex, they will probably want to call skills that structure the way they review each other's plans, raise concerns, and address those concerns. They will also probably want to call skills to help shape how they bring the user into the loop during planning — which is always critical.

The way I think about skills: **they are pieces of a system prompt that are deferred for later.** Instead of bloating the agent's context with a large system prompt, we keep the system prompt lean and allow discoverable elements of what *could* be in the system prompt to be progressively accessed by the agent.

### Managing Agent-to-Agent Communication

Back to the script. The easy part is launching the agents and prompting them to plan. The harder part: the script also needs to manage their interaction.

- Every back-and-forth between agents with large context costs a lot of money. We don't want chatty agents bickering about immaterial elements of the plan.
- The script needs to know **when the agents are done** with their initial planning. The dashboard should expose this signal — whether agents are running or idle.
- Once both are idle, a generic message can be pushed. The script can store the agent IDs as variables so it knows who needs to communicate with whom and when they're done.
- The script could rely on basic MCP ability and generic messages to let an agent know who they're working with and that they should send their plan over. A more token-efficient approach would probably be for the script to "copy and paste" the plan from one agent and send it to the other for review, making them aware they're working with another agent.
- Exactly how the script manages communication between two agents still needs to be worked out. Ultimately, after review, those agents are going to want to respond to each other, so probably the two agents will just be told by the script to use the MCP themselves to communicate directly. Even though this is token-heavy, **planning is the most critical step anyway**.

## Primitive 2: Research

After the agents reach consensus on the scope of the plan, the script — or even the supervisor reviewing the plan — could raise the notion of further research with the agents.

This should always be **proposed as an option** to the planners by a third party. I find it hard for the planning agents themselves to reliably reach the conclusion that deeper research is warranted. This will be a recurring theme: a third-party agent or prompt injection from a script does not *demand* but *reminds* of the possibility of something and lets the agents decide.

### Initial Prompt Injection

We didn't mention it, but the script that starts up the planning committee needs to inject a prompt into these agents (assuming they are new, non-persistent agents). The prompt should be stored as a markdown file somewhere and referenced by the script.

### Triggering Deep Research

When the agents come to consensus during planning, it is now time to inject the possibility of research:

- Ask the agents if they feel there is anything worth researching online to get more clarity.
- If they feel there is, they are told to construct a prompt and use the skill `/deep-research`, which launches a headless Claude Code research agent.
- We may need to modify the deep-research skill to **ping the calling agent when research is done**.

### The Supervisor's Role

The supervisor's job is really to run the script that facilitates these interactions and **monitor the process**. Since the supervisor is Claude Code, it can leverage `/loop` (or similar) to regularly check in on the script. The script should output information specifically for the supervisor that is actually key.

## Plan Finalization

Research comes back. The agent reads it, determines whether to make adjustments, and does so. At this point the agent will probably consult with the original planning committee regarding the research findings — sharing the path to the research report and its determinations — giving the other agent a rebuttal and one last consensus before the plan is solidified.

At this point the plan is stored as a markdown file. Once again, we have a skill for writing up the final plan. The skill instructs:

- **Markdown structure** with checkmarks
- **How agents should scope the plan** as phases and tasks
- Specific instructions to think through the length of a phase being conducive to a single worker agent accomplishing it within a 250–400K token context window
- What context the worker agent will likely need for each phase

It's conceivable that even though Phase 2 is a separate agent from Phase 1, the context they need is the same. **This is important for later when we talk about forking agents.** Tasks within a phase also need to be specified as to whether they can be done in parallel by sub-agents or not.

### Token Usage Concerns

At this point I'm a little worried about token usage. The planning agents have been:

- Exploring the codebase
- Talking to each other
- Talking with the user
- Reading research reports
- Talking some more
- Now scoping the work before writing the final plan

It's conceivable that a separate agent could help scope the work and write the final plan, but scoping the work is probably best done by the agents that did the planning and codebase exploration. We are committing to **the largest token usage occurring around planning**.

## Plans as Dashboard Elements

The plan, with scoped tasks, gets reviewed by the other planning agent and stored in a folder that holds plans. The dashboard will look for this folder and surface the plans as UI elements in a new section of the dashboard (yet to be designed).

Each directory also has persistent agents (also folders in a subdirectory with `CLAUDE.md` and memories). The Agent Dashboard will have UI elements to display these persistent agents.

So now you have:

- **Scoped project cards** as dashboard elements
- **Agents** as dashboard elements

Plans can sit around waiting to be executed. You can click into them, review them, and look at metadata.

### Plan Formatting and Script Orchestration

The plan itself needs **impeccable formatting**, because a script is going to be responsible for orchestrating the agents to run the plan, and the script will likely need to parse elements like phases.

The script can also control the **rate of agent execution**:

- You can make the plan executable over 1 day or more so you don't burn too many tokens at once.
- The script can delay how long it takes before the next phase is run.
- This delay can be a generic time delay, or it could coordinate with the supervisor on when it's appropriate to run the next phase based on user activity and usage limits.

## Primitive 3: Forking Agents

Forking agents is a core primitive for agent execution of a plan.

Say Phases 1–5 can all be done by one agent, but that would be a lot of context bloat. The solution:

1. Launch an agent and tell it to scope Phases 1–5.
2. Once it gathers its context, **fork it**.
3. Run the fork for Phase 1 and kill it.
4. Go back to the original, fork it again, and run that fork on Phase 2. Kill it.
5. Repeat.

The original agent does not get used — it's preserved and forked. In fact, the original agent's ID can be saved in the plan markdown with specifications on what phases it's good for. The script can see that the agent is good for Phases 1–5 and forks it as a worker agent for each phase.

Even though these models can go up to a million in context, we don't want to get anywhere near that — we want to **reuse an agent for short tasks and kill it**.

### Worker Agents Reporting Back

When an agent is done, it needs to write a little bit back to the planning document:

- Obviously, check off what it did.
- If it found something, if something was different, or if something didn't work quite as the plan specified, it makes a note in the markdown.

There is the possibility that the **UI element follows the live markdown**, so it can visualize edits being made to the markdown. The user would be looking at a clean UI element that, in a more abstract way, represents the state of the planning markdown as agents report back their work. Perhaps the script that orchestrates the agents is also responsible for updating the UI element. For instance:

- If the script is going to wait 2 hours before running the next phase, this is reflected in the UI element.
- If the agent reports back a note about execution and writes this to the markdown, this gets updated as a UI element.
- **The UI is not a 1-to-1 of the markdown.**

### Risks and Mitigations

The risk is the script's ability to parse the markdown to translate it to UI. If agents make notes in a way that is not parsable, that's an issue. However:

- Agents will probably load skills that instruct them on how to report work back to the markdown.
- The script can also just rely on **last edit to markdown** rather than exact syntax.

### Worker Agent Setup

The script that forks and launches these worker agents needs to instruct them — again, inject a prompt: *"Here is the phase of your work, and here are the skills you have access to, e.g., the 'when done' skill — use this when you complete your work."*

Perhaps worker agents should have **hooks**. Not sure how this gets initiated, but when they are done — specifically applying just to worker agents — they can write back results to the markdown with a specific schema. This is yet to be determined, but the basic concept is laid out here. The script needs to launch agents and inject them with a prompt based on the markdown planning document and the relevant skills or hooks any worker agent should be aware of.

## Persistent Agents Executing Plans

What if a plan can be executed by persistent agents in the workspace?

The supervisor's role is really to launch these agent orchestration scripts and monitor their progress and outputs. Say we have a plan sitting on the dashboard as a UI element and it's time to execute. You click execute, and it calls the supervisor. The supervisor:

1. Looks over the plan
2. Determines if there's a persistent agent that's a good fit, or if it will use generic agents
3. Depending on its determination, may modify variables in the agent execution script — replacing certain generic agent variables with persistent agents — before running the script

## Summary of the Concept

A script that uses the Dashboard MCP to hard-code agentic interactions that act as **core primitives**: planning, research, and execution.

The supervisor's role is to:

- Change variables in the script when appropriate
- Run it
- Monitor its outputs and progress

The script will likely render changes to UI elements that help the user quickly see what's going on.

## Dashboard UI Panes

The dashboard will have panes for:

1. **Viewing planned projects and monitoring progress**
2. **Viewing persistent agents**, including agent teams designed to work together — see stats like how often they are deployed, what tasks they last worked on, how much they've spent, etc.
3. **A leaderboard pane for all skills across all repos pulled up in the app** — *this is the most important.*

### The Skills Leaderboard

Skills are ultimately files in your directory, and we can parse and inventory them along with their descriptions. But the most important information is **how they are used, in what context, and what results they produced**.

For this we rely on parsing the agent logs:

- We have a script to parse logs and pull out:
  - When skills were called by an agent
  - The agent ID
  - The time and the context (other tools the agent called, what the agent's thoughts were when using the skill, what the user context was around the skill call)
- These are extracted by a script.
- We may then need a small LLM to analyze the extracted data from the logs to gain insight.

Ultimately, the dashboard lets you see **how often skills are being called, from what directories, and under what circumstances**. This leads to an opportunity for the user to evaluate the effectiveness of a skill, potentially modify it, or even run tests around the skill to understand its behavior better.

The dashboard is making a directional call on **the importance of multi-agent orchestration and skills as most important**.

---

# Planning Notes — 2026-04-29

> **Buildable spec for the plan-tracking substrate is at [`docs/PLAN_CONTROL_PLANE.md`](./PLAN_CONTROL_PLANE.md).** That document is the converged v1 contract — file format, type contract, API surface, required infrastructure fixes, implementation phases A–F, and out-of-scope list. Read this section for *why*; read PLAN_CONTROL_PLANE for *what to build*.

This section captures decisions and open questions from the planning conversation that built on the vision above. **Future agents:** treat the "Next Steps" list as actionable TODOs. Anything called out as a "decision" is settled and should be executed when the time comes; "open questions" still need a human call before code lands.

## Branding decision

The new primitive is **script-forward control over execution**: a markdown plan is the canonical artifact, scripts orchestrate the multi-agent execution by calling the dashboard MCP, and the supervisor's role is to invoke the script and monitor it.

The name "GroupThink" is **retired**. It survives only as a historical term and as the Teams channel-topology name (`template: 'groupthink'` = all-to-all). Future agents should not introduce new code, docs, or UI under the "GroupThink" name.

(**Open question — umbrella term.** Settle on a short product name before code lands: "Planning Committee" for the planning step, "Plan Run" for execution, or a single overarching name. Pick one and search/replace before any new files are created.)

## Decision: delete the existing GroupThink system

The current GroupThink implementation is a flat 2-table stub (`topic + round_count + synthesis_blob`, no task/phase model, no per-round artifacts). Nothing is structurally worth salvaging. **Wipe in a single PR** — a half-deleted GT means the supervisor has dead MCP tools while the new system is being wired up.

Deletion checklist for the future agent doing the rip:

- **DB**: tables `groupthink_sessions` + `groupthink_members` (`src/main/database.ts:103-122`); the 8 CRUD functions at `src/main/database.ts:594-669`.
- **HTTP**: 6 routes at `/api/groupthink/*` in `src/main/api-server.ts:179-243`.
- **MCP tools** in `scripts/mcp-supervisor.js`: `start_groupthink`, `get_groupthink_status`, `advance_groupthink_round`, `complete_groupthink` (definitions ~284-320, handlers ~637-660).
- **Supervisor**: `notifyGroupThinkStart()` in `src/main/supervisor/index.ts`; `groupthink_start` event type in `src/main/supervisor/event-payload-builder.ts`; `groupThinkUpdated` emits in `api-server.ts`.
- **IPC / preload**: 4 IPC handlers in `ipc-handlers.ts`, `groupthink.*` namespace and `onGroupThinkUpdated` channel in `src/preload/index.ts`, types in `src/shared/types.ts`.
- **Renderer**: `groupThinkSessions` slice + 4 actions in `src/renderer/stores/dashboard-store.ts`; `GroupThinkDialog.tsx` (delete file); `GroupThinkStatusSection` in `DetailPanel.tsx`; AgentCard badge + "Start Group Think" context-menu item; AgentGrid dialog wiring; `onGroupThinkUpdated` listener in `App.tsx`.
- **Docs**: archive or delete `docs/GROUP_THINK.md`; remove the "GroupThink (deprecated, code still live)" section from `docs/ARCHITECTURE.md`.
- **Supervisor prompt**: remove the GT protocol section from `SUPERVISOR_AGENT_MD` in `src/shared/constants.ts` and from `.claude/agents/supervisor*.md`.

**Do not delete**: the Teams `template: 'groupthink'` enum value — that's just an all-to-all channel-graph topology and is unrelated to the GT system.

## Decision: keep these existing primitives, adapt them

Two pieces of existing plumbing carry directly into the new system. Future agents should reuse, not re-implement.

**1. Event payload builder.** `src/main/supervisor/event-payload-builder.ts` formats `[DASHBOARD EVENT]` text payloads and injects them into the supervisor's stdin. The script-forward system needs this exact channel for events like "Phase 1 done," "agent X reported back to plan," "plan file updated." Add new event types here; do not stand up a parallel notification path.

**2. fs-watcher dual-backend.** `src/main/fs-watcher.ts` already handles Windows (chokidar), WSL native (inotifywait subprocess), and `/mnt/*` (polling fallback). Plans live on disk and need watching. Route plan-folder watching through this watcher. Do not introduce a second watcher for plan files.

## Plan format: direction (not yet final)

The intent is to mirror the `.ipynb` canonical-on-disk pattern already shipped in this codebase: the markdown file on disk is the source of truth; a parser maintains a structured projection (Zustand store, possibly mirrored to SQLite) that the UI renders from; re-parse on fs-watcher change events. If parse fails, UI falls back to raw markdown + last-modified timestamp — never breaks.

**Schema direction**: marker-based using HTML comments as anchors so agents can free-write between markers without breaking the parser. Sketch (not final, do not implement yet):

```markdown
---
id: plan-2026-04-29-foo
agent_assignments:
  agent-abc: [phase-1, phase-2]
---

## Phase 1: Set up infra <!-- phase: id=phase-1 status=todo -->

- [ ] Provision DB <!-- task: id=t1 -->
- [ ] Wire CI <!-- task: id=t2 blocked_by=t1 -->

<!-- notes: phase-1 -->
Free-form notes from worker agents land here.
<!-- /notes -->
```

The parser keys off comment markers, not regex over prose. Agents are instructed to preserve the markers and write whatever they want around them.

## Open question: task management

The existing `team_tasks` table (id, title, status, assigned_to, blocked_by, notes) **may not survive**. Whether to keep it depends on whether tasks live *only* in the plan markdown (most likely) or also in a queryable DB table for cross-plan reporting.

Future agents: **do not extend `team_tasks`** until this question is settled. The decision drops out of finalizing the plan-markdown schema.

## Next Steps

Ordered. Each step has a clear owner-action and a definition of done.

1. **Study the `.ipynb` canonical-on-disk pattern in this codebase** and write up how the same shape applies to plan markdown. Look at `src/main/jupyter-kernel-client.ts`, `src/renderer/hooks/useJupyterServer.ts`, `src/renderer/hooks/useYNotebook.ts`, `src/renderer/components/notebook/NotebookView.tsx`, and `src/renderer/lib/jupyterCollab.ts`. Document: how the file-on-disk relates to the in-memory model, how edits flow back to disk, how the UI subscribes. Output: a short doc section here or a new `docs/PLAN_CANONICAL_PATTERN.md`. **This is the immediate next planning task** — do it before designing the parser or schema in detail.
2. **Pick the umbrella product name** for the script-forward primitive. Documented decision before any new code or docs land under that name.
3. **Draft the plan-markdown schema spec** as `docs/PLAN_FORMAT_SPEC.md`. Marker-based, with parse-failure fallback rules. Include realistic examples an agent could write.
4. **Decide the fate of `team_tasks`** based on the schema. Either keep as a queryable cache of plan tasks, or schedule for deletion alongside GroupThink.
5. **Sketch the orchestration-script API**: what surface does a `skill.md` invoke? Probably Node child_process spawned by supervisor, with stdout streamed to supervisor's terminal via the event-payload-builder pattern. Document before implementing.
6. **Land the GroupThink deletion PR.** Single change using the checklist above. After this lands, the codebase has no `groupthink_*` symbols outside the Teams template-topology name.
7. **Build the Plans pane (read-only first)**: lists plans from `.claude/plans/`, click to view, live-follows file via fs-watcher. No execution yet — this is the forcing function for finalizing the schema and parser.

---

# Phase 1 Findings: Canonical Pattern Study

*Written 2026-04-29 in response to Next Step 1 above. Awaiting independent agent review before progressing to Step 2.*

The question this section answers: **does the `.ipynb` "canonical-on-disk" pattern apply to plan markdown, and if so, how literally should we copy it?**

## What the notebook pattern actually is

Reading the notebook stack reveals the pattern is **three layers, not two** — the renderer never reads the file directly.

1. **On disk** — `.ipynb` JSON file. Version-controllable, the artifact a user commits.
2. **In memory (shared)** — `YNotebook`, a Yjs CRDT document. The "live" representation that both the user's iframe and the agent's kernel client mutate.
3. **On wire** — Yjs-over-WebSocket via `y-websocket`, talking to a collaboration room hosted inside `jupyter-server`.

The renderer subscribes to the ydoc (`src/renderer/hooks/useYNotebook.ts:23-173`), receives a live `ynotebook.cells` array, and re-renders on doc mutation (`emitNotebookChange` at `useYNotebook.ts:53-57`). It does **not** open the `.ipynb` file. Per-cell change handlers (`useYNotebook.ts:59-79`) keep re-renders narrow.

The reason this works for two concurrent writers — user typing in the iframe, agent calling `m.contents.save(...)` from Node — is that both routes funnel through the same ydoc, owned server-side by `jupyter_server_ydoc`. The comment at `src/main/jupyter-kernel-client.ts:286-289` is explicit:

> "With jupyter-collaboration installed (Phase 0), this routes through the ydoc and the iframe sees the update without a 'file changed on disk' dialog."

The CRDT layer plus the server-side bridge is what makes "two writers, one canonical file" work without conflict.

## What transfers conceptually to plans

Four design ideas should carry over directly:

1. **Canonical-on-disk + in-memory projection.** The plan markdown is the artifact (git-committable, human-readable, agent-editable). The UI never reads the file directly; it reads a parsed projection that's kept in sync with the file.
2. **Stable IDs on the addressable units.** Notebooks address cells by nbformat 4.5 UUID, never by index, so inserts don't shift addresses across tool calls (`jupyter-kernel-client.ts:267-270`). For plans, the equivalent is UUIDs embedded in HTML-comment markers — `<!-- task: id=t1 -->`, `<!-- phase: id=phase-1 -->` — so a worker agent appending notes doesn't invalidate every existing reference.
3. **Single coordinated writer path.** All file mutations go through one place. In notebooks it's `m.contents.save(...)` mediated by jupyter-server. For plans it should be `src/main/file-writer.ts`, which already exists and is used by the file viewer's edit mode.
4. **Compact read shape ≠ disk shape.** This is the most important pattern and the easiest to overlook. See "The compact-read insight" below.

## What does *not* transfer (and why we shouldn't force it)

**Yjs / CRDT layer.** Notebooks need it because (a) two clients edit the same code cell at character granularity, (b) the kernel writes outputs to the same JSON the user is staring at, and (c) the Jupyter ecosystem already provides `jupyter_server_ydoc` for free.

For plans, none of those hold:
- Agents edit at task/note granularity, not character-by-character. Two simultaneous edits to the same `<!-- notes: phase-1 -->` block are rare and tolerable as last-write-wins.
- There's no kernel competing with the user. The "writers" are: the agent (via its own Edit tool), the orchestration script (via main-process file-writer), and occasionally the user (via UI → IPC → file-writer).
- There's no equivalent server hosting plans. Plans live in `.claude/plans/` on the bare filesystem.

Adopting Yjs would mean standing up our own `y-websocket` server, writing markdown ↔ ydoc translators on both ends, and inventing a CRDT-aware merge for prose markdown. That's enormous engineering for a problem we don't actually have. **Skip it.**

## What replaces it: the simpler pipeline

The same conceptual two-layer model, built from primitives already shipped:

```
.claude/plans/foo.md  (canonical, on disk)
        │
        ▼  fs-watcher.ts dual-backend (already exists, handles Windows/WSL native/mnt)
        │
   parser (markdown + HTML-comment markers → typed Plan object)
        │
        ▼  IPC push (same pattern as onChatEvents, onContextStatsChanged)
        │
   Zustand store (plans projection, per-plan slices)
        │
        ▼  React subscribes per-plan, per-phase, per-task
        │
   Plans pane UI
```

Writes flow through the same primitives in reverse:
- **Agent edit** → its own Edit tool writes the file → `fs-watcher` fires → parser runs → projection updates → UI updates.
- **Script orchestration** → main-process file-writer → fs-watcher fires (or short-circuit by emitting the projection update directly to skip a parse round-trip).
- **User UI edit** → IPC to main → file-writer → fs-watcher → projection.

Every box in this diagram already exists in the codebase. The only new code is the parser and the Plans pane UI.

## The compact-read insight

The unexpected finding — and the one most worth lifting from notebooks. See `compactOutput` in `src/main/jupyter-kernel-client.ts:156-173`.

When the agent reads a cell's output via MCP, the response is **not** the raw nbformat output. Images become `{ mime, byteLength }` stubs. Text is truncated to ~5KB. Errors keep the traceback compact. The reasoning, captured in the file's header comment:

> "The output shape returned to MCP is intentionally compact … so the LLM doesn't blow its context on a single matplotlib figure."

Plans will have the same problem at scale. Once a multi-phase plan accumulates worker-agent notes across phases 1–5, a phase-6 worker reading the plan to orient itself shouldn't have to consume every prior phase's full notes. The MCP-facing read shape should be designed alongside the disk schema:

- **Canonical (on disk)**: full markdown, all notes, all task statuses, every history blob.
- **Compact (what agents read via MCP)**: phase headers + task statuses + first ~200 chars of each notes block + a count of "+ N more characters." Worker agents can request a specific phase's full notes if they decide they need to.
- **Rendered (what the UI shows)**: full content with collapse/expand affordances per phase.

Designing all three views from day one is much cheaper than retrofitting compaction once plans get long.

## Implications for the format spec (Next Step 3)

Pulling the above together, the format spec should pin down:

1. **HTML-comment marker grammar** — exact tokens, exact attribute syntax, what a parser must tolerate (extra whitespace, attribute reordering, missing optional attrs, agent prose mixed in).
2. **Stable-ID rules** — UUIDs assigned at creation, never reused, agents instructed to preserve markers verbatim.
3. **Three views, three shapes** — canonical disk schema, compact MCP-read schema, rendered UI projection. Define each as a TypeScript type up front.
4. **Parse-failure fallback** — if any of the above breaks, UI degrades to "raw markdown + last-modified timestamp" rather than crashing or showing stale projections.
5. **Append-only zones vs. structured zones** — `<!-- notes: ... -->` blocks are free-text (append-only by convention); `<!-- task: ... -->` lines are structured (status changes via marker mutation, not prose). Helps the parser and helps the writer agent know where it can be sloppy.

## Implications for the orchestration script (Next Step 5)

The orchestration script — the thing a `skill.md` invokes that calls dashboard MCP — should write to plans through the **main-process file-writer**, not directly with `fs.writeFile`. Two reasons:

1. The script may run inside the Electron main process (via Node child_process spawned by supervisor) or external to it. Either way, routing writes through the existing IPC + file-writer means a single audit trail and a single place to enforce serialization.
2. When the script wants to update task status, it should mutate the marker (`<!-- task: id=t1 status=done -->`), not re-serialize the whole plan from a JSON model. Markdown stays the source of truth; the script edits in-place.

This also keeps the script implementation language-agnostic — it talks to the dashboard via HTTP/MCP (`api-server.ts`), not by importing TypeScript types.

## Open questions raised by this study

For another agent reviewing: please push back on any of these specifically.

1. **Is per-plan IPC push fine, or do we need per-phase / per-task granularity?** Notebooks went per-cell (`useYNotebook.ts:59-79`) for re-render performance. Plans are smaller — probably per-plan is fine until a plan exceeds ~20 phases, but it's worth deciding before building.
2. **Where does the parser run — main or renderer?** Notebooks parse server-side (jupyter-server owns the file). For plans, both options work: parsing in main keeps the renderer thin and lets the script reuse the same parser for read-back; parsing in the renderer is closer to the existing markdown viewer. **My current lean: parse in main, ship the typed projection over IPC.** Disagreements welcome.
3. **Do we need the compact-read shape on day one, or can we ship the canonical + UI views first and add compact-read when plans get long enough to hurt?** Argument for day one: defining the shape early forces clean separation. Argument for later: YAGNI, premature optimization. **My current lean: define the type day one, implement it lazily** — i.e., the MCP read tool returns a compact shape with simple rules (truncate notes to 200 chars), and we tune the heuristics as plans grow.
4. **Should plans live in `.claude/plans/` (per-workspace) or `~/.claude/plans/` (global)?** Per-workspace mirrors persona scanning (`persona-scanner.ts`). Global means a plan can drive cross-workspace work. **My current lean: per-workspace by default, no global support in v1.** Easy to add later; hard to remove if it becomes load-bearing.

## Recommendation for proceeding

After review of this section, the order of operations is:

1. Reviewer agent confirms or pushes back on the no-Yjs decision and the three-view shape.
2. Resolve the four open questions above.
3. Move to Next Step 2 (umbrella name decision) and Next Step 3 (format spec).

Do **not** start the GroupThink deletion (Next Step 6) until at least the format spec is drafted — we want to delete and replace in adjacent PRs so the supervisor never has a window of dead tools.

---

# Phase 1 Convergence: Review Feedback Integrated

*Written 2026-04-29 after independent agent review of the Phase 1 Findings above. This section supersedes any conflicting language in the prior section and is the v1 contract.*

The reviewer agreed with the major architectural calls — no Yjs for plans, parse in main, three-view shape, per-plan IPC, per-workspace `.claude/plans/` — but flagged three implementation gaps that change v1 scope. They also resolved several open questions.

## Corrections to Phase 1 Findings

### 1. fs-watcher is not recursive

`src/main/fs-watcher.ts` is depth 0. It watches a directory's direct children, not nested folders. Phase 1 Findings glossed this when claiming "every box already exists." For nested plan layouts (`.claude/plans/foo/plan.md`) the watcher would not fire.

**Decision (v1):** Plans are flat files at `.claude/plans/*.md`. No nested layouts. If we ever need plan-with-subdocs, extend the watcher then.

### 2. Polling fallback misses same-size edits

The `/mnt/*` polling backend detects file changes by *size only*. A status flip like `<!-- task: id=t1 status=todo -->` → `<!-- task: id=t1 status=done -->` is the same length and would be silently missed. This is fatal for plans-as-live-state.

**Decision (v1):** Before plans go live, switch the polling fallback to track `mtimeMs` (or a content hash). This is a fix to the existing watcher, not new infrastructure — and it benefits every other consumer of fs-watcher.

### 3. file-writer.ts is a whole-file writer, not a mutation layer

Phase 1 Findings said "all writes go through `file-writer.ts`." That's correct for *whole-file* writes, but plans need surgical mutations: flip one task's status, append one note to one phase. The current writer has:

- No compare-and-swap (no etag/mtime/hash check before write).
- No append-note primitive.
- No marker-level mutation.
- No serialization across concurrent writers (agent direct edits + orchestration script + user UI).

Asking scripts to rewrite the entire plan markdown to flip one bit invites lost-update races and parser thrash.

**Decision (v1):** Build a thin **plan-mutation layer** on top of `file-writer.ts` exposing:

- `update_task_status(plan_id, task_id, status, expected_mtime?)`
- `append_note(plan_id, phase_id, content, expected_mtime?)`
- `read_plan(plan_id)` — full canonical
- `read_plan_compact(plan_id)` — compact shape for MCP/agent consumers
- `validate_or_repair(plan_id)` — runs parser, surfaces parse errors

Optional `expected_mtime` gives compare-and-swap semantics. v1 can default to "no check" and tighten enforcement when concurrency bugs show up.

### 4. Scripts cannot use renderer IPC

Orchestration scripts run as headless Node processes (or other languages) and cannot call `window.api.*`. Phase 1 Findings was sloppy on this — it described writes as flowing through "main-process file-writer" without specifying the wire protocol scripts actually use.

**Decision (v1):** All plan operations are exposed as HTTP routes in `src/main/api-server.ts` (`/api/plans/...`), proxied through MCP via `scripts/mcp-supervisor.js`. The renderer goes through the same HTTP routes (or a thin IPC wrapper that internally calls them). Single source of truth, no parallel API surface.

## Resolved Open Questions

| Question | Resolution |
|---|---|
| Per-plan vs per-task IPC granularity | **Per-plan in v1.** Normalize in Zustand, memoize selectors if perf bites. |
| Where parser runs | **Main process.** Renderer receives `PlanProjection \| PlanParseError`. |
| Compact-read on day one or lazy | **Day one.** Simple truncation rules in v1 (notes capped to N chars, metadata always full); tune heuristics as plans grow. |
| Plans location | **Per-workspace `.claude/plans/` only.** No global plans in v1. |
| `team_tasks` table | **Untouched.** Do not reuse for plan tasks; do not extend; decide its fate independently of the plan work. |
| Teams `'groupthink'` enum | **Enum value stays** (no DB migration). UI-visible label becomes "All-to-all" so the retired brand doesn't survive in user-facing text. |
| When to delete GroupThink | **After** the format spec + read-only Plans service are designed and at least drafted. Not before. |

## Updated Next Steps

The reviewer's strongest strategic correction: *"the parser, watcher behavior, write API, and compact-read surface should be specified together before implementation."* Steps 3–5 from the original Next Steps collapse into a single coordinated spec.

1. **(was Step 1) Phase 1 canonical-pattern study** — done.
2. **(was Step 2) Pick the umbrella name** — still pending. **Lock before any code or new docs.**
3. **(NEW combined Step 3) Write the v1 control-plane spec as a single document** — **DONE 2026-04-29: [`docs/PLAN_CONTROL_PLANE.md`](./PLAN_CONTROL_PLANE.md).** Covers, in this order:
   - Plan markdown grammar (HTML-comment markers, attribute syntax, parser tolerance rules, append-only zones vs structured zones).
   - Three-view type contract: `PlanCanonical`, `PlanProjection`, `PlanCompact`, `PlanParseError` in `src/shared/plans.ts`.
   - Plan-mutation API surface (HTTP routes + MCP tool wrappers + IPC mirror), including the optional CAS semantics.
   - Watcher fixes required before plans ship: document flat-files-only as a constraint, switch polling fallback to mtime/hash.
   - Compact-read truncation rules.
   - Parse-failure fallback behavior in UI.
4. **(was Step 4, folded into Step 3)** Plan-mutation API.
5. **(was Step 5, folded into Step 3)** Orchestration-script API — its contract *is* the HTTP/MCP surface from Step 3.
6. **(was Step 6) GroupThink deletion PR** — gated until Step 3 lands AND the read-only Plans pane (Step 7) is in flight. Same-PR or adjacent-PR with the new system going live.
7. **(was Step 7) Plans pane (read-only first)** — unchanged. The forcing function for finalizing the schema and parser.

## Immediate next action

The control-plane spec (Step 3) is **drafted** at `docs/PLAN_CONTROL_PLANE.md`. Implementation can begin against it once the **umbrella product name** (Step 2) is locked — every symbol, route, type name, and doc heading in PLAN_CONTROL_PLANE references generic placeholders that need a single search/replace pass once the name is picked.

Sequence after naming:
1. Phase A in PLAN_CONTROL_PLANE: watcher polling-by-mtime fix + `plan-parser.ts` with unit tests.
2. Phase B: type contract in `src/shared/plans.ts` + read API.
3. Phase C: read-only Plans pane (the forcing function before write surface multiplies issues).
4. Phase D: plan-writer + write API.
5. Phase E: GroupThink deletion PR.
6. Phase F: first orchestration script + skill.

## Boundary: orchestration script vs dashboard UI

A second round of review tightened the boundary between the orchestration script and the dashboard UI. The clean separation is:

```
plan.md
  → parser
  → PlanProjection
      → UI renders
      → orchestration script decides next action
      → MCP compact-read serves agents
```

**The orchestration script is a state-transition engine, not a UI renderer.** It mutates canonical state (the plan markdown via the mutation API) and emits supervisor events through the existing `event-payload-builder.ts` channel. It does not construct UI cards, panes, badges, layout state, or any presentation artifact. The dashboard observes `PlanProjection` and renders whatever is appropriate, independently.

This is an explicit correction to language in the original vision above that suggested *"the script that orchestrates the agents is also responsible for updating the UI element."* Wrong boundary — it would force the script to know both execution semantics and dashboard presentation semantics, and any UI redesign would ripple back into orchestration logic.

The script's entire vocabulary is plan operations and supervisor events:

- `updateTaskStatus(taskId, "running")`
- `appendPhaseNote(phaseId, note)`
- `setPlanRunState("delayed", resumeAt)`
- emit `[DASHBOARD EVENT] Phase 2 starting` (via existing payload builder)

That's it. If the UI gains a new badge or pane, the script does not change.

## Write modes

Phase 1 Findings implied "agents edit markdown directly" as the default write path. Correction: that's *one of three* explicit write modes, and it's not the preferred mode for structured updates.

| Mode | Who | What | Mechanism |
|---|---|---|---|
| **Structured** | orchestration script, MCP tools | task status, assignment, blockers, phase run state | Plan-mutation API only (HTTP/MCP) — flips markers, optional CAS. **Never raw markdown edits.** |
| **Append-only** | worker agents | notes, observations, findings | Either direct markdown edit inside `<!-- notes: ... -->` blocks OR `append_note(plan_id, phase_id, content)` API. Both supported; agents may pick. |
| **Manual** | user | anything — typo fixes, restructuring, freeform editing | Raw markdown edit. Parser validates on next watcher fire. UI falls back to "raw markdown + last-modified" on parse failure. |

**Implication for the format spec:** the marker schema is the contract for *structured* mode. *Append-only* mode is forgiving (parser must tolerate any prose inside a notes block). *Manual* mode is forgiving by parse-failure-fallback. Direct markdown edits by agents are **tolerated, not required** — agents should prefer the API for structured mutations and use raw edits only for notes.

**Implication for the orchestration script:** it must never use raw markdown edits, even when convenient. Always go through the plan-mutation API. This keeps the boundary clean, keeps the script testable via the same API the UI consumes, and prevents the script from fragile text surgery against a schema that may evolve.

**Implication for worker agents:** their default for status/assignment changes is to call the MCP tool wrapping the plan API (e.g. `update_task_status`), not to edit markers directly. Direct marker edits are a fallback for when an agent misuses the API or the API is unavailable, not a normal path. The MCP tool docs the supervisor sees should make this preference explicit.

These refinements feed into the Step 3 control-plane spec; they don't change the ordering of Next Steps.

---

# Full Vision Scoping — 2026-04-29 (cont.)

*PLAN_CONTROL_PLANE.md is the buildable contract for one slice of the vision: the data substrate (parser, types, read/write API, Plans pane). This section scopes the rest of the vision — the script that drives agents, the planning committee that replaces GroupThink, the fork-and-execute loop, and how the supervisor monitors all of it without burning tokens. The recon mission and throwaway-spike spec at the bottom are next steps, not abstract suggestions.*

## Two parallel workstreams

The work splits cleanly. Up to a point they're parallelizable.

- **Track 1 — Plan Control Plane.** The data substrate spec'd in `PLAN_CONTROL_PLANE.md` (phases A–F). Mostly typed code, testable without live agents.
- **Track 2 — Orchestration.** The script that drives agents: idle detection, planning committee (the GroupThink replacement), fork-and-execute, pacing, research hand-off, persistent-agent variable swapping. Live agents, real tokens, harder to test.

Track 2's worker agents need Track 1's write API to report back. Until then, Track 2 can develop against hand-authored fixture plans.

## Locked: script architecture

- **Node child process**, spawned by the supervisor through a skill.
- **Two output streams** with separate audiences (see "Supervisor monitoring model" below).
- Talks to the dashboard via the existing HTTP / MCP surface — never imports renderer types, never calls `window.api.*`.
- Skill is the user-facing surface; the script is the engine. The skill's job is to invoke the script with the right args (which plan, persistent-agent overrides, pacing) and tell the supervisor what to monitor.

## Supervisor monitoring model

The supervisor is Claude Code in a session. When idle — no user input, no hook events — the model isn't running, only the process is alive. Cost per idle second is zero. The architecture exploits this aggressively.

The script writes to two output streams:

1. **Verbose log** → file at `.claude/plans/runs/<run-id>.log` and a renderer-side log viewer. Every tick: task started, idle poll, agent message exchanged, heartbeat. User can tail this. Supervisor never reads it unless asked.
2. **Supervisor events** → injected into supervisor stdin via the existing `event-payload-builder.ts`. *Only* decision-relevant transitions: phase done, plan paused/blocked/failed, worker flagged a discrepancy, awaiting user gate, plan complete.

Each injected event = one supervisor wake. Supervisor processes the event (~500 tokens new + prompt-cache hit on the system prompt), may ack, save state, or take action, then goes idle again.

Cost calculus on a 5-phase plan, ~3 important events per phase = ~15 supervisor wakes for the whole run. Maybe 8K tokens of supervisor activity total. Compare with a "supervisor watches stdout live" model that would burn that much per minute.

The hard constraint on the script implementation: **chatty in the log, quiet to the supervisor.** The script picks which moments matter. When in doubt, log don't inject.

`/loop` is an optional second layer: if the user wants a periodic summary even when no events fire, /loop fires every N minutes, the supervisor reads the log tail and reports. Independent of the script's own event channel.

## Sequencing

The throwaway spike comes first — it's the cheapest way to find out which assumptions are wrong before any contract gets written.

| # | Step | Why this slot |
|---|---|---|
| 0 | Lock the umbrella name (Next Step 2 in earlier section) | Blocks every type / route / tool / skill name |
| 1 | **Recon mission** (read-only sweep, see below) | Verify the MCP/IPC primitives the spike will assume |
| 2 | **Throwaway spike** (see below) | One end-to-end run with two planner agents and one worker fork. Throwaway code. Exposes gaps. |
| 3 | **Track 1.A**: watcher polling fix + parser + fixtures | Pure code, no live agents. Parallelizable with step 4. |
| 4 | **Track 2**: idle-signal contract + script harness | Whatever the spike proved out, formalize as an API. |
| 5 | **Track 1.B+C**: type contract + read API + read-only Plans pane | Forcing function — see the format break before write paths multiply issues. |
| 6 | **Track 2**: planning committee primitive | Two agents, idle-driven turn-taking, plan markdown emitted at end. **This is the GroupThink replacement.** |
| 7 | **Track 1.D**: plan-writer + write API | Workers now have somewhere to report. |
| 8 | **Track 2**: fork-and-execute primitive | One phase, one fork, write-back via API, kill. |
| 9 | **Track 1.E**: GroupThink deletion | Old system stays alive until the new one runs end-to-end. |
| 10 | **Track 2**: pacing, delays, run-state transitions | `run_state=delayed`, resume_at, /loop monitoring. |
| 11 | Research integration (`/deep-research` callable from committee) | Layer on top of working committee. |
| 12 | Persistent agents + supervisor variable swapping | Layer on top of working fork-execute. |
| ~~13~~ | Skills leaderboard | Deferred. |

Key inversion vs. PLAN_CONTROL_PLANE's A–F ordering: the planning committee primitive (step 6) lands **before** the write API (step 7). Reason: the committee's only output is one plan markdown, written once via whole-file write — no surgical mutation needed. Fork-and-execute is what needs the write API, because workers update tasks in-place.

## Open meta-decisions

These rewrite the architecture if they flip. Surface before code lands.

1. **How does the script wait?** Polling `list_agents` for idle is the obvious answer but burns context if the supervisor's log includes it. Long-poll endpoint? Event subscription via SSE / WS? Affects api-server.ts surface.
2. **Cancel / pause semantics.** User clicks pause. Script polls `run_state` and refuses to fork the next phase? Script gets SIGTERM from main? Worker agent gets notified mid-task? Define the kill switch up front — retrofitting cancellation is awful.
3. **Plan creation — who writes the first markdown?** The committee, by some skill that scaffolds correct markers, or a `create_plan(name, phases)` write API the committee calls? Don't make planner agents hand-author marker syntax — they will get it wrong.
4. **Persistent vs ephemeral agents in the script.** What does the script actually take — agent IDs, templates, "try persistent first, fall back to ephemeral"? This shapes the skill's args.
5. **Failure recovery.** Script dies with `run_state=running`. Resume? From where? Is durable state in plan markdown only, or is there a sidecar `.run.json`?

## Recon mission (Step 1)

Read-only sweep. Output is a "Recon Findings" section appended to this doc with concrete answers and a list of gaps that must be filled before the spike runs end-to-end.

Targets — for each, answer "does it work the way the vision assumes, and if not, what's the gap?"

- **`launch_agent`**: parameters today? Can callers inject a system prompt / initial user message? Does it return an agent_id synchronously? Is the launch async (returns immediately) or blocking until the agent is ready?
- **`fork_agent`**: does it preserve parent context — full conversation history, tools, working dir? What's the cost of a fork? Are forks named / addressable? Cleanup semantics (does killing a fork affect the parent)?
- **`send_message_to_agent`**: synchronous or async? What does the receiving agent see — system message, user message, interrupt? Do they auto-respond, or only when next prompted? Token cost on receiver side?
- **`list_agents`**: is there a `status` / `idle` / `last_activity_at` field today? If not, what's the cheapest path to one — a status field on the agent record, or watch stdin-without-stdout-since-N-seconds in the supervisor child?
- **`read_agent_log`**: real-time tail or only snapshot? Pagination? Does it include the agent's reasoning, tool calls, both?
- **`event-payload-builder.ts`**: can a *child process* (the orchestration script) inject events into supervisor stdin, or is the API only callable from main-process code? If the latter, what's the minimal bridge — script hits an HTTP route that calls the builder?
- **`file-writer.ts`**: does it serialize concurrent writers? If not, what happens with two near-simultaneous `update_task_status` calls — does plan-writer need its own mutex?
- **`/loop`**: what does "monitor a script" actually mean — re-run a skill that polls a log file, watch a status sidecar, read the script's stdout? Confirm the mental model.
- **Skill invocation contract**: when a skill is invoked, can it spawn a long-running detached process? Does that process inherit the supervisor's stdin pipe, or does it need a separate channel?
- **Notebook stack main-process side**: read what's actually in `src/main/` for jupyter-collab. The renderer-side analogy is in PLAN_CONTROL_PLANE; the main-process analogy is closer to the plan-writer's flow and worth pinning down.

Recon is read-only — no code changes, just file reads, MCP introspection, and a written report.

## Throwaway spike spec (Step 2)

Write a single Node script (~150–300 lines, no tests, no abstractions) that exercises every primitive the full vision needs, against a trivial task. Throwaway. Job is to find what's actually missing.

Trivial task: *"Create a hello-world script. One phase, one task."*

Spike does, in order:

1. Skill invocation in the supervisor → script spawns as a child process.
2. Hard-code a tiny plan markdown to `.claude/plans/spike.md` (no parser involved — fixed string).
3. Launch 2 agents from 2 providers via `launch_agent`. Inject a hard-coded planning prompt referencing the spike plan.
4. Detect when both agents are idle. *Use whatever signal the recon found.*
5. Take agent A's last response, send it to agent B via `send_message_to_agent`. Wait for idle.
6. `fork_agent` one of the planners. Send the fork the phase prompt. Wait for idle. Kill the fork.
7. Have the fork (or the script post-hoc) append a note to `.claude/plans/spike.md` via direct edit. (Skip the writer API — not built yet.)
8. Script emits a `[DASHBOARD EVENT]` for each transition that would be a "supervisor-worthy event" in the real system.
9. Script exits.

Success criteria: the loop completes once, end-to-end. The spike's output is **what didn't work**:

- Idle detection flaky? → idle-signal API needs to be built before step 4 in real sequencing.
- Forks lose context? → fork-and-execute model needs revision.
- `send_message_to_agent` requires an extra prompt to elicit a response? → committee's turn-taking needs a different mechanism.
- Event injection from a child process not possible? → bridge needed before any real script runs.

Each gap becomes a task in Track 2, ordered ahead of dependent steps in the sequencing table.

## Out of v1 (deferred, in priority order if scope opens up)

1. Pacing / delays / `run_state=delayed` handling
2. Research integration (`/deep-research` callable from committee, ping-back when done)
3. Persistent agents + supervisor variable swapping
4. Plan failure recovery + sidecar `.run.json`
5. Plan archival / deletion
6. Dry-run mode for the orchestration script
7. Skills leaderboard

---

# Recon Findings — 2026-04-29

*Two parallel read-only sweeps run against the existing codebase to verify the assumptions in the Full Vision Scoping above. Findings here override anything earlier that contradicts them. File paths and line numbers are exact and verifiable.*

## MCP tool semantics

### `launch_agent` — fire-and-forget, polling required for readiness
- Definition: `src/main/supervisor/index.ts:446-573`. MCP wrapper: `scripts/mcp-supervisor.js:570-597`.
- Accepts `system_prompt` (sent as initial user message after a **3-second sleep**, line 588), plus `prompt`, `provider`, `template_id`, `persona`, `working_directory`, `auto_restart`, `supervised`.
- Returns synchronously with `id, title, status='launching', resumeSessionId` (Claude only). No "agent ready" handshake — the call is fire-and-forget and the 3s sleep is the only guard before the initial prompt is delivered.
- Underlying machinery: Windows uses `execFile` via `WindowsRunner`; WSL uses tmux + bash wrapper. Logs land at `~/.config/AgentDashboard/logs/<agentId>.log` (Linux) or `%APPDATA%\AgentDashboard\logs\` (Windows).

### `fork_agent` — TRUE fork via Claude Code's `--fork-session`
- Definition: `src/main/supervisor/index.ts:1147-1193`. MCP wrapper: `scripts/mcp-supervisor.js:632-635`.
- Implemented as `claude --resume <parent-session> --fork-session` (line 1185, 1188). Claude Code's runtime forks the conversation JSONL at the resume point. **No file copy, no context compaction, no re-launch**. Cheap.
- Fork is a *sibling*, not a parent-child relationship. New UUID, new tmux session, no `parent_id` field in DB. Title is `"<parent.title> (fork)"`. The parentage relationship is logged once in agent events (line 1180) and otherwise must be tracked by the caller.
- Killing a fork has no effect on the parent. Independent processes.

### `send_message_to_agent` — async stdin injection, requires recipient idle
- Validation: `src/main/api-server.ts:133-153`. Send: `src/main/supervisor/index.ts:1459-1481`. MCP wrapper: `scripts/mcp-supervisor.js:555-558`.
- WSL: `tmux send-keys -t <session> <text>`. Windows: PTY stdin write with `\r` appended.
- **The receiver sees a user message.** They do not auto-respond — they read on their next turn. No system-reminder framing, no interrupt.
- **Hard rule: API rejects with 409 if recipient status is `'working'` or `'launching'`** (line 144-149). Only `'idle' | 'waiting' | 'done' | 'crashed'` are accepted. Caller must wait for idle before sending.

### `list_agents` — has a `status` field, idle is silence-derived
- Route: `src/main/api-server.ts:96-104`. MCP wrapper: `scripts/mcp-supervisor.js:527-547`.
- Returned fields: `id, title, status, provider, isSupervisor, workingDirectory, contextStats`.
- **`status` enum:** `'launching' | 'working' | 'idle' | 'waiting' | 'done' | 'crashed' | 'restarting'`. Maintained by `StatusMonitor` (supervisor/index.ts:1556-1572).
- **Idle inference is output-silence-based**: alive AND `now - lastOutputTime > WORKING_THRESHOLD_MS` (2.5s) → `'idle'`. **An agent in deep thinking with no stdout for >2.5s will be reported as `'idle'`.** This is the single biggest correctness risk for the script's turn-taking.
- `lastOutputAt` exists on the DB record but is **not exposed** in the list_agents summary. Adding it is trivial and would let the script use a wider window (e.g., "idle for ≥5s" before sending).

### `read_agent_log` — hybrid, in-memory ring + disk fallback
- Route: `src/main/api-server.ts:117-123`. Backend: `src/main/supervisor/index.ts:1512-1555`.
- For ≤500 lines: tmux capture (WSL) or in-memory ring buffer (Windows) — live, updated on every data event.
- For >500 lines: disk file at `agent.logPath`. Includes ANSI color codes.
- Pagination is line-count slicing only; max 500 lines per call.
- **JSONL session events** (Claude Code's structured turns/tool calls/thinking) live separately at `~/.claude/projects/<sessionId>/logs.jsonl` and are NOT in `read_agent_log`'s output. They're polled by `SessionLogReader` (supervisor/session-log-reader.ts:18-199) and emitted via the `'chat-events'` channel.

## Orchestration infrastructure

### `event-payload-builder.ts` — main-process only, HTTP bridge needed
- File: `src/main/supervisor/event-payload-builder.ts` (139 lines).
- Five existing event types: `status_change`, `context_threshold`, `groupthink_start`, `team_created`, `team_loop_detected`.
- Used internally by `supervisor/index.ts:352-394` (`deliverToSupervisor()`): builds payload, calls `sendInput(supervisor.id, payload)` which writes directly to the supervisor's stdin via `WindowsRunner.write()` or tmux.
- **Stdin is owned by the runner. A child process cannot write to the supervisor's stdin directly.**
- **Workable bridge**: `POST /api/agents/:id/input` (api-server.ts:134-152) already accepts a `text` field and calls `supervisor.sendInput()`. The orchestration script can POST `[DASHBOARD EVENT] ...` strings to the supervisor's input route — same wire format the in-process builder produces. No new route strictly required for the spike.
- Caveat: events queued if supervisor is busy (`supervisorQueuedEvents`, in-memory only). 1–2s latency expected.

### `file-writer.ts` — no mutex, last-write-wins on same file
- File: `src/main/file-writer.ts:178-343`.
- `writeFileContents()` and `createFile()` call `fs.writeFileSync()` directly with `'w'` (truncate) or `'wx'` (exclusive create). No serialization, no per-path queue.
- Two near-simultaneous calls to the **same file** race; middle writes are lost. Different files succeed independently.
- **Implication for plan-writer**: needs its own per-path mutex/queue. The Phase 1 Convergence assumption that `file-writer.ts` would handle serialization is wrong.

### `/loop` — exists at the Claude Code harness layer, not in AgentDashboard
- The Explore agent found no `/loop` implementation in this repo. **That's correct — `/loop` is a Claude Code skill, not an AgentDashboard feature.** It runs at the harness layer (the user's Claude Code session), independent of the dashboard.
- Mental model: AgentDashboard's supervisor is **passive and event-driven**. `[DASHBOARD EVENT]` injection wakes it. There is no in-dashboard polling loop.
- The user can layer `/loop` on top of the supervisor session ("every 30 min, ask the supervisor for a plan-status summary") — supervisor reads the run log file and reports. Independent of the script's own event channel and outside the spike's scope.

### Skill invocation — markdown only, no spawn harness
- `.claude/agents/supervisor/skills/README.md` lists planned skills as ideas; not materialized.
- **Skills are just markdown the model reads.** No code in this repo spawns processes when a skill is invoked. The supervisor itself executes whatever the skill markdown describes — typically by calling Bash, MCP tools, or other available tools.
- **Implication for spike script invocation**: the supervisor invokes the spike via its `Bash` tool — `node scripts/spike.js`. Initially synchronous (Bash blocks until the script exits). For the real system later, detachment + HTTP-event bridge is the path; the spike doesn't need detachment.
- A spawned child process **does not inherit** the supervisor's stdin pipe — it inherits a fresh stdio from the Bash tool's shell. Communication back to supervisor must go through HTTP.
- The spike script needs to know the API server port. Today it's not surfaced as a stable env var; the spike can either (a) accept it as a CLI arg the skill markdown fills in, or (b) read from `agent-registry.json` / a known location. Recon did not pin down a canonical discovery path — flagging as a sub-gap.

### Notebook stack main-process side — Jupyter contents API, not file-writer
- File: `src/main/jupyter-kernel-client.ts:1-467`.
- `executeCell()` (line 254): `m.contents.get()` → mutate in memory → `m.contents.save()` (line 291). Calls Jupyter's contents API directly. **Does not touch `file-writer.ts`.**
- Concurrency is handled server-side by the Jupyter contents API's save queue. Without `jupyter-collaboration` (Phase 0), it's last-save-wins; with it, Y.js CRDT merges automatically.
- **Closest in-repo parallel for plan-writer's flow**: `supervisorQueuedEvents` (supervisor/index.ts:142) — an in-memory event queue drained on a timer. Same pattern (enqueue → debounced drain) is the cleanest plan-writer mutex story.
- Bottom line: the notebook flow is a poor template for plans because Jupyter does the serialization. Plan-writer is a fresh build.

## Gaps, ordered by spike priority

These are the concrete things missing today. Items 1–4 must be addressed (or worked around) for the spike to run; items 5–8 are flags for the real system.

1. **Idle detection is silence-based with a 2.5s threshold.** Spike workaround: poll status, require *N consecutive idle observations* (e.g., 5 polls × 1s = 5s of idle) before treating an agent as ready. Real fix: have `WindowsRunner` / `WslRunner` expose a "waiting for input" signal from Claude Code's session JSONL (the `SessionLogReader` already parses these turns).
2. **`send_message_to_agent` rejects with 409 when recipient is `working`.** Spike workaround: retry-on-409 with backoff after re-polling status. Real fix: optional server-side enqueue mode (`queue_message: true`) so the script can fire-and-forget.
3. **No `[DASHBOARD EVENT]` route.** Spike workaround: POST raw `[DASHBOARD EVENT] ...` text to `/api/agents/:supervisorId/input`. The supervisor parses the marker the same way it does for in-process events. Real fix: dedicated `POST /api/supervisor/events` with typed payload validation.
4. **API port discovery for the spike script.** Spike workaround: skill markdown passes `--api-port` as a CLI arg, supervisor knows the port from launch context. Real fix: write port to a known sidecar (e.g., `~/.config/AgentDashboard/runtime.json`).
5. **`launch_agent` has no readiness handshake.** Today everyone polls. The 3s sleep before initial-prompt delivery is brittle. Real fix: synchronous wait or `agent_ready` event.
6. **`fork_agent` returns no parent_id** in the agent record. Caller tracks parentage manually. Trivial to add as a metadata field.
7. **`file-writer.ts` has no mutex.** Plan-writer must build a per-path queue. The `supervisorQueuedEvents` pattern is the model.
8. **`supervisorQueuedEvents` is in-memory only.** Restart loses queued events. For the spike, irrelevant. For the real system, persist to SQLite via `database.ts`.

## Implications for the spike spec

Adjust the spike (Step 2 in sequencing) accordingly:

- **Step 4 ("Detect when both agents are idle")** becomes: poll `list_agents` every 1s, treat an agent as truly idle only after ≥5 consecutive idle observations. Time out after 60s of "never idle" and report.
- **Step 5 ("Send message")** becomes: re-check recipient status immediately before send; retry-on-409 up to 3 times with 2s backoff.
- **Step 8 ("Emit `[DASHBOARD EVENT]`")** becomes: HTTP POST to `/api/agents/<supervisorId>/input` with body `{ text: "[DASHBOARD EVENT] ..." }`. Spike accepts `--supervisor-id` and `--api-port` as CLI args from the skill.
- **Step 7 ("Fork appends a note via direct edit")** unchanged — still bypasses the writer API.
- New step 0: spike script accepts `--workspace-id`, `--api-port`, `--supervisor-id` and reads them from `process.argv`. Skill markdown documents how to pass them.

## Open items the spike will test (not pre-answerable from recon)

1. Whether the silence-based idle signal is reliable enough in practice when planner agents pause to think during plan exchange.
2. Whether forks behave correctly under `send_message_to_agent` immediately after creation (timing of fork's first `idle` transition).
3. Whether the supervisor cleanly receives `[DASHBOARD EVENT]` payloads injected via `/api/agents/:id/input` — i.e., whether the supervisor's parser (in its CLAUDE.md) treats these as events vs. user input.
4. Token cost of one full spike run, end-to-end.

## Naming reminder

The umbrella name (Step 0) is still pending. Spike code should use neutral placeholders (`scripts/orchestration-spike.js`, `[DASHBOARD EVENT]` types like `spike.phase_done`) so a search/replace pass is cheap when the name is locked.

## Implemented Orchestration Spike - 2026-04-29

This repo now includes a disposable smoke-test implementation of the script-mediated orchestration idea described above. It is intentionally additive and throwaway: no `src/main` routes, database schema, renderer behavior, or public APIs were changed.

### Files added

- `scripts/orchestration-spike.js` - plain Node.js orchestration script using built-in modules only.
- `scripts/spike-prompts/planner.md` - planner role prompt and `CONSENSUS` protocol.
- `scripts/spike-prompts/worker.md` - execution-mode prompt for the forked Claude worker.
- `.claude/agents/supervisor/skills/orchestration-spike.md` - markdown skill the supervisor reads to discover and launch the detached script.

Runtime outputs are created only when the spike is run:

- `.claude/plans/spike-hello-world.md`
- `.claude/plans/runs/spike-<run-id>.log`
- `hello.py`

### What the script does

The spike script validates the AgentDashboard HTTP API, verifies the passed supervisor is the only active supervisor for the target workspace, then launches two unsupervised non-restarting planners:

- Alpha: Claude, with `scripts/spike-prompts/planner.md` as its system prompt.
- Beta: Codex, with the planner prompt sent as normal input.

The script waits for both planners to become `idle` or `waiting`, sends the task, reads Alpha's log, sends the relevant tail to Beta, checks for the literal `CONSENSUS` token, mirrors Beta's result back to Alpha, and continues even if consensus is absent. It then writes a hardcoded plan file, forks Alpha into a Claude worker, sends the worker prompt, waits for completion, and verifies:

- `hello.py` exists.
- `hello.py` is exactly `print('Hello, world!')` with no trailing newline.
- `.claude/plans/spike-hello-world.md` exists.
- The Phase 1 checkbox changed from `[ ]` to `[x]`.
- The `<!-- notes: phase-1 --> ... <!-- /notes -->` block contains a worker note.

Unless `--keep-agents` is passed, the script stops the worker fork and both planners before exiting.

### How to run it through the supervisor

Start AgentDashboard and make sure the workspace has one active supervisor agent. Then send the supervisor this prompt:

```text
Run the orchestration spike - read .claude/agents/supervisor/skills/orchestration-spike.md and execute it.
```

The supervisor should read the skill, discover `supervisorId` and `workspaceId` from `GET /api/agents`, choose the reachable API host/port, and launch the Node script detached. The supervisor should then return to idle while the detached process keeps running.

The skill includes both launch forms:

- Bash/WSL/Git Bash: `nohup node scripts/orchestration-spike.js ... > "$LOG" 2>&1 &`
- PowerShell/Windows: `Start-Process -WindowStyle Hidden powershell ...`

The PowerShell path uses a hidden PowerShell wrapper because native `Start-Process` rejects using the same file for both `RedirectStandardOutput` and `RedirectStandardError`.

### Direct manual run

If you already know the IDs, you can run the script directly from the workspace root:

```powershell
node scripts\orchestration-spike.js `
  --run-id manual-001 `
  --task "Create hello.py and update the spike plan." `
  --workspace-id <workspace-id> `
  --supervisor-id <supervisor-agent-id> `
  --api-host 127.0.0.1 `
  --api-port 24678
```

Useful flags:

- `--keep-agents` leaves the planners and worker fork running for inspection.
- `--quiet` suppresses console output while still writing the run log.
- `--api-port` is tried first, then the script falls back through `24678`, `24679`, `24680`, and `24681`.
- `--api-host` defaults to `AGENT_DASHBOARD_API_HOST`, then the WSL `/etc/resolv.conf` nameserver when under WSL, then `127.0.0.1`.

### Expected dashboard events

The detached script reports progress by posting `[DASHBOARD EVENT] ...` messages to `/api/agents/:supervisorId/input`. The supervisor should receive brief event prompts in this order:

1. `Spike: planners launched`
2. `Spike: consensus check complete`
3. `Spike: plan written`
4. `Spike: phase-1 done`
5. `Spike: complete`

On a top-level failure, it sends `Spike: aborted (...)`.

Event delivery retries `409` responses up to 6 times with 5 seconds between attempts. Failed event delivery is logged as non-fatal so the script does not deadlock waiting for the supervisor.

### Expected files and log output

Tail the run log while the spike is active:

```powershell
Get-Content .claude\plans\runs\spike-<run-id>.log -Wait
```

At success, expect:

- The log reaches `Phase F complete`.
- `hello.py` contains exactly `print('Hello, world!')`.
- `.claude/plans/spike-hello-world.md` has a checked Phase 1 task.
- The Phase 1 notes block contains one concise worker note.
- The planner and worker agents disappear from the dashboard after cleanup, unless `--keep-agents` was used.

The script logs cleanup failures as warnings and includes them in the final `Spike: complete (...)` event. Unmatched `[ERROR]` lines should indicate a real abort, except for event-delivery failures explicitly marked as non-fatal.

### Verification already run

Static checks passed after adding the spike:

```powershell
node --check scripts\orchestration-spike.js
npm run build:main
```

The full manual smoke run still requires a live AgentDashboard supervisor session and was not run during implementation.

### First Spike Test Run — 2026-04-29

First end-to-end smoke run, triggered through the supervisor (the intended path: a separate Claude Code session sent the supervisor an MCP `send_message_to_agent` with "Run the orchestration spike — read .claude/agents/supervisor/skills/orchestration-spike.md and execute it."). Run id `20260429135004-1245`.

This run was **only possible after fixing a separate Windows `send_message_to_agent` bug** documented at [`docs/SEND_INPUT_WINDOWS_BUG.md`](./SEND_INPUT_WINDOWS_BUG.md). Prior to that fix, the MCP message landed in the supervisor's input box but never submitted, so the spike never started. With the fix in place (bracketed-paste body + delayed `\r`), the supervisor went `idle → working` immediately on the MCP call and ran the skill end-to-end.

#### Phase progress

| Phase | Status | Notes |
|---|---|---|
| A — validate API, supervisor, workspace | ✅ pass | Connected to `http://127.0.0.1:24678`, validated supervisor `3f415a66-...` for workspace `694db444-...`. |
| B — launch planners | ✅ pass | Alpha (claude, `50e77536-...`) and Beta (codex, `d8fed708-...`) launched. |
| C — consensus exchange | ⚠ ran but no consensus | Script proceeded per spec ("continues even if consensus is absent"). `Consensus token observed in Beta log: false`. **Not the script's fault — see "Codex regression" below.** |
| D — write plan | ✅ pass | `.claude/plans/spike-hello-world.md` written with Phase 1 task and empty notes block. |
| E — fork Alpha into worker | ✅ pass | Worker fork `8eb1e241-...` created via `claude --resume <parent> --fork-session`. |
| F — worker executes Phase 1 | ❌ aborted | 4× HTTP 409 retries sending phase prompt to the worker, then abort. |
| Cleanup | ✅ pass | All three agents (planners + worker) stopped cleanly. |

#### Why Phase F aborted: silence-based idle false positive

The worker fork was reported `idle` by the dashboard ~2 seconds after fork creation:

```
20:50:35.513 — Forked Alpha into worker 8eb1e241
20:50:37.537 — Worker fork is idle  ← false positive (silence ≠ ready)
20:50:39 / :41 / :43 / :45 — Peer input attempts: HTTP 409 each
20:50:45 — abort
```

This is exactly **Gap #1 from the recon findings**: idle inference is output-silence-based with a 2.5s threshold, so a fresh agent that hasn't produced output yet is reported `idle` while still booting. The script's retry budget (4 attempts × 2s = ~8s) was not generous enough; the worker became actually-ready well after.

**Spike-level fix candidates** (do these in `scripts/orchestration-spike.js`, not in dashboard code):
- Increase retry budget for fresh forks to ~30s.
- Require N consecutive idle observations before treating a fork as ready (recon suggested ≥5 polls × 1s).
- After fork creation, wait for the worker's first output line before sending input.

**Dashboard-level improvement** (deferred): expose `lastOutputAt` in the `list_agents` summary so callers can use a wider window than 2.5s. Today `lastOutputAt` exists on the DB record but is not returned in the summary. This is the cleaner long-term fix.

#### Codex regression in the planner phase

Phase C reported "no consensus" because **Beta (codex) never actually submitted its planner prompt**. Reading Beta's terminal log post-run reveals codex received the body but reacted differently to bracketed-paste markers than Claude Code does:

```
›  [Pasted Content 1019 chars]
   Save and close external editor to continue.
```

Codex (gpt-5.5 CLI) detects `\x1b[200~...\x1b[201~`, stashes the content as a placeholder, and opens an external editor for confirmation. Our subsequent `\r` cannot save+close the editor, so codex stays in this state until killed.

This means the `send_message_to_agent` Windows fix that unblocks Claude agents simultaneously **breaks codex agents**. Before the fix, codex worked (plain `text + '\r'` was being received as typed input); after the fix, codex hangs in a paste-confirmation state.

The proper fix is provider-aware dispatch in `Supervisor.sendInput()`:
- `provider === 'claude'` → bracketed-paste body + delayed `\r` (current Attempt 4)
- `provider === 'codex'` → original `text + '\r'` as one PTY write
- `provider === 'gemini'` → untested; default to codex behavior until proven

Documented in `docs/SEND_INPUT_WINDOWS_BUG.md` as a follow-up.

#### Net assessment

The spike validates the architectural shape end-to-end despite Phase F aborting:

- **Skill-mediated invocation works.** A separate Claude Code session can ask the supervisor to run a skill, the supervisor reads the markdown, and Bash-launches the detached Node script. No supervisor-side prompt engineering needed beyond the `Run the orchestration spike — read .../orchestration-spike.md and execute it.` line.
- **`launch_agent` cross-provider works.** Alpha (claude) and Beta (codex) both launched without dashboard errors.
- **`fork_agent` works.** Worker fork created cheaply via `--fork-session`.
- **`[DASHBOARD EVENT]` injection via HTTP works.** The script delivered `Spike: planners launched`, `Spike: consensus check complete`, `Spike: plan written`, and `Spike: aborted (...)` to the supervisor's stdin. Several deliveries hit transient 409s while the supervisor was busy and retried successfully.
- **Run log + plan markdown artifacts wrote correctly.** `.claude/plans/runs/spike-20260429135004-1245.log` is the durable record of every transition.

Three real issues for the next iteration:
1. (script) Retry/idle-detection tolerance for freshly-forked agents — see Gap #1 above.
2. (dashboard) Provider-aware `Supervisor.sendInput()` so codex agents work alongside Claude.
3. (script — minor) The 6× initial 409 retries on `Spike: planners launched` are wasted log noise — the script could check supervisor status before sending an event.

These are tractable. None of them invalidate the architecture; all three were predicted by the recon as risks to verify. Recon was right.

### Follow-up Patch - 2026-04-29

Applied two narrow fixes after the first spike run:

- `src/main/supervisor/index.ts`: Windows `sendInput()` is now provider-aware. Claude keeps the bracketed-paste body plus delayed Enter path; Codex/Gemini/default Windows agents use plain `text + '\r'` so Codex does not enter its external-editor paste confirmation flow.
- `scripts/orchestration-spike.js`: fresh worker forks now require 5 consecutive ready polls, require at least one output timestamp, and get a 30-second 409 retry budget before the phase prompt send fails.

Static verification passed:

```powershell
node --check scripts\orchestration-spike.js
npm run build:main
```

---

# Post-Spike UX & Architecture Notes — 2026-04-29

*Captured immediately after the first green spike, watching it run from the outside. These are open product / dashboard-side observations, not yet design contracts. Resolve before the script-forward primitives gain real UI surface area.*

## 1. Run-state visibility on the supervisor

**Observation.** From outside the run, there is no visual signal that a script is in progress. Between `[DASHBOARD EVENT]` injections the supervisor card looks idle; the only way to know anything is happening is to `Get-Content -Wait` the run log. As scripts become everyday tooling, the absence of a "running" indicator will be the most common "is it broken or just thinking?" confusion.

**Direction.** A small badge/pill on or near the supervisor's access button: e.g. `Running: orchestration-spike (3 agents)`, with affordance to open the run log in a side pane. Lifecycle = run lifecycle: appears on script start, disappears on exit (clean or aborted, with terminal status briefly shown).

**Cost.** Requires a main-process **run registry** (`runId, scriptName, supervisorId, launchedAgentIds[], startedAt, status, exitReason`). The script registers itself on start (new HTTP route, e.g. `POST /api/runs`), heartbeats or just deregisters on exit. New IPC channel + Zustand slice for renderer subscription.

**Pushback / nuance.** The script today is fully detached and may die without graceful shutdown. The registry needs a stale-run reaper (heartbeat timeout or process-existence check) so a crashed script doesn't leave a zombie pill on the UI forever.

## 2. Run-grouped agent cards

**Observation.** The spike launched Alpha (Claude planner) and Beta (Codex planner) as two visually independent cards. They are conceptually one unit — the planning committee for run X — and rendering them apart loses that. When fork-and-execute kicks in we'll get worker forks in the same situation.

**Direction.** When the dashboard knows an agent was launched by a script, render it inside a containing **Run Card**. Run Cards:

- Group all agents launched by that run (planners, fork workers, reviewer agents) side-by-side.
- Carry the script-running indicator from §1.
- Double-click to expand into a focused detail view.
- Collapse to a compact summary when the run completes.

A user-launched agent stays a normal independent card. This is purely a renderer-layer grouping — no schema collapse on the agent record itself.

**Pushback / nuance.** Worth deciding up front: when a run completes, do its agents stay grouped (historical record) or ungroup back to standalone cards? Strong lean: stay grouped while the agents are alive (`--keep-agents` runs especially), and the Run Card becomes archival. Cleanup of stopped agents removes the card entirely.

## 3. Provenance: dashboard must know who launched the agent

**Observation.** Today the dashboard cannot distinguish an agent launched by a user (UI button) from one launched by a script (`launch_agent` MCP tool). Without that distinction, §1 and §2 are not implementable.

**Direction.** Extend the agent record with two fields, set at `launch_agent` time:

- `launchedByRunId: string | null` — the run that owns this agent (`null` = user-launched).
- `runRole: 'planner' | 'worker' | 'reviewer' | string | null` — script-defined role label, pure metadata for UI captioning.

The script passes these as new `launch_agent` parameters. The renderer reads `launchedByRunId` to decide grouping (§2) and reads the run registry (§1) to render the "running" indicator.

**Pushback / nuance.** These two fields are the smallest schema change that unlocks §1, §2, and §6. Worth landing them before any UI work — they're cheap and forward-compatible.

## 4. Plan write convention enforcement

**Observation.** The spike's first failure was a worker agent trying to edit `.claude/plans/spike-hello-world.md` directly with its Edit tool. Claude Code's permission system gated the edit and popped a dialog the orchestrator could not answer; the agent hung silently. We worked around it by moving plan markdown to the repo root.

**Direction — the fix lives at three layers, not one:**

- **Convention (done):** `CLAUDE.md` already documents that worker / planner / persistent agents must not write under `.claude/`. Worker prompts must point them outside.
- **Script enforcement (do this):** A planning-committee script's first responsibility is to ensure the workspace has a plan-writable folder *outside* `.claude/`. Check for it; create if missing; pass the absolute path into every worker prompt. Don't trust agents to invent the location.
- **Long-term, through the API not Edit:** Per `PLAN_CONTROL_PLANE.md`, structured plan mutations (task status flips, note appends) flow through MCP tools backed by the main-process plan-writer. Once those tools exist, agents stop using Edit on plan markdown entirely.

**Pushback / nuance — there is a real tension in PLAN_CONTROL_PLANE that this exposes.** That doc specifies plans live at `.claude/plans/*.md`. The spike experience says agents direct-editing under `.claude/` hangs. **These reconcile if and only if we commit: plan markdown is API-mutated only — agents never use Edit on it.** Either pin that into the format spec before the write API ships, or move the plans folder out of `.claude/` (e.g., `<workspace>/plans/`). Decide explicitly; do not paper over.

**Where the script actually puts the folder.** Suggestion: the script reads the plan folder location from a workspace-level config (`<workspace>/.agentdashboard.json` or a small workspace record in the dashboard DB). Default is `<workspace>/plans/` if unset. The script creates the folder on first run and registers it with the dashboard so §5's pane knows where to watch.

## 5. Real-time planning-folder pane

**Observation.** As multiple scripts run concurrently against multiple plan markdowns, the user wants a dashboard pane that watches the plans folder and renders activity in real time — tasks getting checked off, notes appended, phase transitions.

**Direction.** This is exactly the read-only Plans pane already on the roadmap as Phase C in `PLAN_CONTROL_PLANE.md`. Reaffirmed priority — it is the user-facing forcing function for the data substrate (parser, types, projection, IPC). Build it once the parser + projection types land in Phase A/B.

**Pushback / nuance.** The pane couples cleanly with §1 and §2: a Run Card on the supervisor view links to the specific plan markdown the run is mutating, and the Plans pane is the cross-run inbox. Same data, two views.

## 6. Termination reason: "killed" ≠ "failed"

**Observation.** When the spike's cleanup path stopped its launched agents at exit, the dashboard rendered them as **failed**. They were not failed — they completed their work and were intentionally stopped by the orchestrator. This is misleading and will erode trust as scripts proliferate.

**Direction.** Add a `terminationReason` field to the agent record:

```
'completed' | 'user_stop' | 'script_stop' | 'crash' | 'timeout' | null
```

The script's `stop_agent` MCP/HTTP call passes the reason. The renderer maps it to distinct visual treatment:

- `completed` → green "Done"
- `script_stop` / `user_stop` → neutral "Stopped"
- `crash` → red "Crashed"
- `timeout` → amber "Timed out"

`script_stop` may carry an optional sub-reason from the script (e.g. `cleanup_at_run_exit`, `phase_complete`, `consensus_reached`) for the Run Card summary.

**Pushback / nuance.** The current "failed" rendering is almost certainly inferring termination cause from process exit code only. The fix is server-side: thread the explicit reason from the stop call into the agent record, and only fall back to "crashed" when no reason was supplied. Combined with §1's run registry, the Run Card can summarize cleanly: *"Run completed: 3 agents launched, 3 stopped via script_stop."*

## How these notes change the sequencing

These observations slot into the existing sequence; they do not reshuffle it.

| Note | Where it slots |
|---|---|
| §3 provenance fields, §6 termination reason | Pure schema additions on the agent record. Land **before** any of §1/§2/§6 UI work. Parallelizable with Track 1.A (watcher fix + parser). |
| §1 run registry + indicator, §2 Run Cards | Renderer + main-process work. Depends on §3. Schedule alongside or just after the Plans pane (Track 1.C). |
| §4 write-convention via API | Already covered: `PLAN_CONTROL_PLANE` write API (Phase D). Add the format-spec clarification *"plan markdown is API-mutated only"* before that phase starts. |
| §5 planning-folder pane | Already covered: Plans pane (Phase C). Reaffirmed priority. |

The umbrella product name (Step 0) is still the global blocker — every type, route, and label in §1–§6 needs a name to live under.

---

# Decisions Locked — 2026-04-29

Two open meta-questions from earlier in this doc are now closed. Apply these to all new code, types, routes, MCP tools, skills, and docs. Earlier sections of this doc that contradict these decisions are historical record; the resolution lives here.

## Decision A — Umbrella name: "orchestration"

The script-forward control system is the **orchestration layer**. Vocabulary:

- **Orchestration layer** — the umbrella concept. Encompasses orchestration scripts, the agents those scripts coordinate, the plans those agents read and write, and the supervisor's role of choosing which orchestration to invoke and consuming event streams from running orchestrations.
- **Orchestration script** — a Node program (e.g., `scripts/orchestration-spike.js`) that drives one type of multi-agent process. There will be many: planning-committee orchestration, deep-research orchestration, fork-and-execute orchestration, persistent-team orchestrations, etc. Each is invoked by a skill the supervisor reads.
- **Orchestration run** (or just **run** in narrow code contexts) — a single live invocation of an orchestration script. Has a `runId`, owns a set of agents (`launchedByRunId` field on the agent record), emits events to the supervisor, terminates with a known exit reason.
- **Supervisor** — sits *above* the orchestration layer. Decides which orchestration to start, observes event streams from running orchestrations, makes judgment calls between runs. The supervisor is not part of any single orchestration.

**Code naming consequences:**

| Surface | Convention |
|---|---|
| Type names | `OrchestrationRun`, `OrchestrationScript`, `OrchestrationEvent`, `OrchestrationRole` |
| HTTP routes | `/api/orchestration/runs`, `/api/orchestration/runs/:id/events`, `/api/orchestration/scripts` |
| MCP tool prefix | `orchestration_*` (`orchestration_start_run`, `orchestration_emit_event`, `orchestration_list_runs`, `orchestration_stop_run`) |
| `[DASHBOARD EVENT]` types | `orchestration.run_started`, `orchestration.phase_done`, `orchestration.run_complete`, `orchestration.run_aborted` |
| UI elements | "Orchestration Card" (per §2 of Post-Spike Notes) groups all agents an orchestration run owns |
| Agent record fields | `launchedByRunId: string \| null`, `runRole: 'planner' \| 'worker' \| ...` |
| Skills folder | `.claude/agents/supervisor/skills/orchestration-*.md` |
| Scripts folder | `.claude/orchestration/scripts/*.js` (long-term home; the spike still lives at repo-root `scripts/orchestration-spike.js` as a throwaway) |

**Relationship to the spike.** The spike that ran green is *one specific* orchestration — the planning-committee orchestration that replaces the retired GroupThink concept. It is not "the orchestration"; it is one instance of a layer that will host many such scripts. New scripts use the same primitives (launch, fork, send_message, [DASHBOARD EVENT] injection, plan-mutation API) but solve different multi-agent problems.

**The retired GroupThink code still needs ripping out** per the deletion checklist in the earlier "Decision: delete the existing GroupThink system" section. That stays gated on PLAN_CONTROL_PLANE Phase A/B landing first so the supervisor never has dead MCP tools.

## Decision B — Plans location: `<workspace>/plans/`

Plan markdowns move out of `.claude/plans/` to a top-level workspace folder. The two folders now have clean conceptual roles:

| Folder | Contains | Edited by |
|---|---|---|
| `.claude/` | "What agents *are*" — agent definitions, skills, memories, settings, **orchestration scripts** | The user; the supervisor *executes* scripts (not edits them). Agents never edit `.claude/` during a run. |
| `<workspace>/plans/` | "What agents *do*" — plan markdowns (active and historical) + run logs | Orchestration scripts via the plan-writer API; agent notes (append-only); the user (raw edits). |

**On-disk layout:**

```
<workspace>/plans/
  plan-2026-04-29-foo.md           # active plan
  plan-2026-04-12-bar.md           # historical plan, completed
  .runs/
    spike-20260429162310-5593.log
    orchestration-foo-001.log
```

`.runs/` is dot-prefixed-hidden so a default `ls` shows only plan markdowns; all plan-adjacent artifacts cluster under one parent.

**Why move:**

- **Forgiving for agents.** Worker agents that direct-edit notes (the "append-only" write mode in `PLAN_CONTROL_PLANE.md`) don't hit Claude Code's `.claude/`-permission dialog. The Phase D write API is no longer a hard prerequisite for worker forks doing useful work.
- **Decoupled from API delivery.** The read-only Plans pane (PLAN_CONTROL_PLANE Phase C) works against agent-edited plans before the structured write API exists.
- **Clean conceptual split.** `.claude/` is "what agents are"; `<workspace>/plans/` is "what agents do." The dashboard's Plans pane reads from the latter. Users can browse the workspace with a default `ls` and immediately see active and historical work.

**Migration done as part of landing this decision:**

- `PLAN_CONTROL_PLANE.md`: search/replaced `.claude/plans/` → `plans/` (read/write path diagrams, file-format section, watcher row, out-of-scope list). Banner updated to reflect umbrella name = orchestration.
- The orchestration-spike's existing artifact paths (`.claude/plans/runs/spike-*.log`, `.claude/plans/spike-hello-world.md`) are **historical record** in `ORCHESTRATION_SPIKE.md` and earlier sections of this doc; they are *not* retroactively edited. Any future spike runs target the new location.
- Older sections of this doc (Phase 1 Findings, Phase 1 Convergence, Recon Findings, etc.) reference `.claude/plans/` as the path-of-the-day; those are kept as historical record. The "Decisions Locked" section is the current contract.

---

# Open question — supervisor's parameter surface to orchestration scripts (2026-04-29)

*Raised after the decisions above were locked. Not yet resolved; flagged here so the design lands before the next orchestration script is authored.*

## The observation

The supervisor will need to vary parameters per orchestration invocation. Concrete examples:

- **Which agents the orchestration should use.** Provider mix (claude + codex vs. claude + claude), persistent agents from the workspace's saved teams vs. ephemeral fresh launches, specific personas, working directory.
- **Communication / pacing parameters.** How long to wait between turns, how many stable-idle polls before treating an agent as ready, retry budgets, phase delays for long-running plans.
- **Task-specific variables.** The plan path, the consensus token, role labels, allowed tools per worker.

The CorePrimatives vision section earlier in this doc already gestured at this:

> "Depending on its determination, may modify variables in the agent execution script — replacing certain generic agent variables with persistent agents — before running the script."

This was written assuming the supervisor literally *edits the script source*. With Decision A locking `.claude/orchestration/scripts/` as the long-term home for orchestration scripts, that's a problem: the supervisor is an agent (Claude Code), and Claude Code's permission system gates Edit-tool writes under `.claude/` — exactly the dialog-hang the spike already hit. Direct script edits by the supervisor would re-create that failure mode.

## Three resolution paths

**Path 1 — parameters via skill front-matter + CLI args (preferred).**
The skill markdown is the contract surface the supervisor reads. Skill front-matter (or a structured "Parameters" section) declares every knob: name, type, default, description. The skill includes a literal invocation template the supervisor fills in. The script accepts those as CLI args (or env vars) and never needs editing.

This is already how the spike works — `--run-id`, `--task`, `--workspace-id`, `--supervisor-id`, `--api-port`, `--keep-agents`, `--quiet`. The supervisor reads `orchestration-spike.md`, fills in the IDs, and runs the script. No editing.

For richer parameters (agent provider, persona id, persistent-agent override, comm pacing), the same pattern extends:

```bash
node .claude/orchestration/scripts/planning-committee.js \
  --planners-providers claude,codex \
  --planner-persona reviewer-2024 \
  --use-persistent-agents team-id-abc \
  --idle-stable-polls 5 \
  --phase-pacing-seconds 0
```

**Path 2 — per-run config file.**
For configuration too rich for CLI args, the script reads a config file the supervisor *writes* from a template. Config lives outside `.claude/` (e.g. `<workspace>/plans/<plan-id>.config.json` co-located with the plan, or `<workspace>/.orchestration/<run-id>.config.json`), so the supervisor's Edit/Write tools hit no permission dialog. The script reads it on startup. Good fit for a rich agent roster, channel-graph spec, per-phase timeout overrides.

**Path 3 — genuine script edits (rare, human-mediated).**
If the supervisor wants to change script *logic* (not parameters) — e.g., "this orchestration should ask for user confirmation between phases" — that's a code change. Surface it as a proposal to the user for review, don't auto-edit. Or: the supervisor scaffolds a *new* script under `<workspace>/orchestration/scripts/<run-id>.js` (workspace-local, agent-editable, outside `.claude/`) and runs that one. Promotion to `.claude/orchestration/scripts/` is a human-curation step.

## Recommendation

Default everything possible to **Path 1** (CLI args declared in the skill). It's already proven by the spike, requires no new infrastructure, and the skill markdown becomes self-documenting parameter surface for the supervisor.

Reach for **Path 2** when the parameter shape is genuinely structured (lists of agents with roles, nested per-phase config). Don't reach for it preemptively — flat CLI args first.

Avoid **Path 3** for in-flight orchestration tuning. If a script needs editing, that's a human-reviewed change, not an autonomous supervisor action. New experimental orchestrations can scaffold under `<workspace>/orchestration/scripts/` without touching `.claude/`.

## Implications for the skill format

This decision pushes more weight onto skill markdown. Rough shape worth pinning down before the next script is authored:

```markdown
---
name: planning-committee-orchestration
type: orchestration
script: .claude/orchestration/scripts/planning-committee.js
parameters:
  - name: planners-providers
    type: csv
    default: "claude,codex"
    description: Provider mix for the planning committee
  - name: idle-stable-polls
    type: int
    default: 3
    description: Consecutive stable-idle observations before treating an agent as ready
  - name: phase-pacing-seconds
    type: int
    default: 0
    description: Delay between phases (>0 to slow execution and conserve tokens)
---

# Planning committee orchestration

(Description, when-to-use, supervisor monitoring guidance, etc.)
```

A small skill-loader helper can validate that the supervisor's invocation supplies all required parameters before running the script — catches missing args at invocation, not at script-startup.

## Where this slots in sequencing

Resolves before the next orchestration script is authored — i.e., before step 6 ("Track 2: planning committee primitive") in the sequencing table. The skill format is the supervisor's interface to the orchestration layer; nailing it down now avoids retrofitting parameter surfaces across multiple scripts later.


Next runtime check: re-run the spike and verify Beta Codex submits the planner prompt and Phase F reaches artifact verification instead of aborting on worker input delivery.
