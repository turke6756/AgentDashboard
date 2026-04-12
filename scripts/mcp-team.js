#!/usr/bin/env node

/**
 * MCP Server for Team Member agents in AgentDashboard.
 *
 * This is injected into agents that are part of a team. It provides scoped
 * tools for inter-agent communication, task management, and team awareness.
 * All tool calls are proxied to the dashboard's HTTP API with channel enforcement.
 *
 * Env vars (set by the dashboard at launch):
 *   AGENT_ID                    — this agent's ID
 *   TEAM_ID                     — the team this agent belongs to
 *   AGENT_DASHBOARD_API_PORT    — API port (default 24678)
 *   AGENT_DASHBOARD_API_HOST    — API host (default 127.0.0.1)
 *
 * IMPORTANT: Never write to stdout directly — it's reserved for MCP protocol.
 * Use console.error() for debug logging.
 */

const http = require('http');

const AGENT_ID = process.env.AGENT_ID;
const TEAM_ID = process.env.TEAM_ID;
const API_PORT = parseInt(process.env.AGENT_DASHBOARD_API_PORT || '24678', 10);
const API_HOST = process.env.AGENT_DASHBOARD_API_HOST || '127.0.0.1';
const API_BASE = `http://${API_HOST}:${API_PORT}`;

if (!AGENT_ID || !TEAM_ID) {
  console.error('[mcp-team] FATAL: AGENT_ID and TEAM_ID env vars are required');
  process.exit(1);
}

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
    console.error('[mcp-team] Failed to parse:', raw.substring(0, 100));
    return;
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-dashboard-team', version: '1.0.0' },
        });
        break;

      case 'notifications/initialized':
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
    console.error(`[mcp-team] Error handling ${method}:`, err.message);
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

// ── Tool Definitions ────────────────────────────────────────────────────

function getToolDefinitions() {
  return [
    {
      name: 'send_message',
      description: 'Send a structured message to a teammate. Only works if you have a channel to the recipient (defined by the supervisor). Messages are delivered when the recipient goes idle.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient agent ID.' },
          subject: { type: 'string', description: 'Short subject line.' },
          status: { type: 'string', enum: ['request', 'question', 'complete', 'blocked', 'update'], description: 'Message intent: request (ask them to do something), question (need info), complete (finished work), blocked (stuck), update (progress info).' },
          summary: { type: 'string', description: '1-2 sentence summary of the message.' },
          detail: { type: 'string', description: 'Optional longer detail.' },
          need: { type: 'string', description: 'Optional: what you specifically need from the recipient.' },
        },
        required: ['to', 'subject', 'status', 'summary'],
      },
    },
    {
      name: 'get_messages',
      description: 'Get messages sent to you by teammates. Returns messages in chronological order.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max messages to return (default 20).' },
        },
      },
    },
    {
      name: 'get_tasks',
      description: 'Get the shared task board for your team. Shows all tasks with status, assignee, and notes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'update_task',
      description: 'Update a task on the shared task board. You can change status, assignee, or add notes.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to update.' },
          status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'blocked'], description: 'New task status.' },
          assigned_to: { type: 'string', description: 'Agent ID to assign the task to.' },
          notes: { type: 'string', description: 'Notes to add (e.g., progress, blockers, results).' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'get_team_info',
      description: 'Get information about your team: members, their roles, communication channels, and who you can message.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'create_task',
      description: 'Create a new task on the shared task board.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title.' },
          description: { type: 'string', description: 'Task description.' },
          assigned_to: { type: 'string', description: 'Agent ID to assign the task to.' },
          blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that block this task.' },
        },
        required: ['title'],
      },
    },
  ];
}

// ── Tool Call Handlers ──────────────────────────────────────────────────

