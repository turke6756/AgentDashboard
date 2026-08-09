#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const GATE = 'LARES_PROGRESSIVE_INGESTION_HARNESS';
const CARD_MAX_BYTES = 2 * 1024;
const SUMMARY_MAX_BYTES = 2 * 1024;
const ARC_MAX_BYTES = 8 * 1024;
const SLICE_MAX_BYTES = 8 * 1024;
const HARNESS_PATH = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    result[key] = next && !next.startsWith('--') ? argv[++i] : true;
  }
  return result;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runFixtureMcp(args) {
  const fixture = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'progressive-ingestion-fixture', version: '1.0.0' },
      } });
    } else if (method === 'notifications/initialized') {
      // Notification: no response.
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [{
        name: 'read_plan_progress',
        description: 'Read the bounded fixture plan projection.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['planId', 'detail'],
          properties: {
            planId: { type: 'string' },
            detail: { type: 'string', enum: ['card', 'packages'] },
          },
        },
      }] } });
    } else if (method === 'tools/call') {
      const call = { name: params?.name, arguments: params?.arguments ?? {} };
      fs.appendFileSync(args.log, `${JSON.stringify(call)}\n`, 'utf8');
      if (call.name !== 'read_plan_progress' || call.arguments.planId !== fixture.planId
          || !['card', 'packages'].includes(call.arguments.detail)) {
        send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'invalid fixture tool call' }] } });
      } else {
        const value = fixture[call.arguments.detail];
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
      }
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args['fixture-mcp']) {
  await runFixtureMcp(args);
  process.exit(0);
}

if (process.env[GATE] !== '1') {
  console.log(`progressive-ingestion harness gated off; set ${GATE}=1 to run the fresh-agent acceptance.`);
  process.exit(0);
}

function fixtureInspectScript() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
const dir = argv[argv.indexOf('--dir') + 1];
if (argv[0] !== 'inspect' || !argv.includes('--summary') || !dir) process.exit(2);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const planBody = fs.readFileSync(path.join(dir, 'plan.md'), 'utf8');
const ids = [...planBody.matchAll(/<!--PLAN-INTENT\\s*([\\s\\S]*?)-->/g)].flatMap((match) => {
  try { const row = JSON.parse(match[1].trim()); return typeof row.intent_id === 'string' ? [row.intent_id] : []; }
  catch { return []; }
});
let latest = null;
for (const event of manifest.lifecycle_events ?? []) if (latest === null || event.at >= latest.at) latest = event;
let owner = null;
for (const event of manifest.responsibility_events ?? []) if (event.event === 'assigned') owner = event;
const out = { artifact_id: manifest.plan_artifact_id ?? null, title: manifest.title ?? null,
  source_proposal: manifest.source_proposal ?? null, latest_lifecycle_event: latest, current_owner: owner,
  intent_ids: ids.slice(0, 20), intents_omitted: Math.max(0, ids.length - Math.min(ids.length, 20)),
  counts: { intents: ids.length, lifecycle_events: (manifest.lifecycle_events ?? []).length,
    responsibility_events: (manifest.responsibility_events ?? []).length } };
let text = JSON.stringify(out) + '\\n';
while (Buffer.byteLength(text, 'utf8') > 2048 && out.intent_ids.length) {
  out.intent_ids.pop(); out.intents_omitted = ids.length - out.intent_ids.length; text = JSON.stringify(out) + '\\n';
}
if (Buffer.byteLength(text, 'utf8') > 2048) process.exit(2);
process.stdout.write(text);
`;
}

function sliceScript() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const file = argv[argv.indexOf('--file') + 1];
const anchor = argv[argv.indexOf('--anchor') + 1];
const body = fs.readFileSync(file, 'utf8');
const marker = '<a id="' + anchor + '"></a>';
const start = body.indexOf(marker);
if (start < 0) process.exit(2);
const after = start + marker.length;
const candidates = [body.indexOf('\\n<a id="', after), body.indexOf('\\n## ', after)].filter((n) => n >= 0);
const end = candidates.length ? Math.min(...candidates) : body.length;
const section = body.slice(start, end).trim() + '\\n';
const bytes = Buffer.from(section, 'utf8');
const truncated = bytes.length > 8192;
let content = section;
if (truncated) {
  let cut = 8192; while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  content = bytes.subarray(0, cut).toString('utf8');
}
process.stdout.write(JSON.stringify({ content, bytes: Buffer.byteLength(content, 'utf8'), truncated,
  continuation_required: truncated }) + '\\n');
`;
}

