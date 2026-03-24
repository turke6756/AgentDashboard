# Supervisor Agent: Autonomous Project Management Layer

## Implementation Status (Updated 2026-03-23)

### What's Built and Working

**Supervisor Agent Core**
- Supervisor launches as a dedicated Claude Code instance per workspace via toolbar button
- Custom system prompt injected via `--system-prompt` flag (not CLAUDE.md — ensures isolation)
- Auto-scaffolded folder structure at `.claude/agents/supervisor/` (memory, skills, scripts)
- One supervisor per workspace, with duplicate prevention
- Stop/reset button (✕) on toolbar deletes agent and clears session for fresh restarts
- `is_supervisor` column in DB, filtered out of agent grid — lives in toolbar only

**MCP Tools (Primary Interface)**
- MCP server at `scripts/mcp-supervisor.js` — stdio, newline-delimited JSON-RPC
- Passed to Claude Code via `--mcp-config` CLI flag (bypasses file discovery and trust approval)
- 7 tools: `list_agents`, `read_agent_log`, `send_message_to_agent`, `get_context_stats`, `stop_agent`, `launch_agent`, `fork_agent`
- MCP server proxies to HTTP API server in Electron main process
- Works on both Windows (127.0.0.1) and WSL (auto-detects Windows host IP)

**HTTP API Server**
- `src/main/api-server.ts` — lightweight HTTP server on port 24678, bound to 0.0.0.0
- Endpoints: GET/POST/DELETE on `/api/agents`, `/api/agents/:id/log`, `/api/agents/:id/input`, `/api/agents/:id/context-stats`, `/api/agents/:id/fork`
- Status gate on send-input: rejects messages to working/launching agents
- Available as curl fallback if MCP tools are unavailable

**Platform Support**
- Windows: `directSpawn` bypasses cmd.exe for multiline `--system-prompt` args
- WSL: base64-encoded scaffold writes, resolv.conf host IP detection for API access
- Both platforms confirmed working with MCP tools connected

### Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| `--system-prompt` over `--agent` flag | `--agent` was unreliable for loading prompts; `--system-prompt` injects directly |
| `--mcp-config` over `.mcp.json` | File-based MCP discovery had trust approval issues and path casing bugs on Windows |
| Newline-delimited JSON over Content-Length | MCP spec requires `{json}\n`, not LSP-style `Content-Length` framing |
| HTTP API backing MCP server | MCP server is a thin proxy; HTTP API also serves as curl fallback |
| `directSpawn` on Windows | cmd.exe mangles multiline args; direct claude.exe spawn preserves them |

### What's Not Built Yet

- **Event-driven triggering** — StatusMonitor → sendInput bridge (supervisor still requires manual interaction)
- **Context Digest** — structured JSONL parsing for Layers 1-3 (Phase 1 in proposal)
- **Supervised toggle** — per-agent opt-in flag on agent cards
- **Notification bridge** — Telegram/Discord escalation
- **Knowledge Graph integration** — file relationship queries
- **Cost tracking** — supervisor token usage monitoring

### Architecture (as implemented)

```
User clicks Supervisor button
  → Dashboard scaffolds .claude/agents/supervisor/ (if first launch)
  → Dashboard launches Claude Code with:
      --system-prompt <supervisor role>
      --mcp-config <JSON with agent-dashboard server>
      --dangerously-skip-permissions
      --session-id <uuid>
  → Claude Code spawns mcp-supervisor.js (stdio)
  → MCP server connects to HTTP API on port 24678
  → Supervisor has 7 MCP tools to manage worker agents

MCP Tool Call Flow:
  Supervisor calls list_agents()
    → mcp-supervisor.js receives JSON-RPC
    → HTTP GET http://127.0.0.1:24678/api/agents
    → api-server.ts calls supervisor.getAgents()
    → JSON response back through MCP to supervisor
```

---

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

### The Supervisor Is Just Another Agent Card

The Supervisor is not a separate system — it's a **Claude Code agent running in the workspace**, launched and managed exactly like any work agent. It shows up as an AgentCard in the sidebar. You can attach to its terminal, see its context usage, watch its file activity. All existing dashboard infrastructure applies.

