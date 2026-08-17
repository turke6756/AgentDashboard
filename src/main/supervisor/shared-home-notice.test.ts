import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const MARKER = 'REACHABILITY:shared-home-notice-unreferenced';
const BANNED_RESEARCHER_WORDS = /\b(?:cage|sandbox|sandboxed|contained|confined|isolated)\b/i;

function repoRoot(): string {
  if (fs.existsSync(path.join(process.cwd(), 'scripts', 'mcp-tools-orchestration.js'))) return process.cwd();
  let candidate = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(candidate, 'scripts', 'mcp-tools-orchestration.js'))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error(`${MARKER} repository root not found`);
    candidate = parent;
  }
}

const ROOT = repoRoot();
const orchestration = require(path.join(ROOT, 'scripts', 'mcp-tools-orchestration.js')) as {
  getOrchestrationToolDefinitions(): Array<{
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, { description?: string }> };
  }>;
  handleOrchestrationToolCall(
    name: string,
    args: Record<string, unknown>,
    apiRequest: (method: string, route: string, body?: unknown) => Promise<Record<string, unknown>>,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
};

test('emitted launch_agent researcher description states the real provider boundaries', () => {
  const launch = orchestration.getOrchestrationToolDefinitions()
    .find((definition) => definition.name === 'launch_agent');
  assert.ok(launch, `${MARKER} production tool registry must emit launch_agent`);
  const emitted = launch.inputSchema.properties?.is_researcher?.description ?? '';
  assert.match(emitted, /Claude, Codex, or Antigravity \(`agy`\)/, `${MARKER} emitted description must name supported providers`);
  assert.match(emitted, /Codex and agy researcher launches have no enforced write boundary/, `${MARKER} emitted description must state the absent boundaries`);
  assert.match(emitted, /normal provider home.*settings and session history/is, `${MARKER} emitted description must state shared provider state`);
  assert.doesNotMatch(emitted, BANNED_RESEARCHER_WORDS, `${MARKER} emitted researcher description uses banned posture language`);
  assert.doesNotMatch(emitted, /Claude-only|non-claude is rejected/i, `${MARKER} emitted description must not claim the lane is Claude-only`);
});

for (const provider of ['claude', 'codex', 'agy'] as const) {
  test(`production launch_agent result emits the shared-home notice once for ${provider}`, async () => {
    const calls: Array<{ method: string; route: string; body?: unknown }> = [];
    const result = await orchestration.handleOrchestrationToolCall(
      'launch_agent',
      { title: `${provider} researcher`, provider, is_researcher: true },
      async (method, route, body) => {
        calls.push({ method, route, body });
        return { id: `${provider}-researcher-id`, title: `${provider} researcher`, workspaceId: 'workspace-1', provider, status: 'launching' };
      },
    );
    assert.deepEqual(calls.map(({ method, route }) => ({ method, route })), [
      { method: 'POST', route: '/api/agents' },
    ], `${MARKER} test must enter the production launch handler`);
    const emitted = result.content.map((item) => item.text).join('\n');
    const expected = `Notice: This researcher uses your normal ${provider} provider home. Settings and session history are shared with your own ${provider} environment.`;
    assert.equal(emitted.split(expected).length - 1, 1, `${MARKER} shared-home notice must be emitted exactly once`);
    assert.doesNotMatch(emitted, BANNED_RESEARCHER_WORDS, `${MARKER} launch result uses banned researcher posture language`);
  });
}

test('production launch_agent result does not emit the researcher notice for a worker', async () => {
  const result = await orchestration.handleOrchestrationToolCall(
    'launch_agent',
    { title: 'worker', provider: 'codex' },
    async () => ({ id: 'worker-id', title: 'worker', workspaceId: 'workspace-1', provider: 'codex', status: 'launching' }),
  );
  assert.doesNotMatch(
    result.content.map((item) => item.text).join('\n'),
    /Notice: This researcher uses your normal/,
    `${MARKER} worker launch must not receive researcher notice`,
  );
});

test('live posture files distinguish the surviving working directory from the deleted HOME redirect', () => {
  const files = ['SECURITY.md', '.lares/supervisor/CLAUDE.md', '.lares/research/README.md', 'CLAUDE.md', 'AGENTS.md'];
  for (const relative of files) {
    const prose = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(prose, /\.lares\/researcher\/<provider>\//, `${MARKER} ${relative} must name the surviving provider working directory`);
    assert.match(prose, /\.lares\/agent-homes\/<agent-id>\//, `${MARKER} ${relative} must name the deleted per-agent HOME redirect`);
    assert.doesNotMatch(prose, /Codex (?:uses|has).*PreToolUse.*deny/i, `${MARKER} ${relative} repeats the false Codex-deny claim`);
  }
});
