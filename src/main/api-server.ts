import http from 'http';
import { URL } from 'url';
import type { AgentSupervisor } from './supervisor';
import { getAgent, getAllAgents, getAgentsByWorkspace } from './database';

/**
 * Lightweight HTTP API server that exposes supervisor methods.
 * The MCP server script (scripts/mcp-supervisor.js) calls these endpoints
 * to fulfill tool requests from the supervisor agent.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private supervisor: AgentSupervisor;
  private port: number;

  constructor(supervisor: AgentSupervisor, port = 24678) {
    this.supervisor = supervisor;
    this.port = port;
  }

  start(): void {
    this.server = http.createServer(async (req, res) => {
      // CORS headers for local requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        const result = await this.route(req.method || 'GET', url, req);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Internal error' }));
      }
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      console.log(`[api-server] Listening on http://0.0.0.0:${this.port}`);
    });

    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[api-server] Port ${this.port} in use, trying ${this.port + 1}`);
        this.port++;
        this.server!.listen(this.port, '0.0.0.0');
      } else {
        console.error('[api-server] Error:', err);
      }
    });
  }

  getPort(): number {
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async route(method: string, url: URL, req: http.IncomingMessage): Promise<any> {
    const path = url.pathname;

    // GET /api/agents — list all agents
    if (method === 'GET' && path === '/api/agents') {
      const workspaceId = url.searchParams.get('workspaceId');
      const agents = workspaceId ? getAgentsByWorkspace(workspaceId) : getAllAgents();
      // Enrich with context stats
      return agents.map(a => ({
        ...a,
        contextStats: this.supervisor.getContextStats(a.id),
      }));
    }

    // GET /api/agents/:id — get single agent
    const agentGetMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'GET' && agentGetMatch) {
      const agent = getAgent(agentGetMatch[1]);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      return {
        ...agent,
        contextStats: this.supervisor.getContextStats(agent.id),
      };
    }

    // GET /api/agents/:id/log — read agent log
    const logMatch = path.match(/^\/api\/agents\/([^/]+)\/log$/);
    if (method === 'GET' && logMatch) {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      const log = await this.supervisor.getAgentLog(logMatch[1], lines);
      return { agentId: logMatch[1], lines, log };
    }

    // GET /api/agents/:id/context-stats — get context stats
    const ctxMatch = path.match(/^\/api\/agents\/([^/]+)\/context-stats$/);
    if (method === 'GET' && ctxMatch) {
      const stats = this.supervisor.getContextStats(ctxMatch[1]);
      if (!stats) return { agentId: ctxMatch[1], stats: null };
      return { agentId: ctxMatch[1], stats };
    }

    // POST /api/agents/:id/input — send message to agent
    const inputMatch = path.match(/^\/api\/agents\/([^/]+)\/input$/);
    if (method === 'POST' && inputMatch) {
      const body = await readBody(req);
      const { text } = JSON.parse(body);
      if (!text) throw Object.assign(new Error('Missing "text" in request body'), { statusCode: 400 });

      const agent = getAgent(inputMatch[1]);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

      // Safety gate: only send to idle/waiting agents
      if (['working', 'launching'].includes(agent.status)) {
        throw Object.assign(
          new Error(`Cannot send input to agent in "${agent.status}" state. Wait until it is idle or waiting.`),
          { statusCode: 409 }
        );
      }

      await this.supervisor.sendInput(inputMatch[1], text);
      return { ok: true, agentId: inputMatch[1], message: 'Input sent' };
    }

    // POST /api/agents — launch a new agent
    if (method === 'POST' && path === '/api/agents') {
      const body = await readBody(req);
      const input = JSON.parse(body);
      const agent = await this.supervisor.launchAgent(input);
      return agent;
    }

    // DELETE /api/agents/:id — stop an agent
    const stopMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'DELETE' && stopMatch) {
      await this.supervisor.stopAgent(stopMatch[1]);
      return { ok: true, agentId: stopMatch[1], message: 'Agent stopped' };
    }

    // POST /api/agents/:id/fork — fork an agent
    const forkMatch = path.match(/^\/api\/agents\/([^/]+)\/fork$/);
    if (method === 'POST' && forkMatch) {
      const newAgent = await this.supervisor.forkAgent(forkMatch[1]);
      return newAgent;
    }

    throw Object.assign(new Error(`Not found: ${method} ${path}`), { statusCode: 404 });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