What makes it special:
- Its **CLAUDE.md** defines a supervisor role with constraints (don't edit code directly, focus on coordination)
- It has **MCP tools** that bridge to dashboard functionality (query agents, send messages, query the knowledge graph)
- It uses a **cost-effective model** (Haiku for routine decisions, with Sonnet available for complex reasoning)
- The **dashboard acts as its event bus** — when a supervised work agent goes idle, the dashboard sends a structured event to the supervisor via `sendInput()`

This approach reuses all existing infrastructure: agent launching, PTY management, status monitoring, terminal attachment, context tracking. Zero new UI code needed for the supervisor itself.

### Runtime Architecture

```
User (Telegram / Discord / Dashboard UI)
  |
  |  [escalation only — complex decisions, notifications]
  |
  v
Dashboard Main Process (event bus, state management)
  |
  ├── StatusMonitor (polls every 2.5s — already exists)
  │     → detects supervised agent went idle/crashed/waiting
  │     → builds Layer 1 event payload (~200 tokens)
  │     → calls sendInput(supervisorAgentId, payload)
  |
  ├── MCP Server (runs in-process, exposes tools to supervisor)
  │     → send_message_to_agent(agentId, message) → sendInput()
  │     → get_context_digest(agentId) → digestBuilder.build()
  │     → list_agents() → supervisor.getAgents()
  │     → query_knowledge_graph(...) → knowledgeGraph.query()
  │     → notify_user(message, urgency) → notification bridge
  |
  v
Supervisor Agent (Claude Code process via node-pty, with MCP tools)
  |  Receives events as terminal input from dashboard
  |  Calls MCP tools to inspect agents and take action
  |  [routine: approve continuations, manage context, handle rate limits]
  |  [complex: request dashboard to spawn sub-agents, escalate to human]
  |
  +---> Worker Agent 1 (via send_message_to_agent MCP tool)
  +---> Worker Agent 2 (via launch_agent MCP tool)
  +---> Worker Agent 3 (via fork_agent MCP tool)
```

### How The Supervisor Gets Triggered

The supervisor agent sits in its terminal waiting for input. The dashboard is responsible for waking it:

1. `StatusMonitor` detects a supervised work agent's status changed (idle, crashed, waiting, context threshold)
2. Dashboard constructs a **Layer 1 event payload** — a small structured text message (~200 tokens)
3. Dashboard calls `sendInput(supervisorAgentId, eventPayload)` — the supervisor receives it as if a user typed it
4. Supervisor reads the payload, decides what to do, calls MCP tools to act
5. Supervisor goes back to waiting for the next event

This means the supervisor has **near-zero cost when nothing is happening**. It only consumes tokens when the dashboard pushes an event to it.

### MCP Tools: The Supervisor's Capabilities

The supervisor cannot call dashboard functions directly — it's a Claude Code process running in a PTY. Instead, it gets **MCP tools** that bridge to the dashboard's existing methods. The MCP server runs in the dashboard's main process and has direct access to the supervisor, database, and knowledge graph.

```typescript
// MCP tools exposed to the supervisor agent

// === Agent Inspection ===
list_agents()
  // Returns: all agents with status, workspace, context usage
  // Backed by: supervisor.getAgents() (exists)

get_agent_last_output(agentId, lines?)
  // Returns: tail of agent's terminal log
  // Backed by: supervisor.getLog(agentId, lines) (exists)

get_context_digest(agentId)
  // Returns: structured AgentContextDigest (task, timeline, files, key responses)
  // Backed by: digestBuilder.build(agentId) (Phase 1 deliverable)

get_digest_entries(agentId, sinceId)
  // Returns: incremental digest entries since last check
  // Backed by: digestStore.getEntries(agentId, sinceId) (Phase 1 deliverable)

// === Agent Communication ===
send_message_to_agent(agentId, message)
  // Sends message as user input to an idle/waiting agent
  // Safety: rejects if agent status is 'working' or 'launching'
  // Backed by: supervisor.sendInput(agentId, message) (exists)

// === Agent Lifecycle ===
launch_agent(workspaceId, config)
  // Spawns a new work agent (for phase handoffs, sub-tasks)
  // Backed by: supervisor.launchAgent(input) (exists)

fork_agent(agentId)
  // Forks an agent's session to fresh context
  // Backed by: supervisor.forkAgent(agentId) (exists)

stop_agent(agentId)
  // Stops a work agent
  // Backed by: supervisor.stopAgent(agentId) (exists)

// === Knowledge Graph (when KG is implemented) ===
query_knowledge_graph(query)
  // Query file relationships, hotspots, co-modification clusters
  // Backed by: knowledgeGraph.query() (KG Phase 1+)

get_impact_radius(filePath)
  // What files are affected if this file changes
  // Backed by: knowledgeGraph.getImpactRadius() (KG Phase 1+)

get_conflict_risks()
  // Are any agents working on coupled files simultaneously
  // Backed by: knowledgeGraph.getConflictRisks() (KG Phase 2+)

// === Escalation ===
notify_user(message, urgency)
  // Send notification via Telegram/Discord
  // Backed by: notificationBridge.send() (Phase 7 deliverable)
```

Every MCP tool handler calls methods that **already exist** in the dashboard (or will be built as part of the Context Digest in Phase 1). The MCP server is a thin bridge, not new logic.

### Communication Safety: Status Gate

The `send_message_to_agent` tool includes a safety gate:

1. Checks `agent.status` — **rejects** if the agent is `working` or `launching` (injecting input mid-turn can corrupt the agent's conversation flow)
2. Only sends when the agent is `idle`, `waiting`, or `done`
3. Logs the interaction (supervisor → agent message) for audit trail
4. Returns confirmation or rejection reason to the supervisor

This prevents the supervisor from accidentally breaking a busy agent. The supervisor can only talk to agents that are waiting for input.

### Alternative: Direct API Supervisor

Research validated a second viable architecture: using the Anthropic API directly (`@anthropic-ai/sdk`) to run the supervisor as an in-process agentic loop rather than a Claude Code agent. Trade-offs:

| | Agent Card (Primary) | Direct API (Alternative) |
|---|---|---|
| New code needed | MCP server for tools | Agentic loop, tool dispatch, state management |
| Runs in | Its own PTY (like any agent) | Electron main process |
| UI | Uses existing AgentCard | Needs custom supervisor panel |
| Cost control | Less — Claude Code manages API calls | Full (batching, caching, model selection) |
| State management | Claude Code's session persistence | External JSON file |
| Observability | Free — it's just another agent | You build it |
| Communication to agents | MCP tool → IPC → sendInput() | Direct sendInput() call |
| Monthly cost (500 events/day) | ~$7-34 depending on model | ~$7 with batched Haiku + caching |

The agent card approach is recommended because it reuses existing infrastructure and is conceptually simpler. The direct API approach is the fallback if the agent card model hits limitations (e.g., Claude Code overhead per event is too high, or MCP tool latency is unacceptable).

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

## Dashboard Requirements

The Supervisor interacts with workers **through MCP tools**, not direct API calls. The MCP server runs in the dashboard's main process and bridges tool calls to existing supervisor methods. Most of the underlying functionality already exists:

### Underlying Dashboard Methods (backing the MCP tools)

| Method | Status | MCP Tool It Backs |
|--------|--------|-------------------|
| `supervisor.getLog(agentId, lines)` | Exists | `get_agent_last_output` |
| `supervisor.sendInput(agentId, text)` | Exists | `send_message_to_agent` |
| `supervisor.getContextStats(agentId)` | Exists | Included in `list_agents` response |
| `supervisor.launchAgent(input)` | Exists | `launch_agent` |
| `supervisor.forkAgent(agentId)` | Exists | `fork_agent` |
| `supervisor.stopAgent(agentId)` | Exists | `stop_agent` |
| `supervisor.getAgents()` | Exists | `list_agents` |
| `digestBuilder.build(agentId)` | Phase 1 | `get_context_digest` |
| `digestStore.getEntries(agentId, sinceId)` | Phase 1 | `get_digest_entries` |
| `knowledgeGraph.query(...)` | KG Phase 1+ | `query_knowledge_graph` |
| `notificationBridge.send(...)` | Phase 7 | `notify_user` |

### New Infrastructure Needed

| Component | Purpose |
|-----------|---------|
| MCP Server for supervisor | Hosts all supervisor tools, runs in main process |
| `supervised` flag on agent config | Opt-in per agent, stored in DB |
| Event payload builder | Constructs Layer 1 payloads when supervised agents change status |
| Status change → sendInput bridge | Wires StatusMonitor events to supervisor agent's terminal |
| Digest builder + store | Phase 1 deliverable — structured JSONL extraction |

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
Supervised work agent status changes (idle, crashed, waiting, context threshold)
  → Dashboard StatusMonitor detects (polls every 2.5s — already exists)
  → Dashboard builds Layer 1 event payload (tiny, ~200 tokens)
  → Dashboard calls sendInput(supervisorAgentId, payload)
  → Supervisor agent receives it as terminal input
  → Supervisor reads payload, decides:
     ├─ ROUTINE → MCP tool: send_message_to_agent(workerId, "yes"), done
     ├─ NEED MORE CONTEXT → MCP tool: get_context_digest(workerId), then decide
     ├─ NEED RAW DETAILS → MCP tool: get_agent_last_output(workerId, 100), then decide
     ├─ NEED STRUCTURAL CONTEXT → MCP tool: query_knowledge_graph(...), then decide
     └─ NEED HUMAN → MCP tool: notify_user(message, urgency)
```

The Supervisor is **not polling**. It's a Claude Code process sitting in its terminal, asleep until the dashboard sends it input. The dashboard is the only thing that polls (agent status every 2.5s, context stats every 5s — both already implemented). The MCP server runs in the dashboard's main process, so MCP tool calls from the supervisor execute with direct access to the supervisor, database, and knowledge graph.

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

### Phase 3: Supervisor Foundation — MCP Server + Agent Card ✅ COMPLETE
*Now that the data layer is solid, build the supervisor itself as an agent card with MCP tools.*

- ~~Add `supervised` flag to agent configuration UI (toggle on AgentCard)~~ → Deferred; supervisor works without per-agent opt-in for now
- ✅ Build the **MCP server** that exposes supervisor tools (stdio server proxying to HTTP API)
  - ✅ `list_agents`, `read_agent_log`, `send_message_to_agent`, `get_context_stats` (backed by existing methods)
  - `get_context_digest`, `get_digest_entries` (awaiting Phase 1 digest builder)
  - ✅ Status gate on `send_message_to_agent` — reject if agent is working
- Wire **StatusMonitor → sendInput bridge**: when a supervised agent goes idle/crashed/waiting, build Layer 1 event payload and send it to the supervisor agent's terminal
- ✅ Create the Supervisor agent's system prompt — role definition, constraints, MCP tool usage
- ✅ Launch supervisor as a standard agent card with MCP server configured via `--mcp-config`
- ✅ Validate: supervisor connects to MCP, can list agents, read logs, send messages

### Phase 4: Core Autonomy (NEXT)
- Implement Tier 1 behaviors (routine approval, rate limit handling) via supervisor prompt refinement
- Wire StatusMonitor → sendInput bridge for event-driven triggering
- Context threshold monitoring — dashboard sends events when agents cross configurable thresholds
- Basic crash recovery intelligence — supervisor reads error output via MCP tools, decides retry vs escalate
- ✅ `launch_agent` and `fork_agent` MCP tools already implemented

### Phase 5: Context Management
- Automated context compaction and agent forking via MCP tools
- Worker summary extraction for handoffs (supervisor calls `get_context_digest` then `launch_agent` with compacted context)
- Cost tracking for Supervisor token usage (same context stats infrastructure as any agent)

### Phase 6: Knowledge Graph Integration
- Add KG query MCP tools to the supervisor's MCP server (`query_knowledge_graph`, `get_impact_radius`, `get_conflict_risks`)
- Supervisor uses KG for structural awareness: co-modification clusters, blast radius, coupled files
- Temporal queries: supervisor distinguishes concurrent conflicts from sequential continuation
- Anomaly detection: supervisor spots agents modifying one file in a co-modification cluster but not the others

### Phase 7: Deep Assistance + Notifications
- Supervisor requests dashboard to spawn sub-agents for complex decisions (via `launch_agent` MCP tool)
- Deep research integration — supervisor can trigger research agents
- Tier 2 → Tier 3 escalation logic with confidence thresholds
- `notify_user` MCP tool — Telegram/Discord bidirectional messaging
- User reply → dashboard relays to supervisor → supervisor relays to worker
- Quiet hours and notification batching
- Mobile-friendly status summaries