async function handleToolCall(name, args) {
  switch (name) {
    case 'send_message': {
      const message = await apiRequest('POST', `/api/teams/${TEAM_ID}/messages`, {
        fromAgent: AGENT_ID,
        toAgent: args.to,
        subject: args.subject,
        status: args.status,
        summary: args.summary,
        detail: args.detail,
        need: args.need,
      });
      return { content: [{ type: 'text', text: `Message sent to ${args.to}: "${args.subject}" [${args.status}]` }] };
    }

    case 'get_messages': {
      const limit = args.limit || 20;
      const messages = await apiRequest('GET', `/api/teams/${TEAM_ID}/messages?agentId=${AGENT_ID}&limit=${limit}`);
      if (!messages.length) {
        return { content: [{ type: 'text', text: 'No messages.' }] };
      }
      const formatted = messages.map(m =>
        `[${m.createdAt}] From: ${m.fromTitle || m.fromAgent} → To: ${m.toTitle || m.toAgent}\n` +
        `  Subject: ${m.subject} [${m.status}]\n` +
        `  Summary: ${m.summary}` +
        (m.detail ? `\n  Detail: ${m.detail}` : '') +
        (m.need ? `\n  Need: ${m.need}` : '')
      ).join('\n\n');
      return { content: [{ type: 'text', text: formatted }] };
    }

    case 'get_tasks': {
      const tasks = await apiRequest('GET', `/api/teams/${TEAM_ID}/tasks`);
      if (!tasks.length) {
        return { content: [{ type: 'text', text: 'No tasks on the board.' }] };
      }
      const formatted = tasks.map(t => {
        const assignee = t.assignedTo ? ` (assigned: ${t.assignedTo.slice(0, 8)})` : '';
        const notes = t.notes ? `\n    Notes: ${t.notes}` : '';
        const blockers = t.blockedBy?.length ? `\n    Blocked by: ${t.blockedBy.join(', ')}` : '';
        return `  [${t.status.toUpperCase()}] ${t.title}${assignee}${blockers}${notes}`;
      }).join('\n');
      return { content: [{ type: 'text', text: `Team Task Board:\n${formatted}` }] };
    }

    case 'update_task': {
      const updates = {};
      if (args.status) updates.status = args.status;
      if (args.assigned_to) updates.assignedTo = args.assigned_to;
      if (args.notes) updates.notes = args.notes;
      const task = await apiRequest('PATCH', `/api/teams/${TEAM_ID}/tasks/${args.task_id}`, updates);
      return { content: [{ type: 'text', text: `Task "${task.title}" updated: ${task.status}` }] };
    }

    case 'get_team_info': {
      const team = await apiRequest('GET', `/api/teams/${TEAM_ID}`);
      const members = (team.members || []).map(m =>
        `  - ${m.title || m.agentId} (${m.agentId.slice(0, 8)}) [${m.role}] — ${m.status || 'unknown'}${m.agentId === AGENT_ID ? ' ← you' : ''}`
      ).join('\n');
      const myChannels = (team.channels || []).filter(c => c.fromAgent === AGENT_ID);
      const canMessage = myChannels.map(c => {
        const member = (team.members || []).find(m => m.agentId === c.toAgent);
        return `  - ${member?.title || c.toAgent} (${c.toAgent.slice(0, 8)})`;
      }).join('\n');
      return { content: [{ type: 'text', text:
        `Team: ${team.name}\n` +
        `Description: ${team.description || '(none)'}\n` +
        `Template: ${team.template || 'custom'}\n` +
        `Status: ${team.status}\n\n` +
        `Members:\n${members}\n\n` +
        `You can message:\n${canMessage || '  (no outgoing channels)'}`
      }] };
    }

    case 'create_task': {
      const task = await apiRequest('POST', `/api/teams/${TEAM_ID}/tasks`, {
        title: args.title,
        description: args.description || '',
        assignedTo: args.assigned_to,
        blockedBy: args.blocked_by,
        createdBy: AGENT_ID,
      });
      return { content: [{ type: 'text', text: `Task created: "${task.title}" (${task.id})` }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ── Start ───────────────────────────────────────────────────────────────

console.error(`[mcp-team] Started for agent ${AGENT_ID} on team ${TEAM_ID}, API: ${API_BASE}`);
