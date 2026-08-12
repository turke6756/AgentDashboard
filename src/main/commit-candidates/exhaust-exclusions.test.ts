import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SUGGESTED_GITIGNORE_RULES,
  acceptGitignoreSuggestion,
  GITIGNORE_SUGGESTION_CHANNELS,
  onGitignoreSuggestion,
  registerGitignoreSuggestionIpc,
  suggestGitignoreAdditions,
} from './exhaust-exclusions';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function fixture(content?: string): { root: string; gitignore: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-exhaust-exclusions-'));
  const gitignore = path.join(root, '.gitignore');
  if (content !== undefined) fs.writeFileSync(gitignore, content, 'utf8');
  return { root, gitignore, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('workspace-open seam emits exactly the missing rules and does not auto-apply', () => {
  const covered = SUGGESTED_GITIGNORE_RULES.slice(0, 3);
  const f = fixture(`# existing\r\n${covered.join('\r\n')}\r\n`);
  const observed: unknown[] = [];
  const unsubscribe = onGitignoreSuggestion((event) => observed.push(event));
  try {
    const before = fs.readFileSync(f.gitignore, 'utf8');
    const suggestion = suggestGitignoreAdditions(f.root);
    const expected = SUGGESTED_GITIGNORE_RULES.slice(3);
    assert.ok(suggestion);
    assert.deepEqual(suggestion.missingRules, expected);
    assert.equal(observed.length, 1, 'REACHABILITY:exhaust-exclusions workspace-open must enter the suggestion seam');
    assert.equal(observed[0], suggestion);
    assert.equal(fs.readFileSync(f.gitignore, 'utf8'), before, 'ask-first must never auto-apply');
  } finally {
    unsubscribe();
    f.cleanup();
  }
});

test('acceptance appends only still-missing suggested rules and preserves CRLF', () => {
  const f = fixture(`${SUGGESTED_GITIGNORE_RULES[0]}\r\n`);
  try {
    const suggestion = suggestGitignoreAdditions(f.root);
    assert.ok(suggestion);

    // Simulate another writer covering one suggestion before the user accepts.
    fs.appendFileSync(f.gitignore, `${suggestion.missingRules[0]}\r\n`, 'utf8');
    const accepted = acceptGitignoreSuggestion(suggestion);
    assert.deepEqual(accepted.appendedRules, suggestion.missingRules.slice(1));

    const content = fs.readFileSync(f.gitignore, 'utf8');
    assert.equal(content.replace(/\r\n/g, '').includes('\n'), false, 'line endings remain CRLF');
    for (const rule of SUGGESTED_GITIGNORE_RULES) {
      assert.equal(content.split(/\r?\n/u).filter((line) => line === rule).length, 1, `${rule} appears once`);
    }
  } finally { f.cleanup(); }
});

test('a workspace already covered stays silent', () => {
  const f = fixture(`${SUGGESTED_GITIGNORE_RULES.join('\n')}\n`);
  let emitted = false;
  const unsubscribe = onGitignoreSuggestion(() => { emitted = true; });
  try {
    assert.equal(suggestGitignoreAdditions(f.root), null);
    assert.equal(emitted, false);
  } finally {
    unsubscribe();
    f.cleanup();
  }
});

test('acceptance creates a missing .gitignore only after explicit acceptance', () => {
  const f = fixture();
  try {
    const suggestion = suggestGitignoreAdditions(f.root);
    assert.ok(suggestion);
    assert.equal(fs.existsSync(f.gitignore), false);
    const result = acceptGitignoreSuggestion(suggestion);
    assert.deepEqual(result.appendedRules, SUGGESTED_GITIGNORE_RULES);
    assert.equal(fs.readFileSync(f.gitignore, 'utf8'), `${SUGGESTED_GITIGNORE_RULES.join('\n')}\n`);
  } finally { f.cleanup(); }
});

test('production workspace-open and on-demand IPC enter the suggestion seam and acceptance', () => {
  const f = fixture(`${SUGGESTED_GITIGNORE_RULES[0]}\n`);
  const handlers = new Map<string, (_event: unknown, workspaceId: string) => unknown>();
  const sent: Array<{ channel: string; notice: { workspaceId: string; missingRules: readonly string[] } }> = [];
  try {
    const controller = registerGitignoreSuggestionIpc(
      { handle: (channel, listener) => { handlers.set(channel, listener); } },
      (channel, notice) => { sent.push({ channel, notice }); },
      (workspaceId) => workspaceId === 'ws-1' ? f.root : null,
    );

    controller.workspaceOpened('ws-1');
    assert.equal(sent.length, 1, 'REACHABILITY:exhaust-exclusions workspace-open must enter suggestGitignoreAdditions');
    assert.equal(sent[0].channel, GITIGNORE_SUGGESTION_CHANNELS.suggested);
    assert.deepEqual(sent[0].notice.missingRules, SUGGESTED_GITIGNORE_RULES.slice(1));
    assert.equal(fs.readFileSync(f.gitignore, 'utf8'), `${SUGGESTED_GITIGNORE_RULES[0]}\n`);

    const suggest = handlers.get(GITIGNORE_SUGGESTION_CHANNELS.suggest);
    const accept = handlers.get(GITIGNORE_SUGGESTION_CHANNELS.accept);
    assert.ok(suggest, 'production on-demand channel is registered');
    assert.ok(accept, 'production acceptance channel is registered');
    assert.ok(suggest({}, 'ws-1'));
    const result = accept({}, 'ws-1') as { accepted: boolean };
    assert.equal(result.accepted, true);
    assert.equal(suggest({}, 'ws-1'), null, 'covered workspace stays silent on demand');
  } finally { f.cleanup(); }
});

let failures = 0;
for (const current of tests) {
  try {
    current.run();
    console.log(`ok - ${current.name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${current.name}`);
    console.error(error);
  }
}
if (failures > 0) process.exitCode = 1;
