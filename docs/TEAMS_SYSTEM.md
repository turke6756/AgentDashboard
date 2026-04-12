# Teams System — Technical Reference & Supervisor Guide

## What Was Built

The Teams system adds a **supervisor-defined, channel-enforced inter-agent communication layer** to AgentDashboard. It replaces the manual relay pattern (supervisor reads log, pastes into another agent) with direct peer-to-peer messaging between agents, controlled entirely by the supervisor.

### The Core Idea

The supervisor is an **architect**, not a **postman**. It creates teams, defines who can talk to whom, sets up shared task boards, and then steps back. Agents coordinate directly within those boundaries. The supervisor monitors for exceptions (loops, crashes, escalations) and intervenes only when needed.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  DASHBOARD (Electron Main Process)                       │
│                                                          │
│  ┌─────────────────┐  ┌───────────────────────────────┐  │
│  │   API Server     │  │  Message Delivery Engine      │  │
│  │   :24678         │  │  (team-delivery.ts)           │  │
│  │                  │  │                               │  │
│  │  Channel         │  │  On agent idle → deliver      │  │
│  │  enforcement     │  │  pending messages via stdin   │  │
│  │                  │  │                               │  │
│  │  Loop detection  │  │  10s polling fallback         │  │
│  │  (3 tiers)       │  │  2s batch delay               │  │
│  └──────┬───────────┘  └──────────────────────────────┘  │
│         │                                                │
│  ┌──────┴───────────────────────────────────────────┐    │
│  │  SQLite Database                                  │    │
│  │  teams │ team_members │ team_channels             │    │
│  │  team_messages │ team_tasks                       │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
         │ HTTP                    │ HTTP
         ▼                        ▼
┌─────────────────┐    ┌──────────────────┐
│ mcp-supervisor.js│    │  mcp-team.js     │
│ (supervisor only)│    │  (team members)  │
│ 22 tools         │    │  6 tools         │
└────────┬────────┘    └────────┬─────────┘
         │ stdio                │ stdio
         ▼                     ▼
┌─────────────────┐    ┌──────────────────┐
│ Supervisor Agent │    │ Worker Agents    │
│ (Claude)         │    │ (Any provider)   │
│                  │    │ Claude/Gemini/   │
│ Creates teams,   │    │ Codex            │
│ monitors, acts   │    │                  │
│ on exceptions    │    │ Use send_message │
│                  │    │ get_tasks, etc.  │
└──────────────────┘    └──────────────────┘
```

### Data Flow: Agent A Messages Agent B

```
1. Agent A calls send_message MCP tool
2. mcp-team.js → POST /api/teams/{teamId}/messages
3. API server checks:
   a. Channel exists from A → B? (team_channels table)
   b. Global rate < 50 msgs / 5 min? (tier 1 loop detection)
   c. Not repeating same content? (tier 2 low-content filter)
   d. Not ping-ponging with B? (tier 3 alternation detection)
4. Message saved to team_messages table (delivered_at = NULL)
5. teamMessageCreated event → UI updates in real-time
6. Delivery engine detects B is idle (or polls every 10s)
7. Formats message as [TEAM MESSAGE from "A" in "Team"]
8. Delivers to B's stdin via supervisor.sendInput()
9. Marks message delivered in DB
```

---

## Database Schema

Five new tables:

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `teams` | Team definitions | id, workspace_id, name, description, template, status, manifest |
| `team_members` | Who's on each team | team_id, agent_id, role |
| `team_channels` | Allowed communication edges | team_id, from_agent, to_agent (UNIQUE) |
| `team_messages` | Persistent message history | from_agent, to_agent, subject, status, summary, detail, need, delivered_at |
| `team_tasks` | Shared task boards | team_id, title, status, assigned_to, blocked_by, notes |

---

## API Endpoints

### Team CRUD
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams` | Create team with members + channels |
| GET | `/api/teams?workspaceId=X` | List teams |
| GET | `/api/teams/:id` | Get team (members, channels, messages, tasks) |
| DELETE | `/api/teams/:id` | Disband (saves manifest for resurrection) |

### Members & Channels
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams/:id/members` | Add member |
| DELETE | `/api/teams/:id/members/:agentId` | Remove member (cleans up channels) |
| POST | `/api/teams/:id/channels` | Add directed channel |
| DELETE | `/api/teams/:id/channels/:channelId` | Remove channel |

### Messaging
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams/:id/messages` | Send message (enforces channels + loop detection) |
| GET | `/api/teams/:id/messages?agentId=X` | Get messages |

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams/:id/tasks` | Create task |
| PATCH | `/api/teams/:id/tasks/:taskId` | Update task status/notes |
| GET | `/api/teams/:id/tasks` | List tasks |

### Resurrection
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/teams/:id/resurrect` | Relaunch agents, remap IDs, restore channels/tasks |

