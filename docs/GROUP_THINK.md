# Group Think

Multi-agent deliberation system orchestrated by the supervisor. Two or more agents (any mix of Claude, Gemini, Codex) independently explore a topic, share findings across rounds, and converge on a synthesis report.

## Motivation

Different models catch different things. Manually cross-pollinating responses between Claude Code, Gemini CLI, and Codex by copy-pasting is effective but tedious. The supervisor already has all the tooling needed to automate this — `read_agent_log`, `send_message_to_agent`, `launch_agent`, and status change events. Group Think formalizes this into a protocol.

## Architecture

```
User selects agents → UI creates session → Dashboard notifies supervisor
                                              ↓
                              Supervisor briefs each agent via send_message_to_agent
                                              ↓
                              Agents explore codebase independently (working → idle)
                                              ↓
                              Existing event bridge fires idle notifications to supervisor
                                              ↓
                              Supervisor checks get_groupthink_status (all idle?)
                                              ↓
                              Reads each agent's log, cross-pollinates to others
                                              ↓
                              Repeats for N rounds → synthesizes final report
```

**Core design decision:** Orchestration is prompt-driven, not state-machine-driven. The supervisor is a Claude agent with MCP tools — it handles the judgment calls (when to do another round, how to summarize). The dashboard only provides session tracking and tools.

## Starting a Session

### From the UI
1. Right-click any active agent → **Start Group Think**
2. Dialog opens with the clicked agent pre-selected
3. Enter a topic/question, select 2+ agents, set max rounds (1–5, default 3)
4. Click **Start Group Think**

### From the Supervisor (self-initiated)
The supervisor can call the `start_groupthink` MCP tool when it judges a complex decision would benefit from multiple perspectives.

## Supervisor Protocol

The supervisor prompt includes these instructions:

1. **Brief agents** — Send each member the topic, tell them they're in a group think with N others, ask them to explore and go idle when done
2. **Wait for round** — After idle notifications, check `get_groupthink_status` to confirm ALL members are idle
3. **Cross-pollinate** — Read each agent's log, send each agent the OTHER agents' findings, ask them to refine
4. **Converge** — Assess after each round: converging → synthesize; productive disagreements → another round; hit max_rounds → synthesize regardless
5. **Synthesize** — Write a structured report (Consensus, Tensions, Recommendations), call `complete_groupthink`
6. **Post-synthesis** — Optionally delegate tasks to group agents or launch new ones

## MCP Tools

| Tool | Description |
|------|-------------|
| `start_groupthink` | Create a session and enroll agents (params: workspace_id, topic, agent_ids, max_rounds) |
| `get_groupthink_status` | Get session state + per-member agent status |
| `advance_groupthink_round` | Increment round counter after cross-pollination |
| `complete_groupthink` | Mark session completed with synthesis report |

These are backed by HTTP API routes at `/api/groupthink/*` that the MCP server calls via curl.

## Data Model

### Tables

**`groupthink_sessions`**
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| workspace_id | TEXT | Workspace scope |
| topic | TEXT | The deliberation question |
| status | TEXT | `active` / `synthesizing` / `completed` / `cancelled` |
| round_count | INTEGER | Current round (starts at 0) |
| max_rounds | INTEGER | Max rounds before forced synthesis |
| synthesis | TEXT | Final report (null until completed) |
| created_at | TEXT | Timestamp |
| updated_at | TEXT | Timestamp |

**`groupthink_members`** (join table)
| Column | Type | Description |
|--------|------|-------------|
| session_id | TEXT | FK to session |
| agent_id | TEXT | FK to agent |

No columns were added to the `agents` table — membership is tracked via the join table.

## UI

- **AgentCard badge** — Fuchsia "GT R1/3" pill when agent is in an active session, with topic on hover
- **Context menu** — "Start Group Think" item on non-supervisor, non-dead agents
- **GroupThinkDialog** — Topic textarea, agent picker with provider badges, max rounds slider
- **DetailPanel** — Group Think status section when viewing a member agent: topic, round progress, member list, synthesis text when complete

## Event Flow

1. UI or supervisor creates session → `POST /api/groupthink`
2. `notifyGroupThinkStart()` builds a `[DASHBOARD EVENT] Group Think session started` payload
3. Delivered to supervisor via existing `sendInput()` / `deliverToSupervisor()` pattern
4. Supervisor briefs agents; they work and go idle
5. Existing status change events notify supervisor of idle transitions
6. Supervisor reads logs, cross-pollinates, advances rounds via MCP tools
7. `complete_groupthink` stores synthesis, emits `groupThinkUpdated` event to renderer

## Files

| File | Role |
|------|------|
| `src/shared/types.ts` | `GroupThinkSession`, `GroupThinkStatus` types, `IpcApi` extensions |
| `src/shared/constants.ts` | Round limits, supervisor prompt with GT protocol |
| `src/main/database.ts` | Tables + CRUD functions |
| `src/main/api-server.ts` | 6 HTTP routes |
| `scripts/mcp-supervisor.js` | 4 MCP tool definitions + handlers |
| `src/main/supervisor/index.ts` | `notifyGroupThinkStart()` method |
| `src/main/supervisor/event-payload-builder.ts` | `groupthink_start` event type + formatter |
| `src/main/ipc-handlers.ts` | 4 IPC handlers + event forwarding |
| `src/preload/index.ts` | `groupthink.*` namespace + `onGroupThinkUpdated` |
| `src/renderer/stores/dashboard-store.ts` | State + actions |
| `src/renderer/components/agent/GroupThinkDialog.tsx` | Launch dialog |
| `src/renderer/components/agent/AgentCard.tsx` | Badge + context menu |
| `src/renderer/components/agent/AgentGrid.tsx` | Dialog wiring |
| `src/renderer/components/layout/DetailPanel.tsx` | Status section |
| `src/renderer/App.tsx` | Event listener |
