import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHECK_IDS, CHECK_NAMES, SENTINELS } from './monitor.mjs';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(harnessDir, '..', '..');
const relativeDocuments = [
  'scripts/vm-acceptance/prompts/00-supervisor-kickoff.md',
  'scripts/vm-acceptance/prompts/10-worker-fix-bug.md',
  'scripts/vm-acceptance/prompts/11-worker-turn2.md',
  'scripts/vm-acceptance/README.md',
];
const documents = new Map(relativeDocuments.map((relativePath) => [
  relativePath,
  fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8'),
]));
const combined = [...documents.values()].join('\n');

test('prompt and README sentinel references match every monitor export', () => {
  const exported = new Set(Object.values(SENTINELS));
  for (const sentinel of exported) {
    assert.match(combined, new RegExp(`\\b${sentinel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`),
      `missing exported sentinel reference: ${sentinel}`);
  }

  const sentinelLike = new Set(combined.match(/\b(?:READY|BROWSER_OPENED|COMMENT_[A-Z_]+|DONE|(?:control|baseline|report|monitor\.(?:stdout|stderr))\.(?:json|txt|log))\b/g) ?? []);
  assert.deepEqual([...sentinelLike].sort(), [...exported].sort());
});

test('README check numbers, ids, and names exactly match monitor exports', () => {
  const readme = documents.get('scripts/vm-acceptance/README.md');
  const rows = [...readme.matchAll(/^\| Check (\d+) \(`([^`]+)`, ([^)]+)\) \|/gm)]
    .map((match) => ({ number: Number(match[1]), id: match[2], name: match[3] }));
  assert.deepEqual(rows, CHECK_IDS.map((id, index) => ({
    number: index + 1,
    id,
    name: CHECK_NAMES[id],
  })));

  const referencedNumbers = [...new Set([...readme.matchAll(/\bCheck (\d+)\b/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
  assert.deepEqual(referencedNumbers, CHECK_IDS.map((_, index) => index + 1));
});

test('README repository paths all exist on disk', () => {
  const readme = documents.get('scripts/vm-acceptance/README.md');
  const references = [...new Set([...readme.matchAll(/`((?:scripts|docs)\/[A-Za-z0-9_./-]+)`/g)].map((match) => match[1]))];
  assert.ok(references.length >= 6, 'expected the README file inventory and launch references');
  for (const reference of references) {
    assert.equal(fs.existsSync(path.join(repoRoot, ...reference.split('/'))), true, `missing README path: ${reference}`);
  }
});

test('kickoff uses only the allowed supervisor MCP tool names', () => {
  const kickoff = documents.get('scripts/vm-acceptance/prompts/00-supervisor-kickoff.md');
  const allowed = new Set([
    'get_my_context', 'launch_agent', 'send_message_to_agent', 'read_agent_chat',
    'read_comments', 'browser_open_url', 'run_orchestration',
    'read_plan_progress', 'list_plans',
  ]);
  for (const name of allowed) assert.match(kickoff, new RegExp(`\\b${name}\\b`));
  assert.match(kickoff, /Never call\s+`implement_plan`/);
  assert.equal((kickoff.match(/`implement_plan`/g) ?? []).length, 1);
});

test('worker prompts require absolute substitutions and the two distinct turns', () => {
  const turn1 = documents.get('scripts/vm-acceptance/prompts/10-worker-fix-bug.md');
  const turn2 = documents.get('scripts/vm-acceptance/prompts/11-worker-turn2.md');
  assert.match(turn1, /node --test "\{\{REPO_ROOT_ABS\}\}\/src\/index\.test\.js"/);
  assert.equal((turn1.match(/node --test/g) ?? []).length, 2);
  assert.match(turn1, /\{\{RUN_DIR_ABS\}\}\/turn1-red\.txt/);
  assert.match(turn1, /\{\{RUN_DIR_ABS\}\}\/turn1-green\.txt/);
  assert.match(turn1, /\{\{REPO_ROOT_ABS\}\}\/generated\/\{\{RUN_ID\}\}\.txt/);
  assert.match(turn2, /\{\{REPO_ROOT_ABS\}\}\/CHANGELOG\.md/);
  assert.match(turn2, /VM acceptance \{\{RUN_ID\}\}/);
  assert.match(`${turn1}\n${turn2}`, /Never (?:use|derive)[^\n]*current working directory/);
});
