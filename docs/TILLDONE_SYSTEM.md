# TillDone System: Supervised Long-Running Jobs

## What Problem This Solves

Without a TillDone job, the supervisor has no stopping condition. It keeps poking agents, approving continuations, and burning API calls with no concept of "done." Compaction makes this worse — each time you compact, you lose the history of what was accomplished, so the supervisor can't even tell what's been done already.

A TillDone job is a **contract between the user and the supervisor** that defines:
- What "done" looks like (acceptance criteria — immutable)
- How much budget the job gets (turn limit — hard ceiling)
- What happened along the way (decision log — survives compaction)

The supervisor owns the execution strategy. It creates agents, assigns work, adapts the plan when things go sideways, does research, and calls it quits when the acceptance criteria are met or the budget runs out.

---

## TillDone File Structure

Lives at `.claude/agents/supervisor/tilldone/{slug}.md` — one file per job.

```markdown
# TillDone: auth-refactor

## Acceptance Criteria
These define "done." The supervisor cannot modify these — only the user can.

- [ ] All API endpoints authenticate via OAuth2
  - Verify: `grep -r "jwt" src/ --include="*.ts"` returns zero results
  - Verify: `POST /auth/token` returns valid OAuth2 token
- [ ] Refresh token flow works end-to-end
  - Verify: Token refresh on 401 returns new access token
  - Verify: Expired refresh token returns 403
- [ ] All existing tests pass
  - Verify: `npm test` exits 0
- [ ] No regression in response times
  - Verify: p95 latency < 200ms on /api/users endpoint

## Budget
Turn Limit: 60
Turns Used: 0
Status: pending

## Current Plan
(Supervisor fills this in and adapts it as needed)

## Agents
(Supervisor tracks agent lineage here)

## Decision Log
(Append-only record — survives compaction, never deleted)
```

### Section Rules

| Section | Who writes | Mutability | Purpose |
|---------|-----------|-----------|---------|
| Acceptance Criteria | User + supervisor collaboratively | Immutable once job starts | The "done" condition |
| Budget | User sets limit, system tracks usage | Turn count incremented by system | Cost control |
| Current Plan | Supervisor | Fully mutable — tasks added, dropped, reordered | Living strategy |
| Agents | Supervisor | Append-only | Track which agents worked on what |
| Decision Log | Supervisor | Append-only | Why the plan changed, what was learned |

### Acceptance Criteria Design

Each criterion has:
- A human-readable description of the outcome
- One or more **Verify** lines — concrete commands or checks that prove it's done
- These are outcomes, not implementation steps — "OAuth2 works" not "write OAuth2 middleware"

The supervisor uses the Verify lines to confirm completion. It can run the commands (or have an agent run them) and check the results. If verification fails, the criterion stays unchecked regardless of what the agent claims.

---

## How a TillDone Job Runs

### Phase 1: Job Setup (User + Supervisor)

1. User tells the supervisor what they want done (high-level goal)
2. Supervisor uses its **tilldone skill** to collaboratively craft the acceptance criteria with the user:
   - Pushes back on vague criteria ("make it better" → "what measurable outcome?")
   - Suggests verification commands for each criterion
   - Recommends a turn budget based on complexity
3. User reviews and approves the TillDone file
4. Status changes from `pending` → `active`

### Phase 2: Supervisor Creates Its Agents

This is critical — **the supervisor creates all agents from scratch**. It doesn't monitor pre-existing agents. Every agent in a TillDone job is purpose-built by the supervisor with:

- A **system prompt** injected via `--system-prompt` CLI flag containing:
  - The agent's specific assignment
  - The path to the TillDone file (agent reads it to understand the full picture)
  - Reporting requirements (what to do when stuck, done, or off-plan)
  - Key context from prior agents (if this is a compacted replacement)
- **`isSupervised: true`** so the event bridge notifies the supervisor on status changes

The supervisor's typical pattern:

**Option A — Serial:** Launch one agent at a time, each working on the next piece.

**Option B — Scout-and-fork:** Launch a scout agent to explore the codebase, then fork it into specialized workers that each inherit the scout's context.

**Option C — Parallel specialists:** Launch multiple agents simultaneously, each with a different acceptance criterion to work toward.

The supervisor picks the strategy based on the job. It writes the strategy into the Current Plan section.

### Phase 3: Execution Loop

The supervisor reacts to events and proactively checks on agents:

```
Event: Agent goes idle
  → Supervisor reads agent log (read_agent_log)
  → Checks: Did this advance any acceptance criteria?
  → Checks: Is the agent asking a question? Stuck? Done with its task?
  → Decision: Send next instruction, reassign, compact, or verify completion

Event: Agent crashes
  → Supervisor reads crash log
  → Decision: Restart with adjusted approach, or reassign the task to a new agent

Event: Context threshold (80%+)
  → Supervisor compacts the agent:
    1. Read log → summarize progress and current state
    2. Update Decision Log with what was accomplished
    3. Launch NEW agent with system prompt containing the summary
    4. Point new agent at same TillDone file
    5. Stop old agent
    6. Turn count carries forward (it's in the TillDone file)

Supervisor proactive check (periodic):
  → Read agent logs to see if they're going off-track
  → If agent is doing something not in the plan → intervene
  → If agent is stuck but hasn't gone idle → check context stats, decide whether to wait
```

### Phase 4: Research and Adaptation

When the supervisor encounters something unexpected:

1. **Deep research** — Supervisor launches a research session to investigate (e.g., "is passport.js compatible with opaque tokens?")
2. **Plan adaptation** — Based on research findings, the supervisor updates the Current Plan:
   - Drops tasks that are no longer relevant
   - Adds new tasks discovered during execution
   - Reorders based on new dependencies
   - Logs the decision and reasoning in the Decision Log
3. **Group think** (future) — For high-stakes decisions, query multiple models with the same question, compare answers, pick the best approach

The acceptance criteria never change. The plan changes freely. The log captures why.

### Phase 5: Completion

When the supervisor believes all acceptance criteria are met:

1. **Verify each criterion** — Run the Verify commands or have an agent run them
2. **Mark verified criteria** as `[x]` in the TillDone file
3. If all pass:
   - Update Status to `complete`
   - Stop all agents linked to this job
   - Write final summary in Decision Log
   - Notify the user: "TillDone 'auth-refactor' complete. All 4 criteria verified."
4. If some fail:
   - Log which failed and why
   - Continue working if budget allows
   - Escalate to user if budget is exhausted

### Phase 6: Budget Exhaustion

When `Turns Used >= Turn Limit`:

1. The event bridge sends a hard-stop message to the supervisor:
   ```
   [TURN LIMIT REACHED] TillDone "auth-refactor" — 60/60 turns used.
   Save state. Update TillDone with current progress. Stop all agents.
   ```
2. Supervisor writes final state to the TillDone file:
   - Which criteria are met vs. not
   - What the current plan state is
   - What the active agents were working on
3. Supervisor stops all agents
4. Status changes to `budget_exhausted`
5. TillDone file remains as a complete record — user can review and decide whether to extend the budget or take over manually

---

## Agent System Prompts

When the supervisor creates an agent for a TillDone job, it injects a system prompt via `--system-prompt`. This prompt follows a template but is customized per agent.

### Template: Worker Agent

```markdown
# Worker Agent: {title}

You are a worker agent created by the Supervisor for TillDone job "{job_name}".

## Your Assignment
{specific_task_description}

## TillDone File
Read the full job context at: {tilldone_path}
Your work contributes to the acceptance criteria defined there.

## Reporting Requirements
You MUST report to the supervisor (your output is monitored). Specifically:

### When you finish a task or subtask:
State clearly: "DONE: {what you completed}" and what you verified.

### When you hit a blocker:
State clearly: "BLOCKED: {what's wrong}" and what you've tried.
Do NOT spin trying to fix it silently — report it and wait for guidance.

### When something isn't going as planned:
State clearly: "OFF-PLAN: {what changed}" and what you recommend.
The supervisor will decide whether to adapt the plan.

### When you need information you don't have:
State clearly: "NEED-INFO: {what you need}" and why.
The supervisor may research this or ask another agent.

## Constraints
- Stay focused on your assignment — do not start work outside your scope
- If you finish everything assigned to you, report completion and stop
- Do not modify the TillDone file directly — the supervisor manages it

## Context from Prior Work
{compaction_summary_if_applicable}
```

### Template: Scout Agent

```markdown
# Scout Agent: {title}

You are a scout agent created by the Supervisor for TillDone job "{job_name}".

## Your Assignment
Explore the codebase and build understanding for the following work:
{acceptance_criteria_summary}

## What to Report
When you finish exploring, provide a structured report:
1. Key files and modules involved
2. Current architecture relevant to the task
3. Dependencies and potential conflicts
4. Recommended approach for each acceptance criterion
5. Risks or unknowns that need research

## TillDone File
Read the full job context at: {tilldone_path}

## Constraints
- Do NOT make any code changes — explore and report only
- Be thorough but concise — the supervisor will use your findings to plan execution
```

