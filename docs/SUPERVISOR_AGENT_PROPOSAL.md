# Supervisor Agent: Autonomous Project Management Layer

## Overview

The Supervisor Agent is an autonomous orchestration layer that keeps worker agents productive without requiring constant human presence. It operates on a simple principle: **most agent stalls are trivial and don't need a human to resolve.** An agent asking "should I continue to phase 2?" just needs someone to say yes. The Supervisor is that someone.

When a situation genuinely requires human judgment, the Supervisor escalates via Telegram/Discord rather than letting the agent sit idle for hours.

## Core Design Principles

### Event-Driven, Not Polling
The Supervisor agent is **not running continuously.** It has near-zero cost when all workers are running smoothly. The dashboard daemon monitors agent status changes and only wakes the Supervisor when a worker needs attention — transitions to `waiting`, `idle`, `crashed`, or hits a context threshold.

### Lean Context, On-Demand Depth
The Supervisor's context window stays almost empty. Its default behavior is to read the last few lines of a worker's terminal output and make a snap decision. For the 90% of cases that are routine ("proceed?", "continue?", "phase complete"), this costs ~500 tokens.

For the 10% of cases that are complex (architectural decisions, ambiguous requirements, conflicting approaches), the Supervisor spins up sub-agents with targeted context, performs deep research, or escalates to the human. It never pre-loads PRDs, codebases, or conversation histories into its own context — it pulls what it needs, when it needs it.

### Opt-In Per Agent
When creating an agent card in the dashboard, the user can toggle **"Supervised"** on or off. Unsupervised agents behave exactly as they do today — they stop and wait for the human. Supervised agents get automatic intervention from the Supervisor when they stall.

## Architecture

```
User (Telegram / Discord / Dashboard UI)
  |
  |  [escalation only — complex decisions, notifications]
  |
  v
Dashboard Daemon (event bus, API, state management)
  |
  |  [status events: agent stopped, context threshold, rate limit]
  |
  v
Supervisor Agent (per workspace, lean context)
  |
  |  [routine: approve continuations, manage context, handle rate limits]
  |  [complex: spawn sub-agents, deep research, escalate to human]
  |
  +---> Worker Agent 1 (implementation)
  +---> Worker Agent 2 (spawned by supervisor for phase 2)
  +---> Worker Agent 3 (forked from agent 1 when context was full)
```

## Supervisor Behaviors

### Tier 1: Automatic (No Human Needed)

**Routine Continuations**
Worker output ends with a confirmation prompt ("Phase 1 complete. Move to phase 2?", "Tests pass. Should I proceed?", "Ready for the next task."). The Supervisor reads the last few lines, recognizes a routine continuation, and sends approval.

**Context Window Management**
The daemon reports an agent's context usage via `contextStats`. When a worker crosses a configurable threshold (e.g., 80%), the Supervisor:
1. Reads the worker's recent output to understand current state
2. Creates a new agent in the same workspace
3. Provides the new agent with a compacted summary: what was accomplished, what's next, key decisions made
4. Lets the original agent finish its current task, then retires it
5. The new agent picks up with a fresh context window

**Rate Limit Handling**
When a worker hits an API rate limit and stalls, the Supervisor doesn't panic. It reads the rate limit reset time from the worker's output, sets a timer, and sends the continue signal after the cooldown. No human intervention needed for what is essentially a "wait and retry."

**Crash Recovery**
The dashboard daemon already auto-restarts crashed agents (up to 5 retries). The Supervisor adds intelligence on top — if an agent crashes repeatedly, the Supervisor reads the error output, decides if it's a transient issue (retry) or a real problem (escalate), and can adjust the approach before restarting.

### Tier 2: Assisted (Supervisor Brings In Help)

**Complex Technical Decisions**
Worker asks: "I found a circular dependency between the auth module and the session manager. Here are three approaches..." The Supervisor recognizes this isn't a routine continuation. It:
1. Spawns a sub-agent loaded with the relevant source files
2. Has the sub-agent analyze the options and recommend an approach
3. If the sub-agent is confident, the Supervisor relays the decision to the worker
4. If the sub-agent is uncertain, escalates to Tier 3

