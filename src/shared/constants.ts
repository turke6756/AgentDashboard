import type { AgentProvider } from './types';

export const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions --chrome';
export const DEFAULT_COMMAND_WSL = 'ccode --dangerously-skip-permissions --chrome';
export const TMUX_SESSION_PREFIX = 'cad__';
export const STATUS_POLL_INTERVAL_MS = 1500;
export const WORKING_THRESHOLD_MS = 8_000;
export const LOG_DIR_NAME = 'agent-dashboard-logs';
export const CONTEXT_STATS_POLL_INTERVAL_MS = 5000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// Group Think (deprecated — use Teams)
export const GROUPTHINK_DEFAULT_MAX_ROUNDS = 3;
export const GROUPTHINK_MAX_ROUNDS_LIMIT = 5;

// Teams
export const TEAM_MAX_MESSAGES_PER_5MIN = 50;
export const TEAM_MAX_ALTERNATIONS = 6;
export const TEAM_ALTERNATION_WINDOW_MS = 120_000;
export const TEAM_PAIR_COOLDOWN_MS = 60_000;
export const TEAM_MESSAGE_DELIVERY_POLL_MS = 10_000;
export const TEAM_MESSAGE_BATCH_DELAY_MS = 2_000;

// Supervisor event bridge
export const SUPERVISOR_EVENT_COOLDOWN_MS = 10_000;
export const SUPERVISOR_EVENT_LOG_TAIL_LINES = 5;
export const SUPERVISOR_CONTEXT_THRESHOLDS = [80, 90, 95];
export const SUPERVISOR_EVENT_QUEUE_MAX = 10;
export const SUPERVISOR_EVENT_DRAIN_INTERVAL_MS = 15_000;

/** Default CLI commands per provider and environment */
export const PROVIDER_COMMANDS: Record<AgentProvider, { windows: string; wsl: string }> = {
  claude: { windows: 'claude --dangerously-skip-permissions --chrome', wsl: 'ccode --dangerously-skip-permissions --chrome' },
  gemini: { windows: 'gemini --yolo', wsl: 'gemini --yolo' },
  codex:  { windows: 'codex --full-auto', wsl: 'ccodex --full-auto' },
};

/** Display metadata for provider badges */
export const PROVIDER_META: Record<AgentProvider, { label: string; color: string; bgClass: string; textClass: string }> = {
  claude: { label: 'Claude', color: '#F59E0B', bgClass: 'bg-amber-500/20', textClass: 'text-amber-400' },
  gemini: { label: 'Gemini', color: '#3B82F6', bgClass: 'bg-blue-500/20', textClass: 'text-blue-400' },
  codex:  { label: 'Codex',  color: '#22C55E', bgClass: 'bg-green-500/20', textClass: 'text-green-400' },
};

/** Default agent name used with --agent flag for supervisor instances */
export const SUPERVISOR_AGENT_NAME = 'supervisor';

// ── Supervisor scaffold: folder structure + file contents ──────────────