---

## MCP Servers

### mcp-supervisor.js (Supervisor Only)

The supervisor gets 9 team management tools in addition to its existing agent management tools:

| Tool | What It Does |
|------|-------------|
| `create_team` | Create team with template (groupthink/pipeline/custom), members, channels |
| `disband_team` | Archive team, save manifest |
| `add_team_member` | Add agent to team (triggers MCP injection) |
| `remove_team_member` | Remove agent, clean up their channels |
| `add_channel` | Add directed communication edge |
| `remove_channel` | Remove communication edge |
| `get_team` | Full team state: members, channels, messages, tasks |
| `list_teams` | List all teams in workspace |
| `resurrect_team` | Relaunch a disbanded team from manifest |

### mcp-team.js (Team Members — All Providers)

Every agent in a team gets this MCP server, regardless of provider (Claude, Gemini, Codex). It's injected via `.mcp.json` in their workspace directory.

| Tool | What It Does |
|------|-------------|
| `send_message` | Send structured message to a teammate (channel-enforced) |
| `get_messages` | Check inbox |
| `get_tasks` | View shared task board |
| `update_task` | Update task status, assignee, notes |
| `create_task` | Create new task |
| `get_team_info` | See team members, roles, who you can message |

**Environment variables** set by the dashboard at launch:
- `AGENT_ID` — this agent's ID
- `TEAM_ID` — the team
- `AGENT_DASHBOARD_API_PORT` / `AGENT_DASHBOARD_API_HOST`

---

## Channel Enforcement & Loop Detection

### Channel Enforcement

Every `send_message` call hits `POST /api/teams/:id/messages`. The API checks:

```
SELECT * FROM team_channels
WHERE team_id = ? AND from_agent = ? AND to_agent = ?
```

If no row exists → **403 Forbidden**. The agent gets back: "No channel from {you} to {them} in this team. Communication not authorized."

### Loop Detection (3 Tiers)

| Tier | What It Catches | Threshold | Response |
|------|----------------|-----------|----------|
| 1. Global cap | Runaway messaging | 50 msgs / 5 min per team | 429 — all messaging paused |
| 2. Low-content filter | "Acknowledged" / "Standing by" ping-pong | 3 identical hashes in a row | 429 — sender blocked |
| 3. Pair alternation | A→B→A→B→... with no progress | 6 alternations in 12 messages | 429 — pair blocked + supervisor notified |

---

## Message Delivery

Messages don't sit in a queue forever. The `TeamMessageDeliveryEngine` delivers them:

1. **On status change**: When an agent transitions to `idle` or `waiting`, check for pending messages
2. **Polling fallback**: Every 10 seconds, scan for idle agents with undelivered messages
3. **Batching**: Wait 2 seconds before delivering, to batch multiple pending messages into one stdin write

**Format delivered to agent stdin:**
```
[TEAM MESSAGE from "Frontend Agent" in "Auth Refactor"]
Subject: OAuth2 implementation ready
Status: complete
Summary: All 3 files changed, ready for testing
Detail: Modified auth.ts, oauth-handler.ts, and token-refresh.ts
Need: Run the integration test suite and report back
```

---

## Team Templates

| Template | Channel Topology | Use Case |
|----------|-----------------|----------|
| `groupthink` | All-to-all (every member ↔ every other member) | Deliberation, brainstorming, multi-model perspectives |
| `pipeline` | Linear chain (A↔B↔C) | Staged workflows: analysis → implementation → testing |
| `custom` | You define each directed edge | Asymmetric communication, hub-and-spoke, etc. |

---

## Team Resurrection

When a team is disbanded, its full state is saved as a JSON manifest in the `teams.manifest` column:

```json
{
  "version": 1,
  "members": [
    {
      "agentId": "abc123",
      "title": "Frontend Agent",
      "provider": "claude",
      "roleDescription": "Implements UI components",
      "workingDirectory": "/projects/app",
      "command": "claude --dangerously-skip-permissions",
      "resumeSessionId": "sess_xyz",
      "role": "implementer"
    }
  ],
  "channels": [
    { "fromAgent": "abc123", "toAgent": "def456", "label": null }
  ],
  "tasks": [
    { "title": "Build login form", "description": "", "status": "done", "assignedTo": "abc123" }
  ],
  "recentMessages": [ /* last 20 messages */ ]
}
```