**Research-Required Decisions**
Worker needs information the Supervisor doesn't have (API documentation, library comparisons, compatibility questions). The Supervisor launches a deep research session, waits for results, and uses them to respond to the worker.

### Tier 3: Escalation (Human Required)

**High-Impact Decisions**
Anything involving significant architectural changes, security implications, data model modifications, or scope changes. The Supervisor sends a notification to the user via Telegram/Discord with:
- Which agent is waiting
- What it's asking
- A brief summary of context
- The Supervisor's recommendation (if it has one)

The user replies directly in the messaging app. The Supervisor receives the response and relays it to the worker.

**Ambiguous Requirements**
When the worker's question doesn't have a clear right answer and the Supervisor can't resolve it through research or sub-agents, it escalates rather than guessing.

## Dashboard Integration

### Agent Card: Supervised Toggle
Each agent card gets a "Supervised" toggle. When enabled:
- A visual indicator shows the agent is under Supervisor management
- The dashboard shows Supervisor actions in the agent's event log ("Supervisor approved continuation", "Supervisor forked context at 82%")
- The user can review and override any Supervisor decision retroactively

### Supervisor Status Panel
A dedicated panel in the dashboard showing:
- Active Supervisor instances (one per workspace with supervised agents)
- Recent actions taken (approved, forked, escalated)
- Pending escalations awaiting human response
- Cost summary (tokens used by Supervisor decisions)

### Notification Preferences
User-configurable rules for escalation:
- Which messaging platform (Telegram, Discord, email)
- Quiet hours (batch notifications instead of real-time)
- Escalation urgency levels (crash = immediate, decision = batched)

## Daemon API Requirements

The Supervisor interacts with workers through the dashboard daemon's API. Most of these endpoints already exist:

| Endpoint | Status | Purpose |
|----------|--------|---------|
| `getLastOutput(agentId, lines)` | Exists | Read worker's recent terminal output |
| `sendInput(agentId, text)` | Exists | Send approval/input to a worker |
| `getContextStats(agentId)` | Exists | Monitor context window usage |
| `createAgent(workspace, config)` | Exists | Spawn new workers for phase handoffs |
| `forkAgent(agentId)` | Exists | Fork a conversation to fresh context |
| `queryAgent(agentId, question)` | Exists | Ask a worker for status without terminal input |
| `getAgentLog(agentId, lines)` | Exists | Read detailed history when deeper context is needed |
| `notifyUser(message, urgency)` | New | Send Telegram/Discord notification |
| `onAgentStatusChange(callback)` | New | Event subscription for status transitions |
| `getAgentConfig(agentId)` | New | Check if agent is supervised, get thresholds |

## Example Scenarios

### Scenario 1: Multi-Phase Project, User Away
The user defines a 5-phase project in a PRD, creates a worker agent, enables "Supervised", and leaves for dinner.

1. Worker completes phase 1, asks "proceed to phase 2?" → Supervisor approves
2. Worker hits 75% context during phase 2 → Supervisor monitors
3. Worker completes phase 2, hits 85% context → Supervisor creates a new agent with compacted context, starts phase 3
4. New agent hits a rate limit → Supervisor waits for reset, sends continue
5. Agent asks "the PRD says to use REST but GraphQL would be better here, should I deviate?" → Supervisor escalates to user via Telegram
6. User replies "stick with REST" → Supervisor relays to agent
7. Phases 3-5 complete. User comes back to a finished project with a notification summary.

### Scenario 2: Five Projects Running Overnight
The user has 5 workspaces with 2-3 agents each, all supervised. They go to bed.