### Key Design Decisions

**Why `--system-prompt` instead of first-message?**
A first message via `sendInput` is ephemeral — it gets summarized away as context fills up. The `--system-prompt` flag injects text at the system level, which persists throughout the session and survives context compression. The reporting requirements ("say BLOCKED when stuck") need to be durable instructions, not a one-time message.

**Why agents report in structured keywords (DONE, BLOCKED, OFF-PLAN, NEED-INFO)?**
The supervisor reads agent logs. Structured keywords make it easy to scan the log and understand what happened without reading everything. When the supervisor checks an agent's log after an idle event, it can grep for these keywords to quickly assess the situation.

---

## Turn Counting

### What Counts as a Turn

A turn is one **supervisor intervention cycle**:
1. Event fires (agent goes idle/crashed/threshold)
2. Supervisor evaluates (reads logs, thinks)
3. Supervisor acts (sends message, launches agent, compacts, etc.)

Each cycle increments `Turns Used` in the TillDone file by 1.

### Enforcement Mechanism

Turn counting is enforced by the **event bridge in the main process**, not by the supervisor's own tracking (which could drift or hallucinate).

#### Implementation

1. **New field on Agent**: `tillDoneId` — links an agent to a TillDone job file
2. **In the event bridge** (`handleSupervisorEvent` / `deliverToSupervisor`):
   - Before delivering an event, read the TillDone file for the triggering agent
   - Parse `Turns Used` and `Turn Limit`
   - If `Turns Used >= Turn Limit`:
     - Send `[TURN LIMIT REACHED]` message instead of the normal event
     - Block further events for all agents linked to this TillDone
   - If under limit:
     - Deliver the event normally
     - After delivery, increment `Turns Used` in the TillDone file
3. **Fallback**: If the TillDone file can't be read (deleted, corrupted), log a warning and deliver the event anyway — don't silently drop events

#### Turn Budget Heuristics

Suggested defaults for the supervisor's tilldone skill to recommend:
- Simple bug fix: 10-15 turns
- Single-feature implementation: 20-30 turns
- Multi-file refactor: 40-60 turns
- Large feature with unknowns: 80-120 turns

These are starting points. The user can adjust.

---

## Compaction Protocol

When context hits a threshold (80%, 90%, 95%):

### Step 1: Supervisor Reads the Situation
```
read_agent_log(agent_id, 200)  → understand what agent was doing
get_context_stats(agent_id)    → confirm context pressure
```

### Step 2: Supervisor Summarizes
Write to the TillDone Decision Log:
```
- [2026-03-24 16:30] Compacting "route-updater" (def456) at 83% context.
  Accomplished: Tasks A and B done, Task C 60% complete.
  Current state: Working on middleware integration, CORS config pending.
  Key decisions: Using custom middleware instead of passport.js (see entry 03-24 15:01).
  Blockers: None active.
```

### Step 3: Supervisor Creates Replacement Agent
```
launch_agent({
  workspace_id: "...",
  title: "route-updater-v2",
  system_prompt: "# Worker Agent: route-updater-v2\n\n
    You are continuing work from a compacted agent.\n\n
    ## What was accomplished:\n
    {summary from step 2}\n\n
    ## What's next:\n
    {remaining tasks from Current Plan}\n\n
    ## TillDone file: {path}\n
    ## Reporting requirements: {standard template}\n",
  is_supervised: true,
  tilldone_id: "auth-refactor"
})
```

### Step 4: Stop Old Agent
```
stop_agent(old_agent_id)
```

### Step 5: Update TillDone Agents Section
```
## Agents
- context-scout (abc123) — completed, stopped
- route-updater (def456) — compacted at 83% context → route-updater-v2
- route-updater-v2 (jkl012) — active, continuing task C
```

### What Survives Compaction

| Survives | Lost |
|----------|------|
| Acceptance criteria | Agent's full conversation history |
| Current plan | Detailed reasoning from agent's context |
| Decision log (all entries) | File-level edit details |
| Turn count | Intermediate debugging steps |
| Agent lineage | |

The Decision Log is the institutional memory. Every important decision, discovery, or blocker gets logged there before compaction happens. This is why the supervisor reads the agent's log and summarizes before stopping it.

---

## MCP Tool Enhancements Needed

### Enhanced `launch_agent` Tool

The current `launch_agent` tool sends a prompt as a first message via `sendInput`. For TillDone, it needs to support `--system-prompt` injection so the instructions persist at the system level.

