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

// The dashboard API host/port — passed via env vars or defaults
const API_PORT = parseInt(process.env.AGENT_DASHBOARD_API_PORT || '24678', 10);
const API_HOST = process.env.AGENT_DASHBOARD_API_HOST || '127.0.0.1';
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
      description: 'Launch a new worker agent in a workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID.' },
          title: { type: 'string', description: 'Title for the agent.' },
          role_description: { type: 'string', description: 'Optional role description.' },
          prompt: { type: 'string', description: 'Optional initial prompt.' },
        },
        required: ['workspace_id', 'title'],
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
      const agent = await apiRequest('POST', '/api/agents', input);
      let text = `Launched agent "${agent.title}" (${agent.id}) in workspace ${agent.workspaceId}`;
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

    case 'fork_agent': {
      const newAgent = await apiRequest('POST', `/api/agents/${args.agent_id}/fork`);
      return { content: [{ type: 'text', text: `Forked agent ${args.agent_id} → new agent "${newAgent.title}" (${newAgent.id})` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ── Start ───────────────────────────────────────────────────────────────

console.error(`[mcp-supervisor] Started, API target: ${API_BASE}`);
