import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import { ApiServer, type CheckpointRoutes } from './api-server';
import { agentCapabilities } from './security/agent-capabilities';
import { toolsetsForLane } from './supervisor/mcp-config-builder';
import type { AgentSupervisor } from './supervisor';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

// Keep resolveIdentity's attribution lookup from preceding the capability gate.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
db.getWorkspace = (id: string) => ({ id, title: 't', path: '/tmp/ws', pathType: 'windows' });
db.getSupervisorAgent = () => null;
db.getAllAgents = () => [];
db.getAgentsByWorkspace = () => [];

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
} as unknown as AgentSupervisor;

const routes = {
  list: async () => [],
  fileHistory: async () => [],
  diff: async () => ({
    witnessed: { available: true, reason: null, label: 'witnessed changes', text: 'W', provenance: 'witnessed' },
    window: { available: true, reason: null, label: 'unattributed changes in this window', text: 'R', provenance: 'raw-window' },
  }),
  preview: async () => ({ available: true, tokens: {}, validatedPaths: [], rejectedPaths: [], contention: [] }),
  restorePaths: async () => ({ status: 'completed' }),
  revertTurn: async () => ({ status: 'completed' }),
  prune: async () => ({ deletedRefCount: 0 }),
} as unknown as CheckpointRoutes;

interface Res { status: number; body: string; }
function request(port: number, method: string, route: string, authorization: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Authorization: authorization };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function bearerFor(lane: 'supervisor' | 'worker' | 'researcher', agentId: string): string {
  const token = agentCapabilities.mint({ agentId, workspaceId: 'ws1', privilegeLane: lane });
  return `Bearer ${token}`;
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  server.setCheckpointRoutes(routes);
  const port = await server.start();
  try { await run(port); } finally { server.stop(); }
}

test('worker grant resolves exactly list_checkpoints and diff_turn', () => {
  const grant = toolsetsForLane('worker');
  assert.equal(
    grant,
    'comms,observability-core,browser-present,plans-read,memory,checkpoints-read,library-read',
    'REACHABILITY:wp1-checkpoints-read-grant',
  );
  const scriptsDir = path.resolve(__dirname, '..', '..', '..', 'scripts');
  const proxyPath = path.join(scriptsDir, 'mcp-dashboard.js');
  delete require.cache[require.resolve(proxyPath)];
  process.env.DASHBOARD_MCP_NO_START = '1';
  process.env.DASHBOARD_MCP_TOOLSETS = grant;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const proxy = require(proxyPath) as { getToolDefinitions(): Array<{ name: string }> };
  const names = proxy.getToolDefinitions().map(({ name }) => name);
  assert.ok(names.includes('list_checkpoints'));
  assert.ok(names.includes('diff_turn'));
  for (const mutation of ['restore_paths', 'revert_turn', 'prune_checkpoints']) {
    assert.ok(!names.includes(mutation), `worker grant must not resolve ${mutation}`);
  }
});

test('worker can list and diff but is denied every mutation/history route', () =>
  withServer(async (port) => {
    const auth = bearerFor('worker', 'worker-1');
    for (const route of ['/api/checkpoints', '/api/checkpoints/t1/diff']) {
      const res = await request(port, 'GET', route, auth);
      assert.equal(res.status, 200, `REACHABILITY:wp1-checkpoints-read-auth ${route}: ${res.body}`);
    }
    const denied: Array<[string, string, unknown?]> = [
      ['GET', '/api/checkpoints/file-history?path=a.txt'],
      ['POST', '/api/checkpoints/t1/preview', { paths: ['a.txt'] }],
      ['POST', '/api/checkpoints/t1/restore', { paths: ['a.txt'], previewTokens: { 'a.txt': 'oid' } }],
      ['POST', '/api/checkpoints/t1/revert', {}],
      ['POST', '/api/checkpoints/prune', {}],
    ];
    for (const [method, route, body] of denied) {
      const res = await request(port, method, route, auth, body);
      assert.equal(res.status, 403, `${method} ${route}: ${res.body}`);
    }
  }));

test('researcher is denied on every checkpoint route', () =>
  withServer(async (port) => {
    const auth = bearerFor('researcher', 'researcher-1');
    const denied: Array<[string, string, unknown?]> = [
      ['GET', '/api/checkpoints'],
      ['GET', '/api/checkpoints/t1/diff'],
      ['GET', '/api/checkpoints/file-history?path=a.txt'],
      ['POST', '/api/checkpoints/t1/preview', { paths: ['a.txt'] }],
      ['POST', '/api/checkpoints/t1/restore', { paths: ['a.txt'], previewTokens: { 'a.txt': 'oid' } }],
      ['POST', '/api/checkpoints/t1/revert', {}],
      ['POST', '/api/checkpoints/prune', {}],
    ];
    for (const [method, route, body] of denied) {
      const res = await request(port, method, route, auth, body);
      assert.equal(res.status, 403, `${method} ${route}: ${res.body}`);
    }
  }));

(async () => {
  let passed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error(err); process.exitCode = 1; }
  }
  if (!process.exitCode) console.log(`\nAll ${passed} checkpoints-read-lane tests passed`);
})();
