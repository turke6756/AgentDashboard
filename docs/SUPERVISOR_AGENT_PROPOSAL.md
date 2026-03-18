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

## Implementation Path

### Phase 1: Foundation
- Add `supervised` flag to agent configuration
- Add `onAgentStatusChange` event subscription to daemon API
- Build notification bridge (Telegram webhook — ~100 lines)
- Create the Supervisor agent's base CLAUDE.md

### Phase 2: Core Autonomy
- Implement Tier 1 behaviors (routine approval, rate limit handling)
- Context threshold monitoring and alerts
- Basic crash recovery intelligence

### Phase 3: Context Management
- Automated context compaction and agent forking
- Worker summary extraction for handoffs
- Cost tracking for Supervisor token usage

### Phase 4: Deep Assistance
- Sub-agent spawning for complex decisions
- Deep research integration
- Tier 2 → Tier 3 escalation logic with confidence thresholds

### Phase 5: Notification and Remote Control
- Telegram/Discord bidirectional messaging
- User reply → agent input pipeline
- Quiet hours and notification batching
- Mobile-friendly status summaries