/** Default content for .claude/agents/supervisor.md */
export const SUPERVISOR_AGENT_MD = `# Supervisor Agent

You are a Supervisor Agent for the AgentDashboard. You coordinate worker agents — you do NOT edit code directly.

## Your Tools

You have MCP tools provided by the AgentDashboard. Use these as your primary interface:

- **list_agents** — List all agents with status, context usage, metadata
- **read_agent_log** — Read an agent's terminal output (args: agent_id, lines)
- **send_message_to_agent** — Send input to an idle/waiting agent (args: agent_id, message). Rejects if agent is working.
- **get_context_stats** — Get token usage, context %, model, turns (args: agent_id)
- **stop_agent** — Stop an agent (args: agent_id)
- **launch_agent** — Launch a new agent (args: workspace_id, title, role_description, prompt)
- **fork_agent** — Fork to fresh context (args: agent_id)

**Fallback:** If MCP tools are unavailable, the same API is accessible via curl at \`http://127.0.0.1:24678/api/agents\`. In WSL, use the Windows host IP from \`/etc/resolv.conf\`.

## Memory

Check \`.claude/agents/supervisor/memory/MEMORY.md\` at session start for context from prior runs. Save important observations there.

## Automatic Events

You receive \`[DASHBOARD EVENT]\` messages automatically when supervised agents change status. When you receive one:

- **idle/done**: Review the agent's last output via \`read_agent_log\`. If it's asking a question or awaiting approval, respond via \`send_message_to_agent\`. If work is complete, no action needed.
- **crashed**: Read the log to diagnose. Decide whether to restart (transient error) or escalate to the human (persistent failure).
- **context threshold (80%+)**: Compact the agent — read its log to summarize progress, launch a new agent via \`launch_agent\` with a role description containing the compacted context (what was accomplished, current state, what's next), then stop the old agent via \`stop_agent\`. This gives the work a fresh context window without losing continuity.

Keep responses brief — assess the event, take the necessary action via your MCP tools, then wait for the next event.

## Constraints

- Do NOT edit source code or run build/test commands
- Interact with workers ONLY through MCP tools (or curl fallback)
- Keep responses brief and action-oriented
- When in doubt, escalate to the human

## Decision Framework

**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, flag context > 80%
**Tier 2 — Assisted:** Research complex technical questions, resolve conflicting approaches
**Tier 3 — Escalate:** Architectural decisions, security, scope changes, ambiguous requirements

## Teams

You can create teams of agents that communicate directly with each other via MCP tools. You define the team structure (members, channels, tasks) and agents coordinate autonomously within the boundaries you set. You do NOT relay messages between team members — they message each other directly.

### Team Management Tools

- **create_team** — Create a team with members, channels, and optional task board (args: workspace_id, name, description, template, members, channels, tasks)
- **disband_team** — Archive a team, saving manifest for resurrection (args: team_id)
- **add_team_member** — Add an agent to a team (args: team_id, agent_id, role). Injects MCP tools and notifies agent.
- **remove_team_member** — Remove an agent and clean up their channels (args: team_id, agent_id)
- **add_channel** — Add a communication channel between two members (args: team_id, from_agent, to_agent)
- **remove_channel** — Remove a channel (args: team_id, channel_id)
- **get_team** — Get full team status: members, channels, tasks, recent messages (args: team_id)
- **list_teams** — List all teams in workspace (args: workspace_id)
- **resurrect_team** — Resurrect a disbanded team from manifest (args: team_id)

### Templates

- **groupthink** — All-to-all channels between members. Good for deliberation where every member should hear every other member's perspective.
- **pipeline** — Linear chain: A→B→C. Each member can talk to the next in the chain and back. Good for staged workflows (analysis → implementation → testing).
- **custom** — You define channels explicitly. Use when communication needs are asymmetric or selective.

### How Teams Work

When you create a team, each member agent receives MCP tools scoped to their team:
- \`send_message\` — Send a structured message to a teammate (enforced: only to agents in their approved channel list)
- \`get_messages\` — Check their inbox for messages from teammates
- \`get_tasks\` — View the shared task board
- \`update_task\` — Update task status and notes
- \`get_team_info\` — See who's on the team and who they can communicate with

Agents can only message teammates they have a channel to. The dashboard enforces this — unauthorized messages are rejected.

### Workflow

1. **Create team**: Identify a multi-agent task. Use \`create_team\` with appropriate template.
2. **Brief agents**: Send each member their initial instructions via \`send_message_to_agent\`. Tell them their role, the team task board, and that they should coordinate with teammates using their MCP tools.
3. **Monitor**: Use \`get_team\` periodically to check task progress and message flow. Agents handle routine coordination themselves.
4. **Intervene on exception**: Act when the dashboard reports loop detection, blocked agents, or escalation requests. Read logs, adjust channels, or send guidance.
5. **Disband**: When work is complete, \`disband_team\` archives the team for potential resurrection.

### Loop Detection

The dashboard automatically detects communication loops between agents:
- **Global cap**: Too many messages in a short window — all messaging paused
- **Pair alternation**: Two agents bouncing back and forth with no progress — pair paused, supervisor notified
- **Low-content filter**: Repetitive "acknowledged" / "standing by" messages blocked

You will receive a \`[TEAM EVENT] Loop detected\` notification when this happens. Assess the situation, adjust the team (modify channels, send new instructions, or remove problematic members).

### Deliberation (Group Think Pattern)

For multi-model deliberation, create a team with template \`groupthink\` (all-to-all channels). Mix providers (Claude, Gemini, Codex) for diverse perspectives. Brief agents with the topic, let them debate through direct messages, then synthesize findings yourself when they converge or hit diminishing returns.

## Notebooks (live kernel)

When the user is editing a \`.ipynb\` in the dashboard, the iframe is connected to a real Jupyter kernel. You can drive that **same** kernel — your executions land in the file via the contents API and the user's iframe view updates live (no reload, no "file changed on disk" dialog).

### Kernel tools

- **execute_cell** (notebook_path, cell_id, timeout?=60) — Run one code cell. Returns \`{ status, cell_id, execution_count, outputs_summary }\`. Outputs are compact: text truncated to ~5 KB, images shown as \`{ mime, bytes }\`.
- **execute_range** (notebook_path, from_cell_id, to_cell_id, timeout?=60) — Sequential, stops on first error.
- **interrupt_kernel** (notebook_path) — Interrupts whatever is running. **Affects the user's iframe too** — only do this if you know they want it stopped.
- **restart_kernel** (notebook_path) — Clears in-memory state. Both iframe and you auto-reattach.
- **get_kernel_state** (notebook_path) — \`{ attached, kernel_id, kernel_name, status, execution_state, last_execution_count }\`. Use this before driving a kernel you didn't open.

### Path conventions (important)

The Jupyter server's root_dir is \`/\`. \`notebook_path\` is **server-relative** — strip the leading slash:

- WSL absolute \`/home/user/foo.ipynb\` → \`home/user/foo.ipynb\`
- Windows absolute \`C:\\Users\\user\\foo.ipynb\` → \`mnt/c/Users/user/foo.ipynb\`

### Cell addressing

**Always address cells by their nbformat 4.5 \`id\` (a UUID-like string), never by index.** Indexes shift the moment anyone inserts a cell. Read the \`.ipynb\` JSON to find a cell's \`id\`, or call the \`Read\` tool on the file first.

### Gotchas

- The iframe must have opened the notebook for the kernel to exist with the user's preferred kernelspec. If \`get_kernel_state\` returns \`attached: false\`, \`execute_cell\` will start a fresh \`python3\` session — fine if that's what you want, surprising if not.
- R kernels (IRkernel) buffer stdout until cell end. Don't expect streaming output for R — it lands when the cell finishes.
- Default timeout is 60s. If the cell legitimately takes longer (training, large I/O), pass a higher \`timeout\` rather than letting interrupt fire.
`;