function headingsScript() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
const file = argv[argv.indexOf('--file') + 1];
const headings = fs.readFileSync(file, 'utf8').split(/\\r?\\n/).filter((line) => /^## Deliberation writebacks/u.test(line));
process.stdout.write(JSON.stringify({ headings }) + '\\n');
`;
}

function createFixtures() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-ingestion-agent-'));
  const pristine = path.join(root, 'fixtures', 'pristine', 'fixture-plan');
  const mutated = path.join(root, 'fixtures', 'mutated', 'fixture-plan');
  const bin = path.join(root, 'bin');
  const planBody = [
    '---',
    'artifact_id: plan_fixture_progressive',
    '---',
    '# Progressive-ingestion fixture',
    '<!--PLAN-INTENT {"intent_id":"int_7c41d9a2"} -->',
    '## Deliberation writebacks — int_7c41d9a2',
    'The body is intentionally not a Stage-1 source.',
    '',
  ].join('\n');
  const manifest = {
    schema_version: 2,
    plan_artifact_id: 'plan_fixture_progressive',
    source_proposal: { artifact_id: 'prop_fixture', rel_path: '.lares/proposals/fixture.md' },
    lifecycle_events: [{ event_id: 'life-1', kind: 'implementation_started', at: 100 }],
    responsibility_events: [{ event_id: 'owner-1', event: 'assigned', agent_id: 'fixture-owner', display: 'Fixture Supervisor', at: 100 }],
  };
  const arc = [
    '# ARC — Fixture planning experience overhaul',
    '<!--ARC-META {"source_cutoffs":{"folder_mtime_ms":1,"ledger_updated_at":null}} -->',
    '## Decisions',
    '- Replace the review tab with a progress checklist. deliberations/review-tab.md#review-tab-decision',
    '## Work packages',
    '- Rollup: 0/2 complete; offline roster unverifiable — see read_plan_progress.',
    '- WP-14 blocked. plan.md#deliberation-writebacks--int_7c41d9a2',
    '- WP-15 executing. plan.md#deliberation-writebacks--int_7c41d9a2',
    '## Deliberations',
    '- int_7c41d9a2 · open · folded-in · deliberations/review-tab.md#review-tab-decision · review-tab choice.',
    '## Who did what',
    '- Fixture Supervisor recorded the decision. deliberations/review-tab.md#review-tab-decision',
    '',
  ].join('\n');
  const deliberation = [
    '# Review-tab decision',
    '## Context',
    'This unrelated section is outside the slice.',
    '## Review tab decision',
    '<a id="review-tab-decision"></a>',
    'The review tab was replaced rather than removed because progress needed to be the default human-facing view,',
    'while the existing detailed diff and review capability still had value and therefore remained behind an advanced affordance.',
    '## Other issue',
    'This must not enter the requested section slice.',
    '',
  ].join('\n');
  for (const dir of [pristine, mutated]) {
    write(path.join(dir, 'plan.md'), planBody);
    write(path.join(dir, 'plan.json'), JSON.stringify(manifest, null, 2) + '\n');
    write(path.join(dir, 'deliberations', 'review-tab.md'), deliberation);
  }
  write(path.join(pristine, 'ARC.md'), arc);
  write(path.join(bin, 'plan-manifest.mjs'), fixtureInspectScript());
  write(path.join(bin, 'slice-section.mjs'), sliceScript());
  write(path.join(bin, 'writeback-headings.mjs'), headingsScript());
  const card = {
    planId: 'fixture-plan',
    planArtifactId: 'plan_fixture_progressive',
    title: 'Fixture planning experience overhaul',
    badge: 'executing',
    latestLifecycleKind: 'implementation_started',
    complete: false,
    owner: { display: 'Fixture Supervisor', agentId: 'fixture-owner' },
    activityTier: 'idle',
    rollup: { total: 2, landed: 0, remaining: 2, archived: 0, completed: false },
  };
  const packages = {
    rollup: { total: 2, landed: 0, remaining: 2, archived: 0, completed: false },
    packages: [
      { id: 'WP-14', title: 'Progressive read ladder', state: 'blocked' },
      { id: 'WP-15', title: 'Progressive-ingestion acceptance harness', state: 'executing' },
    ],
    packages_omitted: 0,
    packages_omitted_by_state: { blocked: 0, executing: 0, ready: 0, done: 0, archived: 0 },
    db_snapshot_version: 'fixture:1',
  };
  const mcpFixture = path.join(root, 'mcp-fixture.json');
  write(mcpFixture, JSON.stringify({ planId: 'fixture-plan', card, packages }, null, 2));
  return { root, pristine, mutated, bin, mcpFixture, card, packages, arc };
}

const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const rollupSchema = objectSchema({
  total: { type: 'integer' }, landed: { type: 'integer' }, remaining: { type: 'integer' },
  archived: { type: 'integer' }, completed: { type: 'boolean' },
});
const packageSchema = objectSchema({ id: string, title: string, state: string });
const omissionsSchema = objectSchema({
  blocked: { type: 'integer' }, executing: { type: 'integer' }, ready: { type: 'integer' },
  done: { type: 'integer' }, archived: { type: 'integer' },
});
const schemas = {
  q0: objectSchema({ title: nullableString, badge: string, complete: { type: ['boolean', 'null'] }, owner: nullableString, activityTier: string }),
  q1: objectSchema({
    latestDecisions: { type: 'array', items: string },
    openIntents: { type: 'array', items: objectSchema({ id: string, foldStatus: string, ref: string }) },
    intentsOmitted: { type: 'integer' }, rollup: rollupSchema,
    blockedOrExecutingPackages: { type: 'array', items: packageSchema },
    packagesOmittedByState: omissionsSchema, arcFreshness: string,
  }),
  q2: objectSchema({ answer: string }),
  mutated: objectSchema({
    latestDecisions: { type: 'array', items: string },
    openIntents: { type: 'array', items: objectSchema({ id: string, foldStatus: string, ref: string }) },
    intentsOmitted: { type: 'integer' }, rollup: rollupSchema,
    blockedOrExecutingPackages: { type: 'array', items: packageSchema },
    packagesOmittedByState: omissionsSchema, arcFreshness: string, disclosure: string,
  }),
};

function parseJsonLines(text) {
  return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseAnswer(text) {
  const trimmed = text.trim().replace(/^```json\s*/u, '').replace(/\s*```$/u, '');
  return JSON.parse(trimmed);
}

function codexInvocation() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmEntry = path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(npmEntry)) return { command: process.execPath, prefix: [npmEntry] };
  }
  return { command: 'codex', prefix: [] };
}

function runAgent(fixtures, name, prompt, schema) {
  const runDir = path.join(fixtures.root, 'runs', name);
  fs.mkdirSync(runDir, { recursive: true });
  const schemaPath = path.join(runDir, 'schema.json');
  const answerPath = path.join(runDir, 'answer.json');
  const tracePath = path.join(runDir, 'events.jsonl');
  const mcpLog = path.join(runDir, 'mcp-calls.jsonl');
  write(schemaPath, JSON.stringify(schema, null, 2));
  write(mcpLog, '');
  const mcpArgs = [HARNESS_PATH, '--fixture-mcp', '--fixture', fixtures.mcpFixture, '--log', mcpLog];
  const cliArgs = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--cd', runDir, '--output-schema', schemaPath, '--output-last-message', answerPath,
    '-c', `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.fixture.args=${JSON.stringify(mcpArgs)}`,
    '-c', 'approval_policy="never"',
    prompt,
  ];
  const invocation = codexInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefix, ...cliArgs], {
    cwd: runDir,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  write(tracePath, result.stdout ?? '');
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`).trim();
    const blocked = /quota|rate.?limit|authentication|not logged in|timed? ?out|timeout|model.*unavailable|connection/iu.test(detail);
    return { name, blocked, error: detail, status: result.status, commands: [], mcpCalls: [], tokens: null };
  }
  const events = parseJsonLines(result.stdout);
  const diagnostics = events.flatMap((event) => {
    if (event.type === 'error') return [event.message ?? JSON.stringify(event)];
    if (event.item?.type === 'mcp_tool_call' && (event.item.error || event.item.status === 'failed')) {
      return [event.item.error?.message ?? event.item.error ?? JSON.stringify(event.item)];
    }
    if (event.item?.type === 'command_execution' && event.item.status === 'failed') {
      return [`command failed: ${event.item.command ?? '(unknown command)'}`];
    }
    return [];
  });
  const commands = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
    .map((event) => event.item.command ?? '');
  const usage = events.filter((event) => event.type === 'turn.completed').at(-1)?.usage ?? null;
  const tokens = usage && Number.isFinite(usage.input_tokens) ? {
    input: usage.input_tokens,
    cachedInput: usage.cached_input_tokens ?? null,
    output: usage.output_tokens ?? null,
  } : null;
  const mcpCalls = parseJsonLines(fs.readFileSync(mcpLog, 'utf8'));
  try {
    return { name, answer: parseAnswer(fs.readFileSync(answerPath, 'utf8')), commands, mcpCalls, diagnostics, tokens, status: 0 };
  } catch (error) {
    return { name, error: `final answer was not schema JSON: ${error.message}`, commands, mcpCalls, diagnostics, tokens, status: 0 };
  }
}

