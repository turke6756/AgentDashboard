import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer, API_MAX_PAYLOAD_BYTES } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface ResponseResult { status: number; body: string }

const supervisor = {
  isInputInFlight: () => false,
  getContextStats: () => null,
  bindCodexSessionFromHook: (_agentId: string, sessionId?: string) => ({
    action: 'bind', sessionId: sessionId ?? '',
  }),
} as unknown as AgentSupervisor;

const auth = `Bearer ${getApiToken()}`;

function request(
  port: number,
  headers: http.OutgoingHttpHeaders,
  chunks: Buffer[],
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/agents/cap-test/codex-session',
      method: 'POST',
      headers: { Authorization: auth, ...headers },
      agent: false,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

async function main(): Promise<void> {
  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    const valid = Buffer.from(JSON.stringify({ sessionId: 'valid-session' }));
    const ok = await request(port, {
      'Content-Type': 'application/json',
      'Content-Length': valid.length,
    }, [valid]);
    assert.equal(ok.status, 200, `valid body semantics changed: ${ok.status} ${ok.body}`);

    const declared = await request(port, {
      'Content-Type': 'application/json',
      'Content-Length': API_MAX_PAYLOAD_BYTES + 1,
    }, []);
    assert.equal(declared.status, 413, `oversized Content-Length must reject before body streaming: ${declared.body}`);

    let streamingRejected = false;
    try {
      await request(port, {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
      }, [Buffer.alloc(API_MAX_PAYLOAD_BYTES), Buffer.from('x')]);
    } catch (err) {
      streamingRejected = (err as NodeJS.ErrnoException).code === 'ECONNRESET'
        || (err as NodeJS.ErrnoException).code === 'EPIPE';
    }
    assert.equal(streamingRejected, true, 'stream overflow must destroy the request connection');
    console.log('3 passed, 0 failed');
  } finally {
    server.stop();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
