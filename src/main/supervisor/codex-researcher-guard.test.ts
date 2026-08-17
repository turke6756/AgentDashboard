import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { GUARD_GIT_DISCARD_MJS } from '../../shared/constants';

const RESEARCHER_CWD = 'C:\\workspace\\.lares\\researcher\\codex';

function runHook(payload: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-researcher-hook-'));
  const hook = path.join(dir, 'guard.mjs');
  fs.writeFileSync(hook, GUARD_GIT_DISCARD_MJS, 'utf8');
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
  });
}

function assertCodexAllow(result: ReturnType<typeof runHook>) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '', 'allowed Codex tool payload must not receive a deny response');
  assert.equal(result.stderr, '');
}

function assertCodexDeny(result: ReturnType<typeof runHook>) {
  assert.notEqual(result.stdout, '', 'REACHABILITY:codex-researcher-git-discard-deny');
  assert.equal(result.status, 0, 'Codex deny must exit 0, otherwise Codex fails open');
  assert.equal(result.stderr, '', 'Codex deny must not add stderr');
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /discards uncommitted work/);
}

test('Codex researcher apply_patch payload is not denied by the shared guard', () => {
  const result = runHook({
    turn_id: 'turn-edit', model: 'codex', cwd: RESEARCHER_CWD,
    tool_name: 'apply_patch', tool_input: {
      patch: '*** Begin Patch\\n*** Add File: report.md\\n+report\\n*** End Patch',
    },
  });
  assertCodexAllow(result);
});

test('Codex researcher shell_command payload is not denied when it is not a git discard', () => {
  const result = runHook({
    turn_id: 'turn-shell', model: 'codex', cwd: RESEARCHER_CWD,
    tool_name: 'shell_command', tool_input: { command: 'node -e "console.log(1)"', workdir: RESEARCHER_CWD },
  });
  assertCodexAllow(result);
});

test('Codex researcher git-discard command is still denied by the shared guard', () => {
  const result = runHook({
    turn_id: 'turn-discard', model: 'codex', cwd: RESEARCHER_CWD,
    tool_name: 'shell_command', tool_input: { command: 'git reset --hard', workdir: RESEARCHER_CWD },
  });
  assertCodexDeny(result);
});