function same(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
}

function callsAre(calls, detail) {
  return calls.length === 1 && calls[0].name === 'read_plan_progress'
    && calls[0].arguments?.planId === 'fixture-plan' && calls[0].arguments?.detail === detail;
}

function noForbiddenTreeRead(commands) {
  const joined = commands.join('\n');
  return !/(Get-ChildItem|\bdir\b|\btree\b|rg\s+--files|\bls\b|find\s+)/iu.test(joined);
}

function boundaryVerdict(run) {
  if (run.name === 'q0') {
    return { passed: callsAre(run.mcpCalls, 'card') && run.commands.length === 0, detail: 'one card tool call; zero filesystem commands' };
  }
  const joined = run.commands.join('\n');
  if (run.name === 'q1') {
    const everyCommandNamed = run.commands.every((command) => /ARC\.md|plan-manifest\.mjs/iu.test(command));
    const passed = callsAre(run.mcpCalls, 'packages') && noForbiddenTreeRead(run.commands)
      && !/plan\.md|deliberations[\\/]/iu.test(joined)
      && everyCommandNamed && /ARC\.md/iu.test(joined) && /plan-manifest\.mjs/iu.test(joined) && /--summary/iu.test(joined);
    return { passed, detail: 'only ARC, inspect --summary, and packages; no plan.md/deliberation/tree read' };
  }
  if (run.name === 'q2') {
    const sliceCommands = run.commands.filter((command) => /slice-section\.mjs/iu.test(command));
    const passed = run.mcpCalls.length === 0 && noForbiddenTreeRead(run.commands) && run.commands.length === 1 && sliceCommands.length === 1
      && /review-tab\.md/iu.test(sliceCommands[0]) && /review-tab-decision/iu.test(sliceCommands[0])
      && !run.commands.some((command) => /Get-Content|type\s|\bcat\b/iu.test(command));
    return { passed, detail: 'exactly one named anchor slice; no direct markdown or tree read' };
  }
  const everyCommandNamed = run.commands.every((command) => /plan-manifest\.mjs|writeback-headings\.mjs/iu.test(command));
  const passed = callsAre(run.mcpCalls, 'packages') && noForbiddenTreeRead(run.commands) && everyCommandNamed
    && /plan-manifest\.mjs/iu.test(joined) && /writeback-headings\.mjs/iu.test(joined)
    && !/deliberations[\\/]/iu.test(joined) && !run.commands.some((command) => /Get-Content|type\s|\bcat\b/iu.test(command));
  return { passed, detail: 'ARC absent; summary + headings-only + packages; no full-tree/direct markdown read' };
}

