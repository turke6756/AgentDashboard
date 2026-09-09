#!/usr/bin/env node

/**
 * Test wrapper for scripts/check-edr-patterns.mjs (P0.3, plans/edr-safety-hardening.md).
 *
 * Two layers:
 *  1) --self-test — the script's built-in fixture suite: builds a temp tree with
 *     known-bad files (a .vbs, wscript/-WindowStyle Hidden/-EncodedCommand/
 *     powershell.exe-spawn lines, unlisted Tier-2 flags, a test-file Tier-2
 *     exemption that retains Tier-1 scanning, hidden dot-dir hits, and excluded
 *     node_modules/docs-internal/__fixtures__ decoys) and asserts each is
 *     flagged / skipped / allowlisted correctly.
 *  2) Real-tree lint — asserts the current repo passes clean, so a pattern
 *     regression or an un-allowlisted spawn flag fails the main test run.
 *
 * Run: node scripts/check-edr-patterns.test.js
 */

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, 'check-edr-patterns.mjs');
const packagedScripts = require('./packaged-scripts-allowlist.json').files
  .map((file) => `scripts/${file}`);

let failed = 0;
function run(name, args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
  if (res.status === 0) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`  FAIL ${name} (exit ${res.status})`);
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    failed++;
  }
}

run('self-test fixtures pass', ['--self-test']);
run('release surface lints clean', ['--paths', 'src', 'docs', 'package.json', ...packagedScripts]);

if (failed > 0) {
  console.error(`check-edr-patterns.test: FAIL (${failed})`);
  process.exit(1);
}
console.log('check-edr-patterns.test: OK');