```javascript
{
  name: 'launch_agent',
  description: 'Launch a new worker agent with an injected system prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_id: { type: 'string' },
      title: { type: 'string' },
      role_description: { type: 'string' },
      system_prompt: { type: 'string', description: 'System-level prompt injected via --system-prompt flag. Persists throughout the session.' },
      initial_message: { type: 'string', description: 'First user message sent after launch. Use for the immediate task assignment.' },
      is_supervised: { type: 'boolean', default: true },
      tilldone_id: { type: 'string', description: 'Links this agent to a TillDone job for turn counting.' },
    },
    required: ['workspace_id', 'title'],
  },
}
```

**Backend changes:**
- `LaunchAgentInput` gets new fields: `systemPrompt?: string`, `tillDoneId?: string`
- `launchWindowsAgent` / `launchWslAgent` — if `systemPrompt` is provided (and not supervisor), inject `--system-prompt` flag (same mechanism already used for the supervisor)
- Agent DB gets new column: `tilldone_id TEXT` — links to the TillDone slug
- `initial_message` sent via `sendInput` after launch (existing behavior, replaces `prompt`)

### New `create_tilldone` Tool

```javascript
{
  name: 'create_tilldone',
  description: 'Create a new TillDone job file.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: 'URL-safe identifier for the job.' },
      acceptance_criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            verify: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      turn_limit: { type: 'number', default: 60 },
    },
    required: ['slug', 'acceptance_criteria'],
  },
}
```

Writes the TillDone file to `.claude/agents/supervisor/tilldone/{slug}.md`.

### New `update_tilldone` Tool

```javascript
{
  name: 'update_tilldone',
  description: 'Update sections of a TillDone job file.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      current_plan: { type: 'string', description: 'Replace the Current Plan section.' },
      decision_log_entry: { type: 'string', description: 'Append to the Decision Log.' },
      agents_entry: { type: 'string', description: 'Append to the Agents section.' },
      check_criterion: { type: 'number', description: 'Mark acceptance criterion N as done (0-indexed).' },
    },
    required: ['slug'],
  },
}
```

### New `read_tilldone` Tool

```javascript
{
  name: 'read_tilldone',
  description: 'Read a TillDone job file.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
    },
    required: ['slug'],
  },
}
```

---

## Supervisor System Prompt Additions

Add to the supervisor's system prompt in `SUPERVISOR_AGENT_MD`:

```markdown
## TillDone Jobs

You manage long-running jobs via TillDone files. A TillDone job defines acceptance
criteria (the "done" condition) and gives you a turn budget to achieve them.

### Starting a Job
1. Collaborate with the user to define acceptance criteria — each must have
   concrete Verify commands. Push back on vague criteria.
2. Create the TillDone file via `create_tilldone`.
3. Create all agents from scratch using `launch_agent` with `system_prompt`
   and `tilldone_id`. Never monitor pre-existing agents — you build your own team.

### Agent System Prompts
Every agent you create gets a system prompt that includes:
- Their specific assignment
- The TillDone file path (they read it for full context)
- Reporting keywords: DONE, BLOCKED, OFF-PLAN, NEED-INFO
- Context from prior agents if this is a compacted replacement

### During Execution
- Read agent logs on every status event — check for reporting keywords
- Update the TillDone Current Plan as your strategy evolves
- Log every significant decision in the Decision Log (this survives compaction)
- When agents report BLOCKED or NEED-INFO: research the issue, consult other
  sources if needed, then provide guidance
- When agents report OFF-PLAN: decide whether to adapt the plan or redirect

### Compaction
When an agent's context exceeds 80%:
1. Read its log — summarize accomplishments, current state, blockers
2. Write summary to Decision Log
3. Launch a new agent with the summary in its system prompt
4. Stop the old agent
5. Turn count carries forward

### Completion
When you believe all acceptance criteria are met:
1. Verify each criterion using its Verify commands
2. Mark verified criteria via `update_tilldone`
3. If all pass: stop all agents, set status to complete, notify user
4. If some fail: continue if budget allows, escalate if not

### Budget
You have a finite turn budget per job. A turn = one intervention cycle
(event → evaluate → act). When the budget is exhausted, the system sends
a hard stop. Save state and shut down gracefully.
```

---

## Supervisor Skills

Placed in `.claude/agents/supervisor/skills/` and loaded by the supervisor at session start.

### `tilldone-craft.md`

