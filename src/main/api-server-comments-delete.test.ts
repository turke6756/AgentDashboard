import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';
import type { SelectionComment } from '../shared/types';

// Stub the persistence backing only; requests still enter through the real
// authenticated HTTP server and production route registration.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, any>;

interface ResponseResult { status: number; body: any }

const supervisor = {
  isInputInFlight: () => false,
  getContextStats: () => null,
} as unknown as AgentSupervisor;

const AUTH = { Authorization: `Bearer ${getApiToken()}` };

function request(port: number, route: string, authenticated = true): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
      method: 'DELETE',
      headers: authenticated ? AUTH : {},
      agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function row(id: string, status: SelectionComment['status'], filePath = 'C:\\docs\\Resume_Master.pdf'): SelectionComment {
  return {
    id, workspaceId: 'ws-1', targetType: 'file', kind: 'comment', anchorType: 'pdf',
    pdfAnchor: null, filePath, pathType: 'windows', rootDirectory: 'C:\\docs',
    docHash: null, anchorStart: null, anchorEnd: null, lineStart: null, lineEnd: null,
    prefix: null, suffix: null, quotedText: 'quote', body: id, status,
    sentToAgentId: null, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    sentAt: null, resolvedAt: null,
  };
}

async function main(): Promise<void> {
  let rows = [row('orphan-1', 'orphaned'), row('draft-1', 'draft'), row('orphan-2', 'orphaned')];
  db.getSelectionComment = (id: string) => rows.find((item) => item.id === id) ?? null;
  db.findSelectionCommentsByPath = (filePath: string) => ({
    comments: rows.filter((item) => item.filePath?.toLowerCase() === filePath.toLowerCase()),
    matchedByFilename: false,
  });
  db.deleteSelectionComment = (id: string) => { rows = rows.filter((item) => item.id !== id); };

  const server = new ApiServer(supervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    const unauthorized = await request(port, '/api/comments/orphan-1', false);
    assert.equal(unauthorized.status, 401);
    assert.equal(rows.length, 3, 'authentication must run before deletion');

    const missing = await request(port, '/api/comments/missing');
    assert.deepEqual(missing, { status: 404, body: { error: 'Comment not found' } });

    const one = await request(port, '/api/comments/orphan-1');
    assert.deepEqual(one, { status: 200, body: { deleted: true, id: 'orphan-1' } });
    assert.deepEqual(rows.map((item) => item.id), ['draft-1', 'orphan-2']);

    const invalid = await request(port, '/api/comments?file_path=C%3A%5Cdocs%5CResume_Master.pdf&status=resolved');
    assert.equal(invalid.status, 400);

    const orphaned = await request(port, '/api/comments?file_path=C%3A%5Cdocs%5CResume_Master.pdf&status=orphaned');
    assert.equal(orphaned.status, 200);
    assert.equal(orphaned.body.count, 1);
    assert.equal(orphaned.body.status, 'orphaned');
    assert.deepEqual(rows.map((item) => item.id), ['draft-1']);

    rows.push(row('sent-1', 'sent'));
    const all = await request(port, '/api/comments?file_path=C%3A%5Cdocs%5CResume_Master.pdf&status=all');
    assert.equal(all.status, 200);
    assert.equal(all.body.count, 2);
    assert.deepEqual(rows, []);

    console.log('6 passed, 0 failed');
  } finally {
    server.stop();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
