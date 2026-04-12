#!/usr/bin/env node

/**
 * MCP Server for the AgentDashboard Supervisor Agent.
 *
 * This runs as a stdio MCP server — Claude Code spawns it and communicates
 * via JSON-RPC over stdin/stdout. It proxies tool calls to the dashboard's
 * HTTP API server running on localhost.
 *
 * IMPORTANT: Never write to stdout directly — it's reserved for MCP protocol.
 * Use console.error() for debug logging.
 */

const http = require('http');
const fs = require('fs');

// The dashboard API host/port — passed via env vars or defaults.
// Auto-detect WSL: if no explicit host is set and we're inside WSL2,
// read the Windows host IP from /etc/resolv.conf so we can reach the
// dashboard running on the Windows side.
const API_PORT = parseInt(process.env.AGENT_DASHBOARD_API_PORT || '24678', 10);

function detectApiHost() {
  if (process.env.AGENT_DASHBOARD_API_HOST) return process.env.AGENT_DASHBOARD_API_HOST;
  // Detect WSL2 by checking for /proc/version containing Microsoft/WSL
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf-8');
    if (/microsoft|wsl/i.test(procVersion)) {
      const resolv = fs.readFileSync('/etc/resolv.conf', 'utf-8');
      const match = resolv.match(/nameserver\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match) {
        console.error(`[mcp-supervisor] WSL detected, using Windows host IP: ${match[1]}`);
        return match[1];
      }
    }
  } catch { /* not WSL or can't read — fall through */ }
  return '127.0.0.1';
}

const API_HOST = detectApiHost();
const API_BASE = `http://${API_HOST}:${API_PORT}`;