```markdown
# Skill: Crafting a TillDone Job

## When to Use
When the user wants to start a long-running supervised job.

## Process
1. Ask the user for the high-level goal
2. Break it into acceptance criteria — each must answer:
   - What is the observable outcome?
   - How do you verify it? (command, test, file check)
3. Push back on:
   - Vague criteria ("improve performance" → "p95 latency < 200ms")
   - Unverifiable criteria ("code is clean" → "no linting errors, all functions < 50 lines")
   - Missing criteria (if goal implies 4 outcomes but user only listed 2, ask about the rest)
4. Recommend a turn budget:
   - Simple (1-2 criteria, well-understood): 15-25 turns
   - Medium (3-5 criteria, some unknowns): 40-60 turns
   - Complex (5+ criteria, research needed): 80-120 turns
5. Create the TillDone file via create_tilldone

## Good Acceptance Criteria Examples
- "All API endpoints return JSON errors instead of HTML"
  - Verify: `curl -s /api/bad-route | jq .error` returns JSON error object
- "Database migrations run without data loss"
  - Verify: Row count before and after migration matches; spot-check 10 records
- "Authentication works with both old and new tokens during migration"
  - Verify: Old JWT token returns 200; new OAuth2 token returns 200

## Bad Acceptance Criteria (rewrite these)
- "Refactor the auth system" → What does the refactored system do differently?
- "Fix the bugs" → Which bugs? What behavior should change?
- "Make it production-ready" → What specific checks must pass?
```

### `compaction.md`

```markdown
# Skill: Agent Compaction

## When to Use
When an agent's context exceeds 80% and it still has work to do.

## Process
1. Read the agent's last 200 lines of log
2. Read the TillDone file for current state
3. Summarize into a compaction record:
   - What was accomplished (reference acceptance criteria)
   - What's currently in progress (be specific: file, function, approach)
   - Key decisions made and why
   - Active blockers or unknowns
4. Write the compaction record to the Decision Log
5. Create a new agent with system_prompt containing:
   - The compaction summary
   - Reference to the TillDone file
   - The standard reporting requirements
6. Stop the old agent
7. Update the Agents section in the TillDone file

## What to Include in the Summary
- Files that were modified and why
- Tests that were written or modified
- Approaches that were tried and failed (so the new agent doesn't repeat them)
- Dependencies or libraries that were added
- Any configuration changes made

## What NOT to Include
- Full file contents (the new agent can read them)
- Complete conversation history
- Verbose debugging logs
- Anything the new agent can discover by reading the codebase
```

---

## Dashboard Integration

### Agent Cards
- Agents linked to a TillDone show a badge: `TillDone: auth-refactor`
- The badge links to the TillDone file viewer (or just displays the slug)
- Agents created by the supervisor show "Created by Supervisor" in metadata

### Supervisor Panel (future)
- Active TillDone jobs with progress bars (N/M criteria met)
- Turn budget gauge (turns used / turn limit)
- Agent lineage tree (scout → fork-a, fork-b, compacted → fork-a-v2)
- Decision Log viewer

### TillDone Job Launcher (future)
- UI for creating a TillDone job directly from the dashboard
- Form for acceptance criteria with verify commands
- Turn budget slider
- "Start Job" button that creates the file and tells the supervisor to begin

---

## Implementation Phases

### Phase 1: Core TillDone System
- TillDone file format and conventions
- `create_tilldone`, `read_tilldone`, `update_tilldone` MCP tools
- Enhanced `launch_agent` with `system_prompt` and `tilldone_id` support
- `tilldone_id` column in agents DB
- Turn counting in the event bridge (read/write TillDone file)
- Turn limit enforcement (hard stop message)
- Supervisor system prompt update with TillDone instructions
- Supervisor skills: `tilldone-craft.md`, `compaction.md`

### Phase 2: Agent Creation with System Prompts
- Generalize `--system-prompt` injection (currently supervisor-only) to any agent
- `launchWindowsAgent` and `launchWslAgent` support `systemPrompt` for non-supervisor agents
- `directSpawn` for any agent with `--system-prompt` (Windows, to avoid cmd.exe mangling)
- MCP `launch_agent` handler passes `system_prompt` through to the launch flow

### Phase 3: UI Integration
- TillDone badge on agent cards
- "Created by Supervisor" metadata
- TillDone progress indicator on supervisor panel
- Turn budget display

### Phase 4: Group Think (future)
- Multi-model consultation tool
- Supervisor can query Claude, Gemini, Codex agents with the same question
- Consensus-based decision making for high-stakes choices

### Phase 5: TillDone UI Launcher (future)
- Dashboard form for creating TillDone jobs
- Acceptance criteria builder with verify command suggestions
- Live progress tracking with Decision Log viewer
- Agent lineage visualization