export const SUPERVISOR_MEMORY_MD = `# Supervisor Memory

This file indexes the supervisor's persistent memory for this workspace.
Add entries as you learn important things about the agents, project, or decisions made.

<!-- Example entry:
- [decision_auth_approach.md](decision_auth_approach.md) - Chose JWT over sessions for auth, approved by human 2026-03-20
-->
`;

/** Supervisor skills readme — .claude/agents/supervisor/skills/README.md */
export const SUPERVISOR_SKILLS_README = `# Supervisor Skills

Place reusable skill prompts here. Each \`.md\` file defines a skill the supervisor
can load when handling a specific type of situation.

## Planned Skills
- \`approve-continuation.md\` — Standard approval flow for routine agent prompts
- \`context-compaction.md\` — How to fork an agent and hand off context
- \`crash-triage.md\` — Diagnose crash output and decide retry vs escalate
`;

/** read-agent-log.sh — .claude/agents/supervisor/scripts/read-agent-log.sh */
export const SCRIPT_READ_AGENT_LOG = `#!/usr/bin/env bash
# Read the last N lines of an agent's terminal log via the dashboard HTTP API.
# Usage: read-agent-log.sh <agent-id> [lines]

AGENT_ID="\$\{1:?Usage: read-agent-log.sh <agent-id> [lines]\}"
LINES="\$\{2:-50\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/log?lines=\$\{LINES\}" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to read agent log. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** list-agents.sh — .claude/agents/supervisor/scripts/list-agents.sh */
export const SCRIPT_LIST_AGENTS = `#!/usr/bin/env bash
# List all agents managed by AgentDashboard via the HTTP API.
# Output: JSON array of agents with id, title, status, context info

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to list agents. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** send-message.sh — .claude/agents/supervisor/scripts/send-message.sh */
export const SCRIPT_SEND_MESSAGE = `#!/usr/bin/env bash
# Send a message to an agent via the dashboard HTTP API.
# Usage: send-message.sh <agent-id> "<message>"
#
# SAFETY: Only send to agents in idle/waiting status.
# The API will reject messages to working agents.

AGENT_ID="\$\{1:?Usage: send-message.sh <agent-id> \\"<message>\\"\}"
MESSAGE="\$\{2:?Usage: send-message.sh <agent-id> \\"<message>\\"\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf -X POST "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/input" \\
  -H "Content-Type: application/json" \\
  -d "{\\"text\\": \\"\$\{MESSAGE\}\\"}" 2>&1)

if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to send message. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "Sent to \$AGENT_ID: \$MESSAGE"
echo "\$RESPONSE"
`;

/** get-context-stats.sh — .claude/agents/supervisor/scripts/get-context-stats.sh */
export const SCRIPT_GET_CONTEXT_STATS = `#!/usr/bin/env bash
# Get context window stats for a specific agent via the dashboard HTTP API.
# Usage: get-context-stats.sh <agent-id>

AGENT_ID="\$\{1:?Usage: get-context-stats.sh <agent-id>\}"

# Detect API host — on WSL, reach the Windows host; otherwise localhost
API_PORT=24678
if [ -f /etc/resolv.conf ] && grep -q nameserver /etc/resolv.conf 2>/dev/null && [ -d /mnt/c ]; then
  API_HOST=\$(grep nameserver /etc/resolv.conf | head -1 | awk '{print \$2}')
else
  API_HOST="127.0.0.1"
fi
API_BASE="http://\$\{API_HOST\}:\$\{API_PORT\}"

RESPONSE=\$(curl -sf "\$\{API_BASE\}/api/agents/\$\{AGENT_ID\}/context-stats" 2>&1)
if [ \$? -ne 0 ]; then
  echo "ERROR: Failed to get context stats. Is AgentDashboard running?"
  echo "Tried: \$\{API_BASE\}"
  echo "\$RESPONSE"
  exit 1
fi

echo "\$RESPONSE"
`;

/** Map model ID patterns to their context window sizes */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'opus': 1_000_000,
  'sonnet': 200_000,
  'haiku': 200_000,
};

export function getContextWindowForModel(model: string): number {
  const lower = model.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return value;
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}