**Resurrection flow** (`POST /api/teams/:id/resurrect`):

1. Read manifest from DB
2. For each member: `supervisor.launchAgent()` with same title/provider/workDir/command
3. Build ID mapping (old agent ID → new agent ID)
4. Remove old members/channels, create new ones with remapped IDs
5. Re-create tasks with remapped assignees
6. Inject team MCP config into each new agent's workspace
7. For non-Claude agents: send rehydration prompt with team context, task board, recent messages

**Provider differences:**
- **Claude**: Can resume via `--resume <sessionId>` (full context continuity)
- **Gemini/Codex**: Get a rehydration prompt with team purpose, task board state, and recent message history

---

## Provider-Agnostic MCP Injection

The same `mcp-team.js` script works for all providers. MCP config is injected by writing to `.mcp.json` in the agent's workspace:

```json
{
  "mcpServers": {
    "agent-dashboard-team": {
      "command": "node",
      "args": ["/path/to/scripts/mcp-team.js"],
      "env": {
        "AGENT_ID": "abc123",
        "TEAM_ID": "team-xyz",
        "AGENT_DASHBOARD_API_PORT": "24678"
      }
    }
  }
}
```

The dashboard merges this entry into existing `.mcp.json` content (preserving other MCP servers like the supervisor's `agent-dashboard` server).

For WSL agents, the script path is converted to `/mnt/c/...` and `AGENT_DASHBOARD_API_HOST` is set to the Windows host IP from `/etc/resolv.conf`.

---

## UI Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `TeamDialog` | `src/renderer/components/team/TeamDialog.tsx` | Create team modal (name, template, members, channels) |
| `TeamPanel` | `TeamPanel.tsx` | Team detail view with Graph/Messages/Tasks tabs |
| `TeamGraph` | `TeamGraph.tsx` | SVG communication graph (nodes=agents, edges=channels) |
| `TeamMessageFlow` | `TeamMessageFlow.tsx` | Chronological message list with status badges |
| `TeamTaskBoard` | `TeamTaskBoard.tsx` | Kanban-style task columns (todo/in_progress/done/blocked) |
| `TeamList` | `TeamList.tsx` | Sidebar team list with status indicators |

Entry points:
- **AgentCard** context menu → "Create Team" opens TeamDialog
- **App.tsx** subscribes to `onTeamUpdated` and `onTeamMessageCreated` events

---

## Supervisor Awareness

The supervisor's system prompt (`SUPERVISOR_AGENT_MD` in `src/shared/constants.ts`) already contains the full Teams section. When you ask the supervisor to "create a team" or "set up a pipeline," it knows:

- What templates are available (groupthink, pipeline, custom)
- How to brief agents after team creation
- That it should monitor via `get_team` not relay messages
- How loop detection works and what to do when it triggers
- The full workflow: create → brief → monitor → intervene on exception → disband

**What the supervisor understands today:**
- All 9 team management MCP tools and their parameters
- The concept of channel-enforced direct communication
- Templates and when to use each
- The briefing protocol (send_message_to_agent to each member after team creation)
- Loop detection and how to respond to `[TEAM EVENT]` notifications

---

## What the Supervisor Prompt Says (Relevant Section)

The supervisor receives this instruction in its system prompt:

> You can create teams of agents that communicate directly with each other via MCP tools. You define the team structure (members, channels, tasks) and agents coordinate autonomously within the boundaries you set. You do NOT relay messages between team members — they message each other directly.

Followed by the full tool listing, template descriptions, workflow steps, and loop detection guidance.

---

## Next Steps

### 1. Supervisor Skills System

The supervisor prompt currently embeds team instructions inline. A better approach is a **skill-based system** where the supervisor loads context-specific prompts on demand:

**Proposed skills** (`.claude/agents/supervisor/skills/`):

- **`team-building.md`** — When to create teams, how to choose templates, best practices for channel topology, briefing agents effectively, monitoring cadence
- **`groupthink.md`** — How to run a deliberation session: briefing agents with the question, cross-pollination protocol, convergence detection, synthesis format
- **`pipeline.md`** — Setting up staged workflows, defining handoff conventions, using `.handoff/` for artifact exchange
- **`team-triage.md`** — How to handle loop detection events, stuck agents, team rebalancing, when to modify channels mid-flight

The supervisor prompt would reference these:

```markdown
## Skills

Load a skill when you need detailed guidance for a specific operation:

- Read `.claude/agents/supervisor/skills/team-building.md` before creating a team
- Read `.claude/agents/supervisor/skills/groupthink.md` before running a deliberation
- Read `.claude/agents/supervisor/skills/pipeline.md` for staged workflows
- Read `.claude/agents/supervisor/skills/team-triage.md` when handling team exceptions
```

### 2. Shared Handoff Directory Convention

Agents in a team should exchange artifacts (analysis docs, plans, test reports) through a shared directory rather than stuffing them into messages:

- `<workspace>/.handoff/` — shared workspace for team artifacts
- Messages carry lightweight references: "see `.handoff/auth-audit.md`"
- Handoff files survive agent crashes and team resurrection

### 3. Team Event Integration with Supervisor Event Bridge

Currently the supervisor event bridge handles `status_change`, `context_threshold`, and `groupthink_start`. The team system adds `team_created` and `team_loop_detected` event types in the payload builder, but the supervisor doesn't emit these events through the bridge yet. Wire them up:

- When a team is created → notify supervisor via event bridge
- When loop detection triggers → notify supervisor via event bridge (currently returns 429 to the agent but doesn't alert the supervisor)

### 4. Dashboard UI Integration

The team components exist but aren't fully wired into the main layout:

- **TeamList** needs to be added to the sidebar
- **TeamPanel** needs to be added to the detail panel routing
- Team membership badges on AgentCards (show which team an agent belongs to)
- Real-time message flow animation on the TeamGraph (edges light up on message send)

### 5. GroupThink Migration

GroupThink is architecturally subsumed by Teams (it's just `template: 'groupthink'`). The migration path:

1. Keep existing GroupThink API endpoints as thin wrappers → team API with `template='groupthink'`
2. Migrate GroupThink DB rows to team tables
3. Update GroupThinkDialog to be a preset in TeamDialog
4. Eventually remove separate GroupThink code paths

### 6. Agent Discovery by Capability

Currently the supervisor finds agents by listing all agents. Add capability-based discovery:

```
Supervisor: "I need an agent working in /src/renderer — who's available?"
→ discover_agents(workingDirectory: "/src/renderer", status: "idle")
→ Returns agents already in that directory with existing context
```

This prevents launching fresh agents when one with relevant context already exists.

### 7. Rate Limit Awareness & Token Budget Management

Agentic teams burn tokens fast. A 5-agent team with all-to-all channels can chew through a daily API budget in hours if left unchecked. The supervisor needs the ability to **monitor spend, throttle communication, and optimize for usage limits** — especially when the work can run overnight and speed doesn't matter.

#### The Problem

- Each agent turn costs input + output tokens. Inter-agent messages trigger new turns.
- A team of 5 agents doing rapid-fire coordination can easily generate 50+ turns per minute across the team.
- API providers (Anthropic, Google, OpenAI) enforce rate limits: requests per minute (RPM), tokens per minute (TPM), and daily budget caps.
- If agents hit rate limits, they stall or crash. If they burn the daily budget by noon, the human has no capacity left for their own work.
- The supervisor already monitors context window usage per agent (`get_context_stats`). It needs equivalent visibility into **team-wide token spend and rate limit headroom**.

#### What to Build

**A. Dashboard-level usage tracking**

The `ContextStatsMonitor` already reads each agent's JSONL session files and extracts token counts. Extend this to aggregate at the team level:

- **Team token dashboard**: Total input/output tokens consumed by all team members since team creation
- **Burn rate**: Tokens per minute across the team (rolling 5-minute window)
- **Projected daily spend**: At current burn rate, when will the daily budget be exhausted?
- **Per-agent breakdown**: Which agent is consuming the most? (Often one agent in a pipeline dominates)

New DB table or in-memory tracking:
```
team_usage (
  team_id, agent_id, window_start,
  input_tokens, output_tokens, turns, messages_sent
)
```

New API endpoint:
```
GET /api/teams/:id/usage → { totalTokens, burnRate, projectedExhaustion, perAgent: [...] }
```

New MCP tool for supervisor:
```
get_team_usage(team_id) → token spend summary, burn rate, projection
```

**B. Throttle controls — supervisor-managed communication speed**

The supervisor should be able to set a **pace** for team communication. This isn't the loop detection system (which catches pathological patterns) — it's deliberate speed control.

Three throttle modes:

| Mode | Delivery Delay | Use Case |
|------|---------------|----------|
| `fast` | 2s (current default) | Time-sensitive work, human is watching |
| `normal` | 30s | Default pace, balances throughput and cost |
| `slow` | 5min | Overnight/background work, budget conservation |

Implementation: The `TeamMessageDeliveryEngine` already has `TEAM_MESSAGE_BATCH_DELAY_MS`. Make this configurable per-team:

```
POST /api/teams/:id/throttle { mode: 'fast' | 'normal' | 'slow' }
```

New MCP tool:
```
set_team_pace(team_id, mode) — Control how fast messages are delivered between agents
```

The supervisor prompt should teach it to reason about pace:

```markdown
### Pacing

Use `set_team_pace` to control communication speed based on urgency and budget:
- **fast**: Human is waiting, deadline pressure. Burns tokens quickly.
- **normal**: Standard work. Good balance of progress and cost.
- **slow**: Background/overnight work. Agents still coordinate, just with minutes between messages instead of seconds.

Check `get_team_usage` periodically. If burn rate will exhaust the daily budget before the work is done, slow down. If the team is idle most of the time, speed up.
```

**C. Automatic compaction triggers tied to team budgets**

The supervisor already knows how to compact agents (read log → summarize → launch fresh agent → stop old one). Tie this to team-level budget awareness:

- When a team member crosses 80% context, the supervisor compacts them (existing behavior via `[DASHBOARD EVENT] Context threshold crossed`)
- New: When a team member's **cumulative token spend** exceeds a threshold (e.g., 500K tokens), proactively compact even if context window isn't full — the agent is getting expensive to run because of cache misses on long conversations
- New: When the **team's projected daily spend** exceeds a configurable budget, the supervisor should:
  1. Switch to `slow` pace
  2. Compact the highest-spending agent
  3. Consider pausing non-critical team members
  4. Notify the human: "Team auth-refactor is on track to use 2M tokens today. I've slowed communication. Want me to pause?"

**D. Budget configuration**

Let the human (or supervisor) set a daily token budget per workspace or per team:

```
POST /api/teams/:id/budget { dailyTokenLimit: 1_000_000 }
```

When the team approaches the budget:
- At 70%: Supervisor notified, considers slowing pace
- At 90%: Auto-switch to `slow` mode
- At 100%: Message delivery paused, supervisor notified, human alerted

This gives the human a hard ceiling. "I'm fine burning 1M tokens on this overnight, but no more."

**E. UI: Team Usage Panel**

Add to the TeamPanel a "Usage" tab alongside Graph/Messages/Tasks:

- Burn rate gauge (tokens/min)
- Daily spend bar (current vs budget)
- Per-agent token breakdown (bar chart)
- Pace indicator (fast/normal/slow) with manual override
- Projected exhaustion time

#### Supervisor Skill: `budget-management.md`

```markdown
# Budget Management

## When to Check
- After creating a team
- Every 10-15 minutes during active team work
- When you receive a context threshold event
- When a human mentions budget or cost concerns

## How to Check
1. Call `get_team_usage(team_id)` to see burn rate and projection
2. Call `get_context_stats(agent_id)` for each high-spend agent

## Decision Framework
- **Burn rate < 50K tokens/min**: Normal. No action needed.
- **Burn rate 50-200K tokens/min**: High. Check if agents are making progress or spinning. Consider `set_team_pace(team_id, 'normal')`.
- **Burn rate > 200K tokens/min**: Very high. Agents are in rapid-fire mode. Switch to `set_team_pace(team_id, 'slow')` unless human explicitly wants speed.
- **Projected daily spend > budget**: Slow pace immediately. Compact the top-spending agent. Notify human.
- **Agent at 80%+ context AND high cumulative spend**: Compact immediately — long contexts are expensive (cache misses).

## Overnight Runs
When the human says "this can run overnight" or "no rush":
1. Set pace to `slow`
2. Set a conservative daily budget
3. Let agents work at their own pace — they'll still coordinate, just with 5-minute gaps between messages instead of 2-second gaps
4. Check in periodically via `get_team_usage` and adjust

## Compaction for Cost
Standard compaction preserves continuity when context is full. Budget compaction is different:
- Trigger: Agent has spent 500K+ cumulative tokens, even if context window isn't full
- The agent's conversation is getting long and expensive (input tokens grow every turn)
- Compact early to reset the cost curve: fresh context = smaller input = cheaper turns
```

#### Why This Matters

Without budget controls, teams are a **spend amplifier**. Five agents sending messages means five agents burning turns. The supervisor already has the authority to compact and manage agents — extending that authority to pace control and budget awareness turns it from a reactive babysitter into a **resource-aware orchestrator**.

The key insight: **the supervisor is the only entity with visibility across all agents**. Individual agents don't know what other agents are spending. The supervisor can see the whole picture and make team-wide optimization decisions that no single agent could make on its own.
