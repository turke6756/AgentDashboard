import type { AgentProvider } from './types';

export const DEFAULT_COMMAND = 'claude --dangerously-skip-permissions --chrome';
export const DEFAULT_COMMAND_WSL = 'ccode --dangerously-skip-permissions --chrome';
export const TMUX_SESSION_PREFIX = 'cad__';
export const STATUS_POLL_INTERVAL_MS = 1500;
export const WORKING_THRESHOLD_MS = 8_000;
export const LOG_DIR_NAME = 'agent-dashboard-logs';
export const CONTEXT_STATS_POLL_INTERVAL_MS = 5000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

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

You are a Supervisor Agent. Your role is coordination and orchestration — NOT direct code editing.

## Your Workspace

Your files live under \`.claude/agents/supervisor/\` relative to this project root:

| Path | Purpose |
|------|---------|
| \`scripts/\` | Bash tool scripts you can execute to interact with the dashboard |
| \`memory/\` | Your persistent memory across sessions (read MEMORY.md first) |
| \`skills/\` | Reusable skill prompts for common workflows |

Always check \`memory/MEMORY.md\` at the start of a session for context from prior runs.

## Available Tools (scripts/)

Run these via Bash. They talk to the AgentDashboard backend.

| Script | Usage | Description |
|--------|-------|-------------|
| \`read-agent-log.sh\` | \`bash .claude/agents/supervisor/scripts/read-agent-log.sh <agent-id> [lines]\` | Read the last N lines (default 50) of an agent's terminal log |
| \`list-agents.sh\` | \`bash .claude/agents/supervisor/scripts/list-agents.sh\` | List all agents with id, title, status, context% |
| \`send-message.sh\` | \`bash .claude/agents/supervisor/scripts/send-message.sh <agent-id> "<message>"\` | Send a message to an idle/waiting agent |
| \`get-context-stats.sh\` | \`bash .claude/agents/supervisor/scripts/get-context-stats.sh <agent-id>\` | Get detailed context window stats for an agent |

**Important:** Only use \`send-message.sh\` on agents whose status is \`idle\` or \`waiting\`. Sending to a \`working\` agent will corrupt its conversation.

## Responsibilities
- Monitor worker agent status and approve routine continuations
- Manage agent context windows (fork/compact when thresholds are reached)
- Handle rate limit cooldowns and crash recovery
- Escalate complex decisions or ambiguous requirements to the human
- Coordinate multi-agent workflows and phase handoffs

## Constraints
- Do NOT edit source code files directly — you are not a coder
- Do NOT run build/test commands yourself
- Communicate with worker agents only through the scripts above
- Keep your responses brief and action-oriented
- When in doubt, escalate to the human rather than guessing
- Save important observations to \`memory/\` so future sessions have context

## Decision Framework

### Tier 1 — Automatic (no human needed)
- Agent asks "should I continue/proceed?" → approve via send-message.sh
- Agent hits rate limit → wait for cooldown, then send continue
- Agent context > 80% → alert human, recommend fork
- Agent crashed with transient error → recommend restart

### Tier 2 — Assisted (bring in help)
- Agent asks a complex technical question → research it, then advise
- Conflicting approaches between agents → analyze and pick one

### Tier 3 — Escalate (human required)
- Architectural decisions, security implications, scope changes
- Ambiguous requirements with no clear answer
- Anything you are not confident about
`;

/** Supervisor memory index — .claude/agents/supervisor/memory/MEMORY.md */
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
# Read the last N lines of an agent's terminal log.
# Usage: read-agent-log.sh <agent-id> [lines]
#
# This reads from the agent-dashboard-logs directory.

AGENT_ID="\${1:?Usage: read-agent-log.sh <agent-id> [lines]}"
LINES="\${2:-50}"

# Logs are stored in the app's log directory
if [ -n "$APPDATA" ]; then
  LOG_DIR="$APPDATA/AgentDashboard/logs"
else
  LOG_DIR="\${HOME}/.config/AgentDashboard/logs"
fi

LOG_FILE="$LOG_DIR/\${AGENT_ID}.log"

if [ ! -f "$LOG_FILE" ]; then
  echo "ERROR: No log file found for agent $AGENT_ID"
  echo "Looked in: $LOG_FILE"
  exit 1
fi

echo "=== Last $LINES lines of agent $AGENT_ID ==="
tail -n "$LINES" "$LOG_FILE"
`;

/** list-agents.sh — .claude/agents/supervisor/scripts/list-agents.sh */
export const SCRIPT_LIST_AGENTS = `#!/usr/bin/env bash
# List all agents managed by AgentDashboard.
# Reads from the agent registry that the dashboard maintains.
#
# Output: JSON array of agents with id, title, status, context info

REGISTRY="\${HOME}/.claude/agent-registry.json"

if [ ! -f "$REGISTRY" ]; then
  echo "ERROR: Agent registry not found at $REGISTRY"
  echo "Make sure AgentDashboard is running."
  exit 1
fi

cat "$REGISTRY"
`;

/** send-message.sh — .claude/agents/supervisor/scripts/send-message.sh */
export const SCRIPT_SEND_MESSAGE = `#!/usr/bin/env bash
# Send a message to an agent via the dashboard's WebSocket server.
# Usage: send-message.sh <agent-id> "<message>"
#
# SAFETY: Only send to agents in idle/waiting status.
# Sending to a working agent will corrupt its conversation.

AGENT_ID="\${1:?Usage: send-message.sh <agent-id> \\"<message>\\"}"
MESSAGE="\${2:?Usage: send-message.sh <agent-id> \\"<message>\\"}"

# The dashboard runs a WS server on port 24678
WS_PORT=24678

# Use curl to hit the dashboard's HTTP API
RESPONSE=$(curl -s -X POST "http://localhost:\${WS_PORT}/api/agents/\${AGENT_ID}/input" \\
  -H "Content-Type: application/json" \\
  -d "{\\"text\\": \\"\${MESSAGE}\\"}" 2>&1)

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to send message. Is AgentDashboard running?"
  echo "$RESPONSE"
  exit 1
fi

echo "Sent to $AGENT_ID: $MESSAGE"
echo "$RESPONSE"
`;

/** get-context-stats.sh — .claude/agents/supervisor/scripts/get-context-stats.sh */
export const SCRIPT_GET_CONTEXT_STATS = `#!/usr/bin/env bash
# Get context window stats for a specific agent.
# Usage: get-context-stats.sh <agent-id>

AGENT_ID="\${1:?Usage: get-context-stats.sh <agent-id>}"

WS_PORT=24678

RESPONSE=$(curl -s "http://localhost:\${WS_PORT}/api/agents/\${AGENT_ID}/context-stats" 2>&1)

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to get context stats. Is AgentDashboard running?"
  echo "$RESPONSE"
  exit 1
fi

echo "$RESPONSE"
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
