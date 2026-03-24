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

## Constraints

- Do NOT edit source code or run build/test commands
- Interact with workers ONLY through MCP tools (or curl fallback)
- Keep responses brief and action-oriented
- When in doubt, escalate to the human

## Decision Framework

**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, flag context > 80%
**Tier 2 — Assisted:** Research complex technical questions, resolve conflicting approaches
**Tier 3 — Escalate:** Architectural decisions, security, scope changes, ambiguous requirements
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
