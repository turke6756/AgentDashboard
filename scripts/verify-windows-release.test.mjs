import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
const release = read('verify-windows-release.ps1');
const packaged = read('verify-windows-package.ps1');
const bundledNode = read('verify-bundled-node.ps1');
const bundledGit = read('verify-bundled-git.ps1');
const native = read('verify-native.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

test('canonical package entry is exact', () => {
  assert.equal(pkg.scripts['dist:win:release'], 'npm run dist:win && powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-release.ps1');
});

test('release gates are strict and ordered', () => {
  const needles = [
    'npm run verify:native -- --strict --package <win-unpacked>',
    'verify-windows-package.ps1\') -Strict',
    "ensureWorkerScaffold(workspace, 'codex', 'windows')",
    'verify-bundled-node.ps1\') -Strict -Workspace $workspace',
    'verify-bundled-git.ps1\') -PayloadDir $payloadDir',
    "scripts\\analytics-packaged-smoke.mjs') $exe --workspace $workspace --allow-cold --appdata $appData",
    'Get-FileHash -LiteralPath $installer -Algorithm SHA256',
  ];
  let at = -1;
  for (const needle of needles) {
    const next = release.indexOf(needle);
    assert.ok(next > at, `missing or out of order: ${needle}`);
    at = next;
  }
});

test('release gate propagates native exits, thrown errors, and missing exit codes', () => {
  for (const mode of ['NativeExit', 'ThrownError', 'NullExit']) {
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-windows-release.ps1'),
      '-TestGateFailure', mode,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, `${mode}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /FAIL/, `${mode}: ${result.stdout}`);
  }
});

test('release temp workspace uses the Lares sentinel and literal cleanup', () => {
  assert.match(release, /Join-Path \$env:TEMP \("lares-release-WP-B-"/);
  assert.match(release, /\.lares-scratch\.json/);
  assert.match(release, /Remove-Item -LiteralPath \$workspace -Recurse -Force/);
});

test('explicit bundled-Git payload bypasses discovery', () => {
  const discovery = bundledGit.match(/if \(-not \$PayloadDir\) \{([\s\S]*?)\n\}/);
  assert.ok(discovery, 'candidate discovery guard missing');
  assert.match(discovery[1], /\$candidates/);
  assert.ok(!bundledGit.slice(discovery.index + discovery[0].length).includes('$candidates |'), 'candidate selection escaped the explicit-path guard');
});

test('bundled-Git rejects an explicit missing payload even when a candidate exists', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-bundled-git-explicit-'));
  try {
    const candidate = path.join(fixture, 'third_party', 'git-for-windows', '.staging', 'mingit', 'cmd');
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(candidate, 'git.exe'), 'candidate must not be selected');
    const explicit = path.join(fixture, 'explicit-missing');
    const result = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'verify-bundled-git.ps1'),
      '-Root', fixture, '-PayloadDir', explicit,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /PASS\s+bundled payload/, result.stdout);
    assert.match(result.stdout, /nothing to test; payload not staged/, result.stdout);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('package strict mode hard-fails asar skips, launch skips, and lares-native degradation', () => {
  assert.match(packaged, /\[switch\]\$Strict/);
  assert.match(packaged, /if \(\$Strict\) \{ Fail 'asar list'/);
  assert.match(packaged, /ReleaseSkip 'launch smoke'/);
  assert.match(packaged, /if \(\$Strict\) \{ Fail 'lares-native' 'the packaged app logged/);
  assert.match(packaged, /packaged MinGit git\.exe/);
  assert.doesNotMatch(packaged, /unsigned 0\.2\.0 release/);
});

test('bundled-node strict mode promotes critical skips and status-line warnings', () => {
  assert.match(bundledNode, /\[switch\]\$Strict/);
  assert.match(bundledNode, /if \(\$Strict\) \{\r?\n\s+Fail \$name "SKIPPED/);
  assert.match(bundledNode, /if \(\$Strict\) \{\r?\n\s+Fail 'V12 status line -> stdout'/);
});

test('native strict mode promotes each lares-native degradation', () => {
  assert.match(native, /process\.argv\.includes\('--strict'\)/);
  const section = native.slice(native.indexOf('[4] lares-native'), native.indexOf('[5] packaged PTY-helper'));
  assert.equal((section.match(/degrade\(/g) || []).length, 6);
  assert.equal((section.match(/warn\(/g) || []).length, 0);
});

test('native package mode resolves rebuilt modules from packaged resources', () => {
  assert.match(native, /process\.argv\.indexOf\('--package'\)/);
  assert.match(native, /path\.join\(resourcesRoot, 'app\.asar'\)/);
  assert.match(native, /path\.join\(resourcesRoot, 'native', 'lares-native', 'index\.js'\)/);
  assert.match(release, /--strict --package \$unpacked/);
});

test('scaffold driver stubs electron and requires the generated status hook', () => {
  assert.match(release, /\[switch\]\$ScaffoldOnly/);
  assert.match(release, /\[string\]\$UnpackedRoot/);
  assert.match(release, /Module\._resolveFilename = function resolveFilename/);
  assert.match(release, /if \(request === 'electron'\) return electronStubId/);
  assert.match(release, /SCAFFOLD_STATUS_HOOK=/);
  assert.match(release, /scaffold status hook missing/);
  assert.match(release, /Start-Process -FilePath \$exe -ArgumentList \$driverArgs -Wait -PassThru/);
  assert.match(release, /\$global:LASTEXITCODE = \$driverProcess\.ExitCode/);
});

console.log(`\nverify-windows-release: ${passed} passing`);
