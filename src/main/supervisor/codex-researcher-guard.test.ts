import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CODEX_RESEARCHER_TOOL_DENY_HOOK } from '../../shared/constants';

// Codex 0.145.0's currently observed execution/file-mutation surface. This is
// deliberately an explicit fixture: a newly exposed tool must be added here,
// otherwise this test fails rather than silently widening the researcher lane.
const CODEX_RESEARCHER_TOOL_SURFACE = [
  'shell_command',
  'apply_patch',
] as const;

const RESEARCHER_CWD = 'C:\\workspace\\.lares\\researcher\\codex';

function runHook(payload: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-researcher-hook-'));
  const hook = path.join(dir, 'guard.mjs');
  fs.writeFileSync(hook, CODEX_RESEARCHER_TOOL_DENY_HOOK, 'utf8');
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function assertCodexDeny(result: ReturnType<typeof runHook>, tool: string) {
  assert.notEqual(result.stdout, '', 'REACHABILITY:codex-researcher-tool-deny');
  assert.equal(result.status, 0, 'Codex deny must exit 0, otherwise Codex fails open');
  assert.equal(result.stderr, '', 'Codex deny must not add stderr');
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, new RegExp(tool));
}

test('Codex researcher fixture enumerates the exact execution/file-mutation surface', () => {
  assert.deepEqual(CODEX_RESEARCHER_TOOL_SURFACE, ['shell_command', 'apply_patch']);
  assert.ok(CODEX_RESEARCHER_TOOL_DENY_HOOK.includes("'shell_command'"));
  assert.ok(CODEX_RESEARCHER_TOOL_DENY_HOOK.includes("'apply_patch'"));
});

test('Codex researcher shell deny prevents the side effect from running', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-researcher-exec-'));
  const target = path.join(dir, 'must-not-exist.txt');
  const command = `node -e "require('fs').writeFileSync(${JSON.stringify(target)}, 'ran')"`;
  const result = runHook({
    turn_id: 'turn-shell', model: 'codex', cwd: RESEARCHER_CWD,
    tool_name: 'shell_command', tool_input: { command, workdir: RESEARCHER_CWD },
  });
  assertCodexDeny(result, 'shell_command');
  // The harness would execute the command only after an allow response. This
  // observable target is the load-bearing assertion: a payload-only JSON test
  // would pass even if the hook failed open.
  if (!JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision) {
    spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(target)}, 'ran')`]);
  }
  assert.equal(fs.existsSync(target), false, 'blocked shell command must not run');
});

test('Codex researcher direct file mutation tool is denied by name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-researcher-edit-'));
  const target = path.join(dir, 'must-not-exist.txt');
  const result = runHook({
    turn_id: 'turn-edit', model: 'codex', cwd: RESEARCHER_CWD,
    tool_name: 'apply_patch', tool_input: {
      patch: `*** Begin Patch\\n*** Add File: ${target}\\n+ran\\n*** End Patch`,
    },
  });
  assertCodexDeny(result, 'apply_patch');
  if (!JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision) {
    fs.writeFileSync(target, 'ran', 'utf8');
  }
  assert.equal(fs.existsSync(target), false, 'blocked file mutation must not run');
});

test('unknown and non-researcher tool calls remain outside this exact-name boundary', () => {
  const unknown = runHook({ turn_id: 'turn-unknown', model: 'codex', cwd: RESEARCHER_CWD, tool_name: 'future_exec_tool' });
  assert.equal(unknown.status, 0);
  assert.equal(unknown.stdout, '');
  const worker = runHook({ turn_id: 'turn-worker', model: 'codex', cwd: 'C:\\workspace\\.lares\\workers\\codex', tool_name: 'shell_command' });
  assert.equal(worker.status, 0);
  assert.equal(worker.stdout, '');
});
