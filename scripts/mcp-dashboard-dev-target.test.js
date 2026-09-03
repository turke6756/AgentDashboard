const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.DASHBOARD_MCP_NO_START = '1';
process.env.DASHBOARD_MCP_TOOLSETS = 'orchestration,comms,observability-core';
process.env.AGENT_DASHBOARD_SELF_ID = 'stable-agent';
process.env.AGENT_DASHBOARD_WORKSPACE_ID = 'stable-workspace';

const proxy = require('./mcp-dashboard');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-wp7-router-'));
const discoveryPath = path.join(root, 'dev-instance.json');
const received = [];
let selfCalls = 0;
const selfRequest = async () => {
  selfCalls += 1;
  return [];
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    let response = {};
    if (req.method === 'POST' && req.url === '/api/agents') {
      response = { id: 'dev-agent', title: 'Dev worker', workspaceId: 'dev-workspace', status: 'idle' };
    } else if (req.url === '/api/agents') {
      response = [];
    } else if (req.url === '/api/workspaces') {
      response = [];
    } else if (req.url.endsWith('/log?lines=50')) {
      response = { content: 'dev log' };
    } else if (req.url.includes('/messages')) {
      response = { messages: [] };
    } else if (req.url.endsWith('/keys')) {
      response = { bytes: 1 };
    } else if (req.url.endsWith('/input')) {
      response = { confirmed: true, mode: 'hook' };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(discoveryPath, JSON.stringify({
    port,
    host: '127.0.0.1',
    token: 'dev-token',
    pid: 4242,
    userData: root,
    startedAt: '2026-09-03T12:00:00.000Z',
  }));

  const router = proxy.createInstanceRouter({
    selfRequest,
    discoveryPath,
    fs,
    isPidAlive: (pid) => pid === 4242,
  });

  const cases = [
    ['list_workspaces', {}],
    ['list_agents', {}],
    ['read_agent_log', { agent_id: 'dev-agent' }],
    ['read_agent_chat', { agent_id: 'dev-agent' }],
    ['send_message_to_agent', { agent_id: 'dev-agent', message: 'hello' }],
    ['send_keys_to_agent', { agent_id: 'dev-agent', key: 'space' }],
    ['stop_agent', { agent_id: 'dev-agent' }],
    ['launch_agent', { title: 'Dev worker', workspace_id: 'dev-workspace' }],
  ];
  for (const [name, input] of cases) {
    const args = { instance: 'dev', ...input };
    const result = await proxy.handleToolCall(name, args, router);
    assert.equal(args.instance, undefined, `REACHABILITY:wp7-dev-target-routing ${name} strips instance`);
    assert.match(
      result.content[0].text,
      /^\[dev instance :\d+\] /,
      `REACHABILITY:wp7-dev-target-routing ${name} labels dev output`,
    );
  }

  assert.equal(selfCalls, 0, 'REACHABILITY:wp7-dev-target-routing dev calls never fall back to self');
  assert.equal(received.length, 8, 'all eight handlers must enter the dev-bound request');
  for (const request of received) {
    assert.equal(request.headers.authorization, 'Bearer dev-token');
    assert.equal(request.headers['x-self-id'], undefined, 'dev request must omit caller identity');
    assert.equal(request.headers['x-workspace-id'], undefined, 'dev request must omit workspace identity');
    assert.ok(!request.body.includes('"instance"'));
    assert.ok(!request.body.includes('stable-agent'), 'cross-instance body must not assert the stable owner');
  }

  const definitions = proxy.getToolDefinitions();
  for (const name of cases.map(([toolName]) => toolName)) {
    const definition = definitions.find((candidate) => candidate.name === name);
    assert.deepEqual(definition.inputSchema.properties.instance.enum, ['self', 'dev']);
  }

  const selfArgs = { instance: 'self' };
  const selfResult = await proxy.handleToolCall('list_workspaces', selfArgs, router);
  assert.equal(selfCalls, 1);
  assert.equal(selfArgs.instance, undefined);
  assert.equal(selfResult.content[0].text.startsWith('[dev instance'), false);

  await assert.rejects(
    () => proxy.handleToolCall('launch_agent', { instance: 'dev', title: 'No workspace' }, router),
    /instance=dev requires an explicit workspace_id/,
  );

  fs.unlinkSync(discoveryPath);
  await assert.rejects(
    async () => router.requestFor({ instance: 'dev' }),
    (error) => error.message.includes(discoveryPath) && error.message.includes('run npm run dev:instance first'),
  );
  fs.writeFileSync(discoveryPath, '{not json');
  await assert.rejects(
    async () => router.requestFor({ instance: 'dev' }),
    /run npm run dev:instance first/,
  );
  fs.writeFileSync(discoveryPath, JSON.stringify({ port, host: '127.0.0.1', token: 'x', pid: 9 }));
  await assert.rejects(
    async () => router.requestFor({ instance: 'dev' }),
    /run npm run dev:instance first/,
  );

  console.log('mcp-dashboard-dev-target: 8 routed tools + refusal matrix passed');
  console.log('REACHABILITY:wp7-dev-target-routing createInstanceRouter entered every dev handler');
})().finally(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