function validateAnswers(runs, fixtures) {
  same(runs.q0.answer, {
    title: fixtures.card.title, badge: 'executing', complete: false,
    owner: 'Fixture Supervisor', activityTier: 'idle',
  }, 'Q0');
  const stage1 = {
    latestDecisions: ['Replace the review tab with a progress checklist.'],
    openIntents: [{ id: 'int_7c41d9a2', foldStatus: 'folded-in', ref: 'deliberations/review-tab.md#review-tab-decision' }],
    intentsOmitted: 0,
    rollup: fixtures.packages.rollup,
    blockedOrExecutingPackages: fixtures.packages.packages,
    packagesOmittedByState: fixtures.packages.packages_omitted_by_state,
    arcFreshness: 'unverifiable — see read_plan_progress',
  };
  same(runs.q1.answer, stage1, 'Q1');
  const q2 = runs.q2.answer.answer.toLocaleLowerCase('en-US');
  if (!q2.includes('replac') || !q2.includes('progress') || !q2.includes('advanced') || !q2.includes('review')) {
    fail(`Q2 did not match the answer key: ${runs.q2.answer.answer}`);
  }
  same(runs.mutated.answer, {
    latestDecisions: ['unknown'],
    openIntents: [{ id: 'int_7c41d9a2', foldStatus: 'unknown', ref: 'unknown' }],
    intentsOmitted: 0,
    rollup: fixtures.packages.rollup,
    blockedOrExecutingPackages: fixtures.packages.packages,
    packagesOmittedByState: fixtures.packages.packages_omitted_by_state,
    arcFreshness: 'unknown',
    disclosure: 'ARC absent; index from headings; decision spine and ARC freshness unknown',
  }, 'mutated Q1');
}

