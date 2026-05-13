// Self-contained smoke test for codex-shell-parser.
//
//   npm run build:main
//   node dist/main/main/supervisor/codex-shell-parser.test.js

import assert from 'node:assert/strict';
import {
  parseShellCommand,
  parseApplyPatch,
  shellResultIndicatesSuccess,
} from './codex-shell-parser';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

const WIN_CWD = 'C:\\proj';
const WSL_CWD = '/home/edward/proj';

// ── Read patterns ────────────────────────────────────────────────────

test('Get-Content -LiteralPath single-quoted → read', () => {
  const r = parseShellCommand("Get-Content -LiteralPath 'src/main/database.ts'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\src\\main\\database.ts');
});

test('Get-Content double-quoted → read', () => {
  const r = parseShellCommand('Get-Content "CLAUDE.md"', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\CLAUDE.md');
});

test('Get-Content -Path bare path -> read', () => {
  const r = parseShellCommand('Get-Content -Path package.json', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\package.json');
});

test('Get-Content -Raw bare path -> read', () => {
  const r = parseShellCommand('Get-Content -Raw package.json', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\package.json');
});

test('Get-Content -TotalCount skips numeric value before path', () => {
  const r = parseShellCommand('Get-Content -TotalCount 20 src/main/index.ts', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\src\\main\\index.ts');
});

test('Get-Content -Raw -Path quoted path -> read', () => {
  const r = parseShellCommand('Get-Content -Raw -Path "src/main/database.ts"', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\src\\main\\database.ts');
});

test('cat <path> → read', () => {
  const r = parseShellCommand('cat CLAUDE.md', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\CLAUDE.md');
});

test('cat with WSL workdir uses forward slashes', () => {
  const r = parseShellCommand('cat README.md', WSL_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].filePath, '/home/edward/proj/README.md');
});

test('head -n 50 <path> → read', () => {
  const r = parseShellCommand('head -n 50 docs/PLAN.md', WSL_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, '/home/edward/proj/docs/PLAN.md');
});

test('Select-String -LiteralPath → read', () => {
  const r = parseShellCommand("Select-String -LiteralPath 'foo.ts' -Pattern 'export'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
});

test('Select-String -Path with pattern -> read', () => {
  const r = parseShellCommand('Select-String -Path "src/main/index.ts" -Pattern "foo"', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\src\\main\\index.ts');
});

test('rg <pattern> <file> → read (when arg looks like a path)', () => {
  const r = parseShellCommand('rg foo bar.ts', WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'read');
  assert.equal(r[0].filePath, 'C:\\proj\\bar.ts');
});

test('bare rg <pattern> (no file arg) → skip', () => {
  const r = parseShellCommand('rg foo', WIN_CWD);
  assert.equal(r.length, 0);
});

// ── Write/create patterns ────────────────────────────────────────────

test("Set-Content -LiteralPath 'foo.txt' 'x' → write", () => {
  const r = parseShellCommand("Set-Content -LiteralPath 'foo.txt' -Value 'x'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'write');
  assert.equal(r[0].filePath, 'C:\\proj\\foo.txt');
});

test('Add-Content → write (append)', () => {
  const r = parseShellCommand("Add-Content -LiteralPath 'log.txt' 'line'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'write');
});

test('Out-File → create', () => {
  const r = parseShellCommand("Out-File -LiteralPath 'output.json' -InputObject '{}'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'create');
});

test('New-Item -Path → create', () => {
  const r = parseShellCommand("New-Item -Path 'newfile.md' -ItemType File", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'create');
});

test('shell redirect > path → create', () => {
  const r = parseShellCommand('echo hi > log.txt', WSL_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'create');
  assert.equal(r[0].filePath, '/home/edward/proj/log.txt');
});

test('shell redirect >> path → write (append)', () => {
  const r = parseShellCommand('echo hi >> log.txt', WSL_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'write');
});

// ── Negative / skip patterns ─────────────────────────────────────────

test('ls -la → empty (directory listing)', () => {
  assert.deepEqual(parseShellCommand('ls -la', WSL_CWD), []);
});

test('Get-ChildItem -Recurse → empty', () => {
  assert.deepEqual(parseShellCommand('Get-ChildItem -Recurse', WIN_CWD), []);
});

test('find . -name "*.md" → empty', () => {
  assert.deepEqual(parseShellCommand('find . -name "*.md"', WSL_CWD), []);
});

test('unknown PowerShell flag without a path -> empty', () => {
  assert.deepEqual(parseShellCommand('Get-Content -UnknownFlag', WIN_CWD), []);
});

test('pipeline output file in later stage -> empty', () => {
  assert.deepEqual(parseShellCommand('Get-ChildItem | Out-File results.txt', WIN_CWD), []);
});

test('command substitution -> empty', () => {
  assert.deepEqual(parseShellCommand('cat $(Get-Item package.json)', WIN_CWD), []);
});

test('absolute path (Windows) is preserved', () => {
  const r = parseShellCommand("Get-Content 'C:\\Users\\foo\\bar.md'", WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].filePath, 'C:\\Users\\foo\\bar.md');
});

test('absolute path (Unix) is preserved', () => {
  const r = parseShellCommand('cat /etc/hosts', WSL_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].filePath, '/etc/hosts');
});

// ── apply_patch ──────────────────────────────────────────────────────

test('apply_patch *** Update File: → write', () => {
  const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@ context\n+ added\n*** End Patch';
  const r = parseApplyPatch(patch, WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'write');
  assert.equal(r[0].filePath, 'C:\\proj\\src\\foo.ts');
});

test('apply_patch *** Add File: → create', () => {
  const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+ first line\n*** End Patch';
  const r = parseApplyPatch(patch, WIN_CWD);
  assert.equal(r.length, 1);
  assert.equal(r[0].operation, 'create');
});

test('apply_patch with multiple files', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.ts',
    '@@',
    '*** Update File: b.ts',
    '@@',
    '*** Add File: c.ts',
    '+ x',
    '*** End Patch',
  ].join('\n');
  const r = parseApplyPatch(patch, WIN_CWD);
  assert.equal(r.length, 3);
  assert.equal(r.filter(x => x.operation === 'write').length, 2);
  assert.equal(r.filter(x => x.operation === 'create').length, 1);
});

// ── Result-success parsing ───────────────────────────────────────────

test('shellResultIndicatesSuccess: Exit code: 0 → true', () => {
  assert.equal(shellResultIndicatesSuccess('Exit code: 0\nWall time: 0.5\nOutput:\nhi\n'), true);
});

test('shellResultIndicatesSuccess: Exit code: 1 → false', () => {
  assert.equal(shellResultIndicatesSuccess('Exit code: 1\nWall time: 0.5\nOutput:\nerr\n'), false);
});

test('shellResultIndicatesSuccess: missing prefix → true (apply_patch case)', () => {
  assert.equal(shellResultIndicatesSuccess('patch applied successfully'), true);
});

// ── Tautology guard: comma-list TUI garbage cannot produce activity ──

test('comma-separated TUI garbage produces no activity (regression guard)', () => {
  // The original bug: Claude PTY regex captured "Read foo, bar, baz" as one path.
  // The shell parser only sees structured codex `command` strings, so this
  // shape never reaches it. Sanity-check by hand.
  const r = parseShellCommand('Read SKILL.md, PlanetScope_Phenology_Schema.md, SNOTEL_380_Analysis_Writeup.md', WIN_CWD);
  assert.equal(r.length, 0, 'no codex tool emits a "Read X, Y, Z" command — should never match');
});

// ── Runner ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