// ── Helpers ─────────────────────────────────────────────────────────────

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Invalid JSON from API: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Dashboard API unreachable (${API_BASE}): ${err.message}`));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── MCP Protocol (newline-delimited JSON-RPC over stdio) ────────────────

const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  handleMessage(line);
});

function sendResponse(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) {
  sendResponse({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[mcp] Failed to parse:', raw.substring(0, 100));
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-dashboard', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
        // No response needed
        break;

      case 'tools/list':
        sendResult(id, { tools: getToolDefinitions() });
        break;

      case 'tools/call':
        try {
          const result = await handleToolCall(params.name, params.arguments || {});
          sendResult(id, result);
        } catch (err) {
          sendResult(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
        break;

      case 'ping':
        sendResult(id, {});
        break;

      default:
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    console.error(`[mcp] Error handling ${method}:`, err.message);
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

// ── Tool Definitions ────────────────────────────────────────────────────

function getToolDefinitions() {
  return [
    {
      name: 'list_agents',
      description: 'List all agents in the dashboard with their status, context usage, and metadata.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'Optional: filter by workspace ID.' },
        },
      },
    },
    {
      name: 'read_agent_log',
      description: "Read the last N lines of an agent's terminal output.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          lines: { type: 'number', description: 'Lines to read (default 50, max 500).' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'send_message_to_agent',
      description: 'Send a message to an idle/waiting agent. Rejects if agent is working.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
          message: { type: 'string', description: 'Message to send as user input.' },
        },
        required: ['agent_id', 'message'],
      },
    },
    {
      name: 'get_context_stats',
      description: 'Get context window usage (tokens, percentage, model, turns) for an agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'stop_agent',
      description: 'Stop a running agent. Use with caution.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to stop.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'launch_agent',
      description: 'Launch a new worker agent in a workspace. Optionally use a template or persona for pre-configured identity/prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          title: { type: 'string', description: 'Title for the agent.' },
          role_description: { type: 'string', description: 'Optional role description.' },
          prompt: { type: 'string', description: 'Optional initial prompt to send after launch.' },
          template_id: { type: 'string', description: 'Optional template ID. Agent inherits the template persona, prompt, provider, etc.' },
          persona: { type: 'string', description: 'Persona subdirectory name under .claude/agents/. Agent inherits its CLAUDE.md as system instructions.' },
          system_prompt: { type: 'string', description: 'Optional identity prompt injected as the first message. Overrides template system_prompt.' },
          provider: { type: 'string', enum: ['claude', 'gemini', 'codex'], description: 'AI provider (default: claude).' },
          command: { type: 'string', description: 'Custom command to launch the agent process. Overrides the provider default.' },
          working_directory: { type: 'string', description: 'Working directory for the agent. Defaults to workspace root.' },
          auto_restart: { type: 'boolean', description: 'Auto-restart the agent on crash (default: true).' },
          supervised: { type: 'boolean', description: 'Whether the supervisor is notified on agent status changes (default: false).' },
        },
        required: ['workspace_id', 'title'],
      },
    },
    {
      name: 'create_persona',
      description: 'Create a new persistent agent persona directory under .claude/agents/. Creates the folder with CLAUDE.md and memory/MEMORY.md scaffolding.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          name: { type: 'string', description: 'Persona name (lowercase, hyphens, underscores only). Becomes the directory name under .claude/agents/.' },
          claude_md: { type: 'string', description: 'Content for the persona CLAUDE.md file. Defines the agent identity and behavior.' },
        },
        required: ['workspace_id', 'name'],
      },
    },
    {
      name: 'list_templates',
      description: 'List available agent templates for a workspace. Returns global and workspace-scoped templates.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'fork_agent',
      description: "Fork an agent's session to fresh context. Use for context compaction.",
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to fork.' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'start_groupthink',
      description: 'Start a Group Think session — enroll agents to deliberate on a topic across multiple rounds.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          topic: { type: 'string', description: 'The topic or question for agents to deliberate on.' },
          agent_ids: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to enroll.' },
          max_rounds: { type: 'number', description: 'Max deliberation rounds (default 3, max 5).' },
        },
        required: ['workspace_id', 'topic', 'agent_ids'],
      },
    },
    {
      name: 'get_groupthink_status',
      description: 'Get the status of a Group Think session including per-member agent status.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The Group Think session ID.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'advance_groupthink_round',
      description: 'Advance a Group Think session to the next round after cross-pollinating findings.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The Group Think session ID.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'complete_groupthink',
      description: 'Complete a Group Think session with a synthesis report.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The Group Think session ID.' },
          synthesis: { type: 'string', description: 'The final synthesis report (markdown).' },
        },
        required: ['session_id', 'synthesis'],
      },
    },
    // ── Team management tools ──────────────────────────────────────────
    {
      name: 'create_team',
      description: 'Create a team of agents with defined communication channels and optional task board. Agents in the team get MCP tools to communicate directly with each other.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          name: { type: 'string', description: 'Team name.' },
          description: { type: 'string', description: 'Team purpose/description.' },
          template: { type: 'string', enum: ['groupthink', 'pipeline', 'custom'], description: 'Channel template: groupthink (all-to-all), pipeline (linear chain A→B→C), custom (define channels explicitly).' },
          members: { type: 'array', items: { type: 'object', properties: { agentId: { type: 'string' }, role: { type: 'string' } }, required: ['agentId'] }, description: 'Agent IDs to enroll as members.' },
          channels: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to'] }, description: 'Explicit channels (for custom template or additions to template).' },
        },
        required: ['workspace_id', 'name', 'members'],
      },
    },
    {
      name: 'disband_team',
      description: 'Disband a team, archiving its manifest for potential resurrection. Saves members, channels, tasks, and recent messages.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID to disband.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'add_team_member',
      description: 'Add an agent to an existing team. The agent will receive team MCP tools and a notification.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          agent_id: { type: 'string', description: 'The agent ID to add.' },
          role: { type: 'string', description: 'Role in the team (default: member).' },
        },
        required: ['team_id', 'agent_id'],
      },
    },
    {
      name: 'remove_team_member',
      description: 'Remove an agent from a team. Cleans up their channels.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          agent_id: { type: 'string', description: 'The agent ID to remove.' },
        },
        required: ['team_id', 'agent_id'],
      },
    },
    {
      name: 'add_channel',
      description: 'Add a communication channel between two team members (one-directional: from → to).',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          from_agent: { type: 'string', description: 'Sending agent ID.' },
          to_agent: { type: 'string', description: 'Receiving agent ID.' },
          label: { type: 'string', description: 'Optional label for this channel.' },
        },
        required: ['team_id', 'from_agent', 'to_agent'],
      },
    },
    {
      name: 'remove_channel',
      description: 'Remove a communication channel from a team.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
          channel_id: { type: 'string', description: 'The channel ID to remove.' },
        },
        required: ['team_id', 'channel_id'],
      },
    },
    {
      name: 'get_team',
      description: 'Get full team status including members, channels, recent messages, and tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The team ID.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'list_teams',
      description: 'List all teams in a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: 'resurrect_team',
      description: 'Resurrect a disbanded team from its saved manifest. Re-launches agents, restores channels and tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          team_id: { type: 'string', description: 'The disbanded team ID to resurrect.' },
        },
        required: ['team_id'],
      },
    },
    {
      name: 'execute_notebook',
      description: 'Execute a Jupyter notebook in-place using nbconvert. Runs all cells in a real kernel (R, Python, Julia, etc.) and writes outputs back to the .ipynb file. Use this instead of extracting code from notebooks.',
      inputSchema: {
        type: 'object',
        properties: {
          notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file.' },
          kernel_name: { type: 'string', description: 'Kernel name (e.g. "ir" for R, "python3" for Python). If omitted, uses the kernel specified in notebook metadata.' },
          timeout: { type: 'number', description: 'Per-cell execution timeout in seconds (default 600).' },
        },
        required: ['notebook_path'],
      },
    },
  ];
}

// ── Tool Call Handlers ──────────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    case 'list_agents': {
      const p = args.workspace_id
        ? `/api/agents?workspaceId=${encodeURIComponent(args.workspace_id)}`
        : '/api/agents';
      const agents = await apiRequest('GET', p);
      const summary = agents.map(a => ({
        id: a.id,
        title: a.title,
        status: a.status,
        provider: a.provider,
        isSupervisor: a.isSupervisor,
        workingDirectory: a.workingDirectory,
        context: a.contextStats ? {
          percentage: Math.round(a.contextStats.contextPercentage) + '%',
          tokensUsed: a.contextStats.totalTokens,
          turns: a.contextStats.turnCount,
          model: a.contextStats.model,
        } : null,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }

    case 'read_agent_log': {
      const lines = Math.min(args.lines || 50, 500);
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/log?lines=${lines}`);
      return { content: [{ type: 'text', text: result.log || '(no output)' }] };
    }

    case 'send_message_to_agent': {
      await apiRequest('POST', `/api/agents/${args.agent_id}/input`, { text: args.message });
      return { content: [{ type: 'text', text: `Message sent to agent ${args.agent_id}: "${args.message}"` }] };
    }

    case 'get_context_stats': {
      const result = await apiRequest('GET', `/api/agents/${args.agent_id}/context-stats`);
      return { content: [{ type: 'text', text: JSON.stringify(result.stats || { message: 'No context stats available yet' }, null, 2) }] };
    }

    case 'stop_agent': {
      await apiRequest('DELETE', `/api/agents/${args.agent_id}`);
      return { content: [{ type: 'text', text: `Agent ${args.agent_id} has been stopped.` }] };
    }

    case 'launch_agent': {
      const input = {
        workspaceId: args.workspace_id,
        title: args.title,
        roleDescription: args.role_description || '',
      };
      if (args.template_id) input.templateId = args.template_id;
      if (args.persona) input.persona = args.persona;
      if (args.system_prompt) input.systemPrompt = args.system_prompt;
      if (args.provider) input.provider = args.provider;
      if (args.command) input.command = args.command;
      if (args.working_directory) input.workingDirectory = args.working_directory;
      if (args.auto_restart !== undefined) input.autoRestartEnabled = args.auto_restart;
      if (args.supervised !== undefined) input.isSupervised = args.supervised;
      const agent = await apiRequest('POST', '/api/agents', input);
      let text = `Launched agent "${agent.title}" (${agent.id}) in workspace ${agent.workspaceId}`;
      if (args.template_id) text += `\nTemplate: ${args.template_id}`;
      if (args.prompt) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          await apiRequest('POST', `/api/agents/${agent.id}/input`, { text: args.prompt });
          text += `\nSent initial prompt: "${args.prompt.substring(0, 100)}..."`;
        } catch {
          text += `\nNote: Agent launched but initial prompt could not be sent yet.`;
        }
      }
      return { content: [{ type: 'text', text }] };
    }

    case 'create_persona': {
      const body = { workspaceId: args.workspace_id, name: args.name };
      if (args.claude_md) body.claudeMd = args.claude_md;
      const persona = await apiRequest('POST', '/api/personas', body);
      return { content: [{ type: 'text', text: `Persona "${persona.name}" created at ${persona.directory}\nHas memory: ${persona.hasMemory}\nYou can now launch an agent with persona: "${persona.name}"` }] };
    }

    case 'list_templates': {
      const templates = await apiRequest('GET', `/api/templates?workspaceId=${encodeURIComponent(args.workspace_id)}`);
      const templateSummary = templates.map(t => ({
        type: 'template',
        id: t.id,
        name: t.name,
        description: t.description,
        provider: t.provider,
        isSupervisor: t.isSupervisor,
        hasSystemPrompt: !!t.systemPrompt,
      }));
      // Also fetch personas
      let personaSummary = [];
      try {
        const personas = await apiRequest('GET', `/api/personas?workspaceId=${encodeURIComponent(args.workspace_id)}`);
        personaSummary = personas.filter(p => !p.isSupervisor).map(p => ({
          type: 'persona',
          name: p.name,
          directory: p.directory,
          hasMemory: p.hasMemory,
        }));
      } catch { /* personas endpoint may not exist yet */ }
      const combined = [...personaSummary, ...templateSummary];
      return { content: [{ type: 'text', text: JSON.stringify(combined, null, 2) }] };
    }

    case 'fork_agent': {
      const newAgent = await apiRequest('POST', `/api/agents/${args.agent_id}/fork`);
      return { content: [{ type: 'text', text: `Forked agent ${args.agent_id} → new agent "${newAgent.title}" (${newAgent.id})` }] };
    }

    case 'start_groupthink': {
      const session = await apiRequest('POST', '/api/groupthink', {
        workspaceId: args.workspace_id,
        topic: args.topic,
        agentIds: args.agent_ids,
        maxRounds: args.max_rounds,
      });
      return { content: [{ type: 'text', text: `Group Think session started: "${session.topic}" (${session.id})\nMembers: ${session.memberAgentIds.length} agents, max ${session.maxRounds} rounds` }] };
    }

    case 'get_groupthink_status': {
      const session = await apiRequest('GET', `/api/groupthink/${args.session_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
    }

    case 'advance_groupthink_round': {
      const session = await apiRequest('POST', `/api/groupthink/${args.session_id}/advance`);
      return { content: [{ type: 'text', text: `Advanced to round ${session.roundCount}/${session.maxRounds}` }] };
    }

    case 'complete_groupthink': {
      const session = await apiRequest('POST', `/api/groupthink/${args.session_id}/complete`, {
        synthesis: args.synthesis,
      });
      return { content: [{ type: 'text', text: `Group Think completed. Synthesis stored (${args.synthesis.length} chars).` }] };
    }

    // ── Team management handlers ─────────────────────────────────────
    case 'create_team': {
      const team = await apiRequest('POST', '/api/teams', {
        workspaceId: args.workspace_id,
        name: args.name,
        description: args.description || '',
        template: args.template || 'custom',
        members: args.members,
        channels: args.channels,
      });
      const memberList = (team.members || []).map(m => `  - "${m.title || m.agentId}" (${m.agentId.slice(0, 8)}) [${m.role}]`).join('\n');
      const channelCount = (team.channels || []).length;
      return { content: [{ type: 'text', text: `Team "${team.name}" created (${team.id})\nTemplate: ${team.template || 'custom'}\nMembers:\n${memberList}\nChannels: ${channelCount}` }] };
    }

    case 'disband_team': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}`);
      return { content: [{ type: 'text', text: `Team ${args.team_id} disbanded. Manifest saved for resurrection.` }] };
    }

    case 'add_team_member': {
      await apiRequest('POST', `/api/teams/${args.team_id}/members`, {
        agentId: args.agent_id,
        role: args.role || 'member',
      });
      return { content: [{ type: 'text', text: `Added agent ${args.agent_id} to team ${args.team_id} as ${args.role || 'member'}` }] };
    }

    case 'remove_team_member': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}/members/${args.agent_id}`);
      return { content: [{ type: 'text', text: `Removed agent ${args.agent_id} from team ${args.team_id}` }] };
    }

    case 'add_channel': {
      const channel = await apiRequest('POST', `/api/teams/${args.team_id}/channels`, {
        fromAgent: args.from_agent,
        toAgent: args.to_agent,
        label: args.label,
      });
      return { content: [{ type: 'text', text: `Channel created: ${args.from_agent} → ${args.to_agent} (${channel.id})` }] };
    }

    case 'remove_channel': {
      await apiRequest('DELETE', `/api/teams/${args.team_id}/channels/${args.channel_id}`);
      return { content: [{ type: 'text', text: `Channel ${args.channel_id} removed.` }] };
    }

    case 'get_team': {
      const team = await apiRequest('GET', `/api/teams/${args.team_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(team, null, 2) }] };
    }

    case 'list_teams': {
      const teams = await apiRequest('GET', `/api/teams?workspaceId=${encodeURIComponent(args.workspace_id)}`);
      const summary = teams.map(t => ({
        id: t.id,
        name: t.name,
        status: t.status,
        template: t.template,
        memberCount: (t.members || []).length,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }

    case 'resurrect_team': {
      const team = await apiRequest('POST', `/api/teams/${args.team_id}/resurrect`);
      return { content: [{ type: 'text', text: `Team "${team.name}" resurrected (${team.id}). Status: ${team.status}` }] };
    }

    case 'execute_notebook': {
      const payload = { notebookPath: args.notebook_path };
      if (args.kernel_name) payload.kernelName = args.kernel_name;
      if (args.timeout) payload.timeout = args.timeout;
      const result = await apiRequest('POST', '/api/notebooks/execute', payload);
      const duration = result.duration ? ` in ${(result.duration / 1000).toFixed(1)}s` : '';
      return { content: [{ type: 'text', text: `Notebook executed successfully${duration} (kernel: ${result.kernel}). The .ipynb file now contains all outputs.` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ── Start ───────────────────────────────────────────────────────────────

console.error(`[mcp-supervisor] Started, API target: ${API_BASE}`);