function transcript(fixtures, runs, boundaries, verdict, errors = []) {
  const lines = [
    '# WP-15 Layer-B progressive-ingestion transcript', '',
    `- Run at: ${new Date().toISOString()}`,
    `- Fixture root: \`${fixtures.root}\``,
    `- Pristine plan: \`${fixtures.pristine}\``,
    `- Mutated plan (ARC absent): \`${fixtures.mutated}\``,
    `- Overall verdict: **${verdict ? 'PASS' : 'FAIL'}**`, '',
    '## Layer-A byte oracles rechecked by the harness', '',
    `- Card: ${jsonBytes(fixtures.card)} / ${CARD_MAX_BYTES} bytes — ${jsonBytes(fixtures.card) <= CARD_MAX_BYTES ? 'PASS' : 'FAIL'}`,
    `- ARC.md: ${Buffer.byteLength(fixtures.arc, 'utf8')} / ${ARC_MAX_BYTES} bytes — ${Buffer.byteLength(fixtures.arc, 'utf8') <= ARC_MAX_BYTES ? 'PASS' : 'FAIL'}`,
    `- inspect --summary: ${fixtures.summaryBytes} / ${SUMMARY_MAX_BYTES} bytes — ${fixtures.summaryBytes <= SUMMARY_MAX_BYTES ? 'PASS' : 'FAIL'}`,
    `- Stage-2 slice: ${fixtures.sliceBytes} / ${SLICE_MAX_BYTES} bytes — ${fixtures.sliceBytes <= SLICE_MAX_BYTES ? 'PASS' : 'FAIL'}`,
    '', '## Fresh-agent stages', '',
  ];
  const questions = {
    q0: 'Q0: What are the title, badge, completion state, owner, and activity tier?',
    q1: 'Q1: What are the latest decisions, open intents, live rollup, blocked/executing packages, omissions, and ARC freshness?',
    q2: 'Q2: Why was the review tab replaced rather than removed?',
    mutated: 'Degraded Q1 with ARC.md absent: preserve supported answers and disclose every unknown.',
  };
  for (const name of ['q0', 'q1', 'q2', 'mutated']) {
    const run = runs[name];
    lines.push(`### ${name}`, '', questions[name], '', `Agent answer: \`${JSON.stringify(run.answer)}\``, '',
      `Tool trace: ${run.mcpCalls.length ? run.mcpCalls.map((call) => `\`${call.name}(${JSON.stringify(call.arguments)})\``).join(', ') : 'no MCP calls'}; ${run.commands.length} shell command(s).`,
      `CLI diagnostics: ${run.diagnostics?.length ? run.diagnostics.join(' | ') : 'none emitted'}`,
      `Boundary verdict: **${boundaries[name].passed ? 'PASS' : 'FAIL'}** — ${boundaries[name].detail}`,
      `Measured input tokens: ${run.tokens ? run.tokens.input : 'unavailable'}${run.tokens?.cachedInput != null ? ` (cached input: ${run.tokens.cachedInput})` : ''}`,
      `Answer-key verdict: **${run.answerPassed ? 'PASS' : 'FAIL'}**`, '');
  }
  lines.push('## §4 pass/fail', '',
    `- Answers, including explicit unknowns: **${Object.values(runs).every((run) => run.answerPassed) ? 'PASS' : 'FAIL'}**`,
    `- Actual input tokens recorded when available; byte ceilings remain independent oracle: **${fixtures.bytePass ? 'PASS' : 'FAIL'}**`,
    `- Stage tool-trace boundaries: **${Object.values(boundaries).every((item) => item.passed) ? 'PASS' : 'FAIL'}**`,
    `- Mutated fixture disclosure and no full-tree read: **${runs.mutated.answerPassed && boundaries.mutated.passed ? 'PASS' : 'FAIL'}**`);
  if (errors.length) lines.push('', '## Failures', '', ...errors.map((error) => `- ${error.replace(/\r?\n/gu, ' ')}`));
  return `${lines.join('\n')}\n`;
}

const fixtures = createFixtures();
let keepFixture = false;
try {
  const inspect = spawnSync(process.execPath, [path.join(fixtures.bin, 'plan-manifest.mjs'), 'inspect', '--summary', '--dir', fixtures.pristine], { encoding: 'utf8' });
  if (inspect.status !== 0) fail(`fixture inspect failed: ${inspect.stderr}`);
  fixtures.summaryBytes = Buffer.byteLength(inspect.stdout, 'utf8');
  const sliced = spawnSync(process.execPath, [path.join(fixtures.bin, 'slice-section.mjs'), '--file', path.join(fixtures.pristine, 'deliberations', 'review-tab.md'), '--anchor', 'review-tab-decision'], { encoding: 'utf8' });
  if (sliced.status !== 0) fail(`fixture slice failed: ${sliced.stderr}`);
  fixtures.sliceBytes = JSON.parse(sliced.stdout).bytes;
  fixtures.bytePass = jsonBytes(fixtures.card) <= CARD_MAX_BYTES
    && Buffer.byteLength(fixtures.arc, 'utf8') <= ARC_MAX_BYTES
    && fixtures.summaryBytes <= SUMMARY_MAX_BYTES && fixtures.sliceBytes <= SLICE_MAX_BYTES;
  if (!fixtures.bytePass) fail('fixture violates a deterministic byte ceiling');

  const base = 'You are a fresh acceptance agent. Obey the named stage boundary exactly. Do not list directories, inspect the tree, or read any source not explicitly named. Return only JSON matching the supplied schema. ';
  const runs = {};
  runs.q0 = runAgent(fixtures, 'q0', `${base}Stage 0 source is ONLY one MCP call to read_plan_progress with planId "fixture-plan" and detail "card"; run no shell commands. Q0: report title, badge, complete, owner (display string or null), and activityTier.`, schemas.q0);
  runs.q1 = runAgent(fixtures, 'q1', `${base}Stage 1 sources are ONLY: (1) read ${path.join(fixtures.pristine, 'ARC.md')}; (2) run node ${path.join(fixtures.bin, 'plan-manifest.mjs')} inspect --summary --dir ${fixtures.pristine}; (3) one MCP read_plan_progress call with planId "fixture-plan" and detail "packages". Never read plan.md or any deliberation. Use exact evidence strings. ARC ledger freshness null means arcFreshness exactly "unverifiable — see read_plan_progress". Q1: return the requested decision, intent, live rollup/package, omission, and freshness fields.`, schemas.q1);
  runs.q2 = runAgent(fixtures, 'q2', `${base}Stage 2 source is ONLY this single command: node ${path.join(fixtures.bin, 'slice-section.mjs')} --file ${path.join(fixtures.pristine, 'deliberations', 'review-tab.md')} --anchor review-tab-decision. Run it exactly once; do not directly read that file or any other file. Q2: why was the review tab replaced rather than removed?`, schemas.q2);
  runs.mutated = runAgent(fixtures, 'mutated', `${base}Degraded Stage 1: ARC.md is absent. Sources are ONLY: (1) run node ${path.join(fixtures.bin, 'plan-manifest.mjs')} inspect --summary --dir ${fixtures.mutated}; (2) run node ${path.join(fixtures.bin, 'writeback-headings.mjs')} --file ${path.join(fixtures.mutated, 'plan.md')}; (3) one MCP read_plan_progress call with planId "fixture-plan" and detail "packages". Do not directly read plan.md or any deliberation. Preserve supported package answers. Set latestDecisions to ["unknown"], the indexed intent foldStatus/ref to "unknown", arcFreshness to "unknown", and disclosure exactly "ARC absent; index from headings; decision spine and ARC freshness unknown".`, schemas.mutated);

  const blocked = Object.values(runs).find((run) => run.blocked);
  if (blocked) {
    keepFixture = true;
    console.error(`Layer-B blocked during ${blocked.name}: ${blocked.error}`);
    console.error(`No transcript was written. Diagnostic fixture retained at ${fixtures.root}`);
    process.exitCode = 2;
  } else {
    const operationalError = Object.values(runs).find((run) => run.error);
    const errors = operationalError ? [`${operationalError.name}: ${operationalError.error}`] : [];
    for (const run of Object.values(runs)) run.answerPassed = false;
    if (!operationalError) {
      try {
        validateAnswers(runs, fixtures);
        for (const run of Object.values(runs)) run.answerPassed = true;
      } catch (error) {
        errors.push(error.message);
        // Mark independently where possible for a useful transcript.
        for (const name of Object.keys(runs)) {
          try {
            validateAnswers({ ...runs, q0: name === 'q0' ? runs.q0 : runs.q0, q1: runs.q1, q2: runs.q2, mutated: runs.mutated }, fixtures);
            runs[name].answerPassed = true;
          } catch { /* aggregate validator already recorded the mismatch */ }
        }
      }
    }
    const boundaries = Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, boundaryVerdict(run)]));
    for (const [name, result] of Object.entries(boundaries)) if (!result.passed) errors.push(`${name} boundary: ${result.detail}`);
    const verdict = errors.length === 0 && fixtures.bytePass;
    const body = transcript(fixtures, runs, boundaries, verdict, errors);
    if (typeof args.transcript === 'string') write(path.resolve(args.transcript), body);
    process.stdout.write(body);
    process.exitCode = verdict ? 0 : 1;
  }
} catch (error) {
  keepFixture = true;
  console.error(`Layer-B harness error: ${error.stack ?? error.message}`);
  console.error(`No transcript was written. Diagnostic fixture retained at ${fixtures.root}`);
  process.exitCode = 2;
} finally {
  if (!keepFixture) fs.rmSync(fixtures.root, { recursive: true, force: true });
}
