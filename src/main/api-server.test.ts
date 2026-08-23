// plan_1fe663ce WP-6 entering test: real migration MCP tool -> live HTTP route
// -> real archive mover -> filesystem. This deliberately obtains both entry
// seams the way production does; it does not call archiveMemoryEntry directly.
//
//   npx tsc -p tsconfig.main.json
//   node dist/main/main/api-server.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { DISCLOSURE_FORMAT_MARKER } from '../shared/memory-index-core';
import { ApiServer } from './api-server';
import { getApiToken } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';

interface MigrationToolModule {
  getMigrationToolDefinitions(): Array<{ name: string }>;
  handleMigrationToolCall(
    name: string,
    args: Record<string, unknown>,
    apiRequest: (method: string, route: string, body?: unknown) => Promise<unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const migrationTools = require(path.resolve('scripts/mcp-tools-migration.js')) as MigrationToolModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const reviewStore = require('./memory-index/review-store') as {
  computeFindingId(workspaceId: string, finding: unknown): string;
  upsertFindings: (workspaceId: string, findings: unknown[]) => string[];
};

// The entering seam uses the real mover and filesystem. Replace only its
// persistence backing because this standalone HTTP test does not initialize the
// Electron app database; the mover's own suite covers the SQLite persistence.
reviewStore.upsertFindings = (workspaceId, findings) => findings.map((finding) => reviewStore.computeFindingId(workspaceId, finding));
db.getDb = () => ({ prepare: () => ({ run: () => ({ changes: 1 }) }) });

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

const WS_ID = 'wp6-workspace';
const SUPERVISOR_ID = 'wp6-supervisor';
const MEMORY_ID = 'mb-2026-08-22-route';
const INDEX_REL = '.lares/supervisor/memory/MEMORY.md';
const DETAIL_REL = `.lares/supervisor/memory/details/${MEMORY_ID}.md`;
const ARCHIVE_INDEX_REL = '.lares/supervisor/memory/archive/ARCHIVE.md';
const ARCHIVE_BODY_REL = `.lares/supervisor/memory/archive/${MEMORY_ID}.md`;

function sha(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function full(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

function writeAt(root: string, rel: string, content: string): void {
  const target = full(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function apiRequest(port: number, supervisorId = SUPERVISOR_ID) {
  return (method: string, route: string, body?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: route,
      method,
      agent: false,
      headers: {
        Authorization: `Bearer ${getApiToken()}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': WS_ID,
        ...(supervisorId ? { 'X-Supervisor-Id': supervisorId } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if ((res.statusCode ?? 500) >= 400) {
            reject(Object.assign(new Error(parsed.error ?? `HTTP ${res.statusCode}`), { statusCode: res.statusCode, body: parsed }));
          } else {
            resolve(parsed);
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const stubSupervisor = {
  getContextStats: () => null,
  getUsageLimits: () => ({ available: false, reason: 'no_reading_yet', account_wide: true }),
  isInputInFlight: () => false,
  emit: () => false,
} as unknown as AgentSupervisor;

test('archive_memory enters through registered tool -> POST route -> mover and archives the real files', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-archive-route-'));
  const index = [
    DISCLOSURE_FORMAT_MARKER,
    '',
    `## ${MEMORY_ID}: Route archive fixture`,
    '- read-if: the route archive fixture becomes relevant',
    `- detail: memory/details/${MEMORY_ID}.md`,
    '',
  ].join('\n');
  const body = [
    '<!-- memory-disposal:v1',
    'kind: expires-when',
    'value: the route-to-mover entering test passes',
    '-->',
    '',
    '# Route archive fixture',
    '',
    'Retained bytes.',
    '',
  ].join('\n');
  writeAt(workDir, INDEX_REL, index);
  writeAt(workDir, DETAIL_REL, body);

  db.getWorkspace = (id: string) => id === WS_ID ? { id: WS_ID, title: 'WP-6', path: workDir } : null;
  db.getAgent = (id: string) => id === SUPERVISOR_ID
    ? { id, workspaceId: WS_ID, isSupervisor: true, status: 'working', provider: 'codex', title: 'WP-6 supervisor' }
    : null;
  db.getSupervisorAgent = () => null;

  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    assert.ok(
      migrationTools.getMigrationToolDefinitions().some((definition) => definition.name === 'archive_memory'),
      'production migration toolset must register archive_memory',
    );
    const refused = await migrationTools.handleMigrationToolCall('archive_memory', {
      id: MEMORY_ID,
      expected_prior_hash: sha('stale index'),
      expected_body_hash: sha(body),
    }, apiRequest(port));
    assert.deepEqual(
      JSON.parse(refused!.content[0].text),
      { ok: false, code: 'cas_mismatch', message: 'live memory index changed (expected_prior_hash mismatch)' },
      'REACHABILITY:archive-route — mover refusal must remain a structured HTTP 200/tool result',
    );
    assert.equal(fs.existsSync(full(workDir, ARCHIVE_BODY_REL)), false, 'CAS refusal must not mutate files');

    const result = await migrationTools.handleMigrationToolCall('archive_memory', {
      id: MEMORY_ID,
      expected_prior_hash: sha(index),
      expected_body_hash: sha(body),
    }, apiRequest(port));

    assert.ok(result, 'archive_memory must be handled by the production migration toolset');
    assert.deepEqual(JSON.parse(result!.content[0].text), { ok: true }, 'REACHABILITY:archive-route');
    assert.equal(fs.readFileSync(full(workDir, INDEX_REL), 'utf8').includes(`## ${MEMORY_ID}:`), false);
    assert.equal(fs.readFileSync(full(workDir, ARCHIVE_INDEX_REL), 'utf8').includes(`## ${MEMORY_ID}:`), true);
    assert.equal(fs.readFileSync(full(workDir, ARCHIVE_BODY_REL), 'utf8'), body);
    assert.equal(fs.existsSync(full(workDir, DETAIL_REL)), false);
  } finally {
    server.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('archive route retains asserted-supervisor provenance but also permits a workspace-authenticated janitor', async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-archive-gate-'));
  const index = [
    DISCLOSURE_FORMAT_MARKER,
    '',
    `## ${MEMORY_ID}: Janitor archive fixture`,
    '- read-if: the janitor archive fixture becomes relevant',
    `- detail: memory/details/${MEMORY_ID}.md`,
    '',
  ].join('\n');
  const body = [
    '<!-- memory-disposal:v1',
    'kind: expires-when',
    'value: the janitor route test passes',
    '-->',
    '',
    '# Janitor archive fixture',
    '',
    'Retained bytes.',
    '',
  ].join('\n');
  writeAt(workDir, INDEX_REL, index);
  writeAt(workDir, DETAIL_REL, body);

  const assertedLookups: string[] = [];
  db.getWorkspace = (id: string) => id === WS_ID ? { id: WS_ID, title: 'WP-6', path: workDir } : null;
  db.getAgent = (id: string) => {
    assertedLookups.push(id);
    return id === SUPERVISOR_ID
      ? { id, workspaceId: WS_ID, isSupervisor: true, status: 'working', provider: 'codex', title: 'WP-6 supervisor' }
      : null;
  };
  db.getSupervisorAgent = () => null;
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try {
    const asserted = await apiRequest(port)('POST', '/api/memory/archive', {
      id: MEMORY_ID,
      expected_prior_hash: sha('stale index'),
      expected_body_hash: sha(body),
    });
    assert.deepEqual(assertedLookups, [SUPERVISOR_ID], 'asserted supervisor id is validated and retained as request provenance');
    assert.deepEqual(
      asserted,
      { ok: false, code: 'cas_mismatch', message: 'live memory index changed (expected_prior_hash mismatch)' },
      'an asserted-supervisor request proceeds through the mover',
    );

    const invalidId = await apiRequest(port, '')('POST', '/api/memory/archive', {
      id: '../escape',
      expected_prior_hash: sha(index),
      expected_body_hash: sha(body),
    });
    assert.deepEqual(invalidId, { ok: false, code: 'invalid_id' });
    assert.equal(fs.existsSync(path.join(workDir, 'escape.md')), false, 'invalid id is refused before filesystem work');

    const invalidJson = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/api/memory/archive', method: 'POST', agent: false,
        headers: {
          Authorization: `Bearer ${getApiToken()}`,
          'Content-Type': 'application/json',
          'X-Workspace-Id': WS_ID,
        },
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end('{not-json');
    });
    assert.deepEqual(invalidJson, { status: 200, body: { ok: false, code: 'invalid_json' } });

    const janitor = await migrationTools.handleMigrationToolCall('archive_memory', {
      id: MEMORY_ID,
      expected_prior_hash: sha(index),
      expected_body_hash: sha(body),
    }, apiRequest(port, ''));
    assert.deepEqual(JSON.parse(janitor!.content[0].text), { ok: true }, 'no-supervisor janitor request still reaches the mover');
    assert.equal(fs.readFileSync(full(workDir, ARCHIVE_BODY_REL), 'utf8'), body);
  } finally {
    server.stop();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${t.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
