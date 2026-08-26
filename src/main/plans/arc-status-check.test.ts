import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkArcAgainstLedger } from './arc-status-check';
import type { MissionBoardPackageState } from '../../shared/types';

const states = new Map<string, MissionBoardPackageState>([
  ['WP-1', 'done'], ['WP-2', 'executing'],
]);

async function run(content: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-status-'));
  const arcPath = path.join(root, 'ARC.md');
  fs.writeFileSync(arcPath, content);
  const beforeBytes = fs.readFileSync(arcPath);
  const before = fs.statSync(arcPath);
  const result = await checkArcAgainstLedger('plan', arcPath, states);
  const after = fs.statSync(arcPath);
  assert.deepEqual(fs.readFileSync(arcPath), beforeBytes, 'ARC bytes are read-only');
  assert.equal(after.mtimeMs, before.mtimeMs, 'ARC mtime is read-only');
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test('missing exact roster emits one plan-level not-declared finding and ignores prose', async () => {
  const result = await run('## Work packages\n- WP-1 LANDED\n\nWP-2 is executing.\n');
  assert.deepEqual(result.arcFindings, [{ kind: 'arc-status-not-declared' }]);
  assert.equal(result.packageFindings.size, 0);
});

test('present malformed roster emits one plan-level unparseable finding', async () => {
  const result = await run('## Package status\n\n| Package | Result |\n| --- | --- |\n| WP-1 | done |\n');
  assert.deepEqual(result.arcFindings, [{ kind: 'arc-status-unparseable' }]);
  assert.equal(result.packageFindings.size, 0);
});

test('matching exact WP and State rows produce no findings', async () => {
  const result = await run('## Package status\n\n| WP | State |\n| --- | --- |\n| WP-1 | done |\n| WP-2 | executing |\n');
  assert.deepEqual(result.arcFindings, []);
  assert.equal(result.packageFindings.size, 0);
});

test('duplicate is the sole mechanism for arc-row-duplicate', async () => {
  // Both claims match the ledger; only duplication can produce this finding.
  const result = await run('## Package status\n| WP | State |\n| --- | --- |\n| WP-1 | done |\n| WP-1 | done |\n');
  assert.deepEqual(result.packageFindings.get('WP-1'), [{ kind: 'arc-row-duplicate', wpId: 'WP-1' }]);
});

test('state disagreement is the sole mechanism for arc-contradicts-ledger', async () => {
  // The row is unique, well-formed, and names a real WP; only its state differs.
  const result = await run('## Package status\n| WP | State |\n| --- | --- |\n| WP-2 | done |\n');
  assert.deepEqual(result.packageFindings.get('WP-2'), [{
    kind: 'arc-contradicts-ledger', wpId: 'WP-2', arcClaim: 'done', ledgerState: 'executing',
  }]);
});