- 11 PM: Three agents complete tasks and get auto-approved to continue
- 11:30 PM: One agent crashes. Supervisor reads the error (OOM), restarts with a note to reduce batch size
- 1 AM: Agent hits context limit. Supervisor forks to fresh context
- 3 AM: Agent asks a question that requires human input. Supervisor sends Telegram (batched, not immediate — it's quiet hours)
- 7 AM: User wakes up to one Telegram message with 3 items needing decisions. Everything else was handled automatically.

### Scenario 3: Context Compaction Handoff
A worker agent has been implementing a feature for 45 minutes. Context is at 88%.

1. Supervisor detects the threshold
2. Queries the worker: "Summarize your current progress, remaining tasks, and key decisions made"
3. Worker responds with a structured summary
4. Supervisor creates a new agent in the same workspace
5. Sends the new agent: the summary, the PRD section for remaining work, and any relevant file paths
6. New agent picks up at 5% context with full awareness of what was done
7. Old agent is retired

## Context Digest: What the Supervisor Sees

### The Problem

When the Supervisor gets pinged that an agent stopped, it needs to understand what happened — fast. The raw log contains everything (tool outputs, ANSI sequences, intermediate reasoning), but 90% of it is noise for decision-making. The Supervisor needs a **compressed, structured view** that answers:

1. **What was the agent's task?** (the original user instruction)
2. **What did it accomplish?** (progress so far)
3. **Why did it stop?** (the final output — a question? an error? completion?)
4. **What files were involved?** (reads, writes, creates — with context about *why*)

### Data Source: JSONL Session Files

We're already parsing Claude Code's JSONL session files for context stats and file activities. These files contain the **full structured conversation** — every user message, every assistant response, every tool call with parameters and results. This is far richer than scraping the PTY log.

From the JSONL we extract:
- `human` turns → user inputs (what the user asked for)
- `assistant` turns with text content → agent reasoning/responses
- `assistant` turns with `tool_use` blocks → tool calls (Read, Write, Edit, Bash, etc.)
- `tool_result` blocks → tool outputs (file contents, command results)
- `message.usage` → token counts (already extracted for context stats)

### The Context Digest Structure

```typescript
interface AgentContextDigest {
  agentId: string;
  updatedAt: string;

  // === TASK ===
  // The first user input — what kicked this agent off
  task: string;

  // === LATEST STATUS ===
  // The last assistant text block — what the agent said most recently.
  // This is the most critical field. If the agent is waiting, this tells
  // the supervisor WHY ("Phase 1 complete. Should I proceed?", "I hit an
  // error in auth.ts", "All tests pass. Done.")
  latestOutput: string;

  // === USER INPUTS ===
  // All human turns, in order. These represent the user's instructions
  // and decisions throughout the session.
  userInputs: {
    text: string;          // The user's message (truncated to ~200 chars)
    timestamp: string;
    turnIndex: number;     // Position in conversation
  }[];

  // === KEY AGENT RESPONSES ===
  // Not every assistant turn — just the ones that mark progress:
  // task completions, decisions made, questions asked, errors hit.
  // Filtered by heuristics (see below).
  keyResponses: {
    text: string;          // The agent's message (truncated to ~500 chars)
    timestamp: string;
    turnIndex: number;
    category: 'progress' | 'decision' | 'question' | 'error' | 'completion';
  }[];

  // === FILE ACTIVITY ===
  // Files the agent interacted with, enriched with context.
  filesWritten: {
    path: string;
    operation: 'write' | 'create';
    timestamp: string;
    context?: string;      // What the agent said about this file (see below)
  }[];

  filesRead: {
    path: string;
    timestamp: string;
    context?: string;
  }[];

  // === TOOL SUMMARY ===
  // Aggregated tool usage — gives a quick sense of what the agent did.
  // e.g., { Read: 12, Edit: 5, Write: 2, Bash: 8, Grep: 3 }
  toolCounts: Record<string, number>;

  // === CONTEXT STATS ===
  // Already have this — token usage, model, turns, percentage.
  contextStats: ContextStats | null;
}
```

### How We Get File Descriptions

The hardest part: how do we know *why* an agent read or wrote a file? Two approaches:

**Approach 1: Adjacent Model Text (Recommended)**
When the agent calls `Write(src/auth.ts)`, there's usually model text immediately before it: "Let me create the authentication handler..." We capture the model text that precedes each tool call and attach it as `context`. This is cheap — we're already iterating through the JSONL blocks.

**Approach 2: File Metadata Only (Fallback)**
If there's no useful adjacent text, we fall back to what we can infer:
- File extension → type (`auth.ts` = TypeScript module)
- Path segments → role (`src/main/` = Electron main process code)
- Operation → what happened (`create` = new file, `write` = modified existing)

We do NOT read file contents for descriptions. That's expensive and the supervisor doesn't need it. The file *name* plus the agent's own description of what it was doing is enough.

### Filtering Key Responses

Not every agent response goes into `keyResponses`. We filter using heuristics:

- **Progress markers**: Text containing phrases like "complete", "done", "finished", "implemented", "created", "phase N"
- **Questions**: Text ending with `?` (the agent is asking something)
- **Errors**: Text containing "error", "failed", "issue", "problem", "bug"
- **Decisions**: Text containing "I'll use", "going with", "choosing", "decided"
- **First and last**: Always include the first agent response (initial plan) and the last (current state)

This keeps the digest focused. A 50-turn conversation might compress down to 8-12 key responses.

### UI: Redesigned Context Tab

The Context tab transforms from a flat file list to a structured digest view:

```
┌─────────────────────────────────────────┐
│  TASK                                   │
│  "Implement user authentication with    │
│   JWT tokens per the PRD spec"          │
├─────────────────────────────────────────┤
│  LATEST STATUS                    ● idle│
│  "Phase 2 complete. All auth endpoints  │
│   pass tests. Ready for phase 3 —       │
│   should I proceed to the admin panel?" │
├─────────────────────────────────────────┤
│  TIMELINE                               │
│  ┊ 14:02  User: "implement auth..."     │
│  ┊ 14:05  ✓ Created auth module         │
│  ┊ 14:12  ✓ JWT middleware done         │
│  ┊ 14:18  ✓ Login/logout endpoints      │
│  ┊ 14:23  ? "Proceed to phase 3?"       │
├─────────────────────────────────────────┤
│  FILES MODIFIED           5 written     │
│  ▸ src/auth/handler.ts    (created)     │
│    "JWT authentication handler"         │
│  ▸ src/auth/middleware.ts (created)     │
│    "Express middleware for token..."    │
│  ▸ src/routes/index.ts    (modified)    │
│    "Added auth routes"                  │
├─────────────────────────────────────────┤
│  FILES READ               12 read      │
│  ▸ docs/PRD.md                          │
│  ▸ src/routes/index.ts                  │
│  ▸ package.json                         │
│  ▸ +9 more...                           │
├─────────────────────────────────────────┤
│  TOOLS  Read:12 Edit:5 Write:2 Bash:8  │
│  CONTEXT  67% (134k/200k) · 23 turns   │
└─────────────────────────────────────────┘
```

### Tiered Retrieval: Controlling What the Supervisor Sees

The Supervisor must not re-read the entire context history every time an agent stops. If we expose the full digest and tell the model "only read the latest," it will consume the entire tool response anyway — the model doesn't control tool output size. **The API itself must enforce what gets returned at each tier.**

Three layers, from cheapest to most expensive:

#### Layer 1: Event Payload (~150-300 tokens) — Push Model

When an agent's status changes, the daemon constructs a tiny structured message and **pushes** it to the Supervisor. The Supervisor doesn't call anything — it receives exactly this:

```typescript
interface AgentEvent {
  agentId: string;
  agentTitle: string;
  workspaceId: string;

  // What happened
  previousStatus: AgentStatus;
  newStatus: AgentStatus;
  trigger: 'status_change' | 'context_threshold' | 'rate_limit' | 'crash';

  // The two most important fields — enough for 90% of decisions
  lastUserInput: string;     // What the user last told the agent (~200 chars)
  lastAgentOutput: string;   // What the agent last said (~500 chars)

  // Quick stats
  contextPercentage: number;
  turnCount: number;
  model: string;
}
```

Example of what the Supervisor actually receives:

```
Agent: "auth-implementer" (agent-abc123)
Status: idle (was: working)
Trigger: status_change
Last user input: "Implement JWT authentication per the PRD spec.
  Use bcrypt for password hashing."
Last agent output: "Phase 2 complete. All auth endpoints pass
  tests. Should I proceed to the admin panel?"
Context: 67% (134k/200k) · 23 turns · opus-4
```

For ~90% of cases (routine continuations, simple approvals), the Supervisor reads this, says "yes proceed," and goes back to sleep. **Total cost: ~300 tokens in + ~100 tokens out.**

The Supervisor never sees Layer 2 or 3 unless it explicitly requests them.

#### Layer 2: Context Digest (~1500-3000 tokens) — Pull Model

Only when the Supervisor can't decide from Layer 1. It calls `getContextDigest(agentId)` and gets the full structured digest — task, timeline, files, key responses. This covers complex-but-resolvable cases (e.g., the agent hit an error and the Supervisor needs to understand what it was working on).

```typescript
// Daemon API
getAgentContextDigest(agentId: string): AgentContextDigest
```

#### Layer 3: Raw Log (variable) — Pull Model

Only for deep investigation. The Supervisor calls `getAgentLog(agentId, lines)` for the raw terminal output. Almost never needed — reserved for crash debugging or situations where the structured data doesn't capture enough.

```typescript
// Daemon API
getAgentLog(agentId: string, lines?: number): string
```

#### Incremental Digest: Append-Only Event Log

To support repeated check-ins without re-reading the full digest, the daemon also maintains an **append-only event log** per agent. Each time the agent completes a significant action, the daemon appends a small entry:

```typescript
interface DigestEntry {
  id: number;              // Auto-incrementing, monotonic
  agentId: string;
  timestamp: string;
  type: 'user_input' | 'agent_response' | 'file_write' | 'file_create'
       | 'file_read' | 'error' | 'tool_use' | 'status_change';
  summary: string;         // Short text (~100 chars max)
  turnIndex: number;
}
```

The Supervisor can then request only entries it hasn't seen:

```typescript
// "Give me everything since entry #42"
getDigestEntries(agentId: string, sinceId: number): DigestEntry[]
```

This solves the re-reading problem completely. On first check-in, the Supervisor gets the Layer 1 event payload. If it needs more, it pulls the full digest (Layer 2). On subsequent check-ins for the same agent, it only pulls new entries since its last read. The `sinceId` cursor is tracked per-agent in the Supervisor's own state.

#### The Event Flow

```
Agent status changes
  → Daemon detects (status poll, every 2.5s)
  → Daemon builds Layer 1 event payload (tiny, ~200 tokens)
  → Daemon sends to Supervisor via sendInput() or structured message
  → Supervisor reads payload, decides:
     ├─ ROUTINE → approve via sendInput(workerId, "yes"), done
     ├─ NEED MORE CONTEXT → pull Layer 2 digest, then decide
     ├─ NEED RAW DETAILS → pull Layer 3 log, then decide
     └─ NEED HUMAN → escalate via notifyUser()
```

The Supervisor is **not polling**. It's asleep until the daemon wakes it with a Layer 1 payload. The daemon is the only thing that polls (agent status every 2.5s, context stats every 5s — both already implemented).

#### Why Not Just Tell the Model to "Only Read the Latest"?

This doesn't work reliably for three reasons:

1. **Tool output is atomic.** When a tool returns 5000 tokens, the model consumes all 5000 tokens whether it "needs" them or not. You can't tell the model to skip part of a tool response.

2. **Models are thorough by nature.** If you give a model access to `getFullLog()` and say "only read the last 10 lines," it might comply... or it might read everything "to be safe." You can't enforce behavioral constraints on tool usage — you can only enforce data constraints on tool output.

3. **Token cost is real.** Even if the model "ignores" earlier content, it still pays for it in the context window. A 10,000-token digest that the model "skips past" still costs 10,000 input tokens.

The solution is architectural: **the API returns only what's needed at each tier.** The model never gets the chance to over-read because the data simply isn't there unless explicitly requested.

### Supervisor API Summary

| Endpoint | Layer | Tokens | When Used |
|----------|-------|--------|-----------|
| Event payload (pushed) | 1 | ~200 | Every status change — automatic |
| `getContextDigest(agentId)` | 2 | ~2000 | Supervisor needs full picture |
| `getDigestEntries(agentId, sinceId)` | 2.5 | ~100-500 | Incremental updates between checks |
| `getAgentLog(agentId, lines)` | 3 | variable | Deep investigation, crash debugging |
| `sendInput(agentId, text)` | — | — | Send approval/instruction to worker |
| `notifyUser(message, urgency)` | — | — | Escalate to human |

### Existing Files Tab → Outputs Tab

The current "Context" tab (which just lists files read) moves into the digest view above. The "Outputs" tab stays as-is — it's already useful for seeing what files were created/modified. We may enrich it later with file diffs or previews, but that's separate scope.

## Implementation Path

### Build Order Rationale: Context Digest Before Supervisor CLI

**The Context Digest must be built and validated before exposing the app to the Supervisor over CLI.** This is a hard dependency, not a preference. Three reasons:

1. **The digest IS the supervisor's eyes.** Without it, the supervisor has nothing to read except raw terminal logs — thousands of lines of ANSI-stripped tool output, intermediate reasoning, and noise. Exposing the CLI first would mean building the supervisor against an unstable, unstructured data source, then rebuilding it when the digest lands. That's double the work.

2. **The UI is our testing ground.** Building the Context tab first lets us iterate on what information is actually useful by looking at it ourselves. We'll see immediately if the key response filtering is too aggressive, if file descriptions are missing, if the timeline is noisy. Once we're happy with what the UI shows, that exact data structure becomes what the supervisor reads — no guesswork about what a model "needs."

3. **The structured data layer must exist before the API layer.** The tiered retrieval system (Layer 1 events, Layer 2 digest, Layer 2.5 incremental entries) all depend on the same underlying JSONL parser and digest builder. The CLI endpoints are thin wrappers around this core. Build the core first, then the wrappers are trivial.

**Concretely: Phase 1 ships a working Context tab in the dashboard UI. Phase 2 exposes that same data over CLI/API for the supervisor. Phase 3+ builds the supervisor itself.** Do not skip ahead — a supervisor reading raw logs will make worse decisions, cost more tokens, and be harder to debug than one reading structured digests.

---

### Phase 1: Context Digest — Data Layer + UI
*Build the structured data extraction and validate it visually in the dashboard.*

- Build JSONL deep parser — extract user inputs, assistant text, tool calls with adjacent context
- Implement `AgentContextDigest` structure and builder
- Implement `DigestEntry` append-only event log
- Key response filtering heuristics (progress/question/error/decision/completion)
- File activity enrichment — attach agent's description text to file operations
- Redesign Context tab UI from flat file list to structured digest view
- Validate by running real agents and reviewing the digest output in the UI
- Iterate on filtering, truncation, and categorization until the digest is reliably useful

### Phase 2: Supervisor Data API — Expose Digest Over CLI
*Make the digest and tiered retrieval available to external consumers (the supervisor).*

- Expose `getContextDigest(agentId)` via IPC bridge and CLI-accessible API
- Expose `getDigestEntries(agentId, sinceId)` for incremental reads
- Implement `AgentEvent` payload builder for Layer 1 push events
- Wire `onAgentStatusChange` event subscription to daemon
- Add `getAgentConfig(agentId)` for supervised flag and thresholds
- Test the full tiered retrieval flow: event → digest → log fallback

### Phase 3: Supervisor Foundation
*Now that the data layer is solid, build the supervisor itself.*

- Add `supervised` flag to agent configuration UI
- Build notification bridge (Telegram webhook — ~100 lines)
- Create the Supervisor agent's base CLAUDE.md
- Implement Supervisor wake/sleep lifecycle tied to agent events

### Phase 4: Core Autonomy
- Implement Tier 1 behaviors (routine approval, rate limit handling)
- Context threshold monitoring and alerts
- Basic crash recovery intelligence

### Phase 5: Context Management
- Automated context compaction and agent forking
- Worker summary extraction for handoffs (uses Context Digest)
- Cost tracking for Supervisor token usage

### Phase 6: Deep Assistance
- Sub-agent spawning for complex decisions
- Deep research integration
- Tier 2 → Tier 3 escalation logic with confidence thresholds

### Phase 7: Notification and Remote Control
- Telegram/Discord bidirectional messaging
- User reply → agent input pipeline
- Quiet hours and notification batching
- Mobile-friendly status summaries
