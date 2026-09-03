import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateTestRepo, resolveGit } from './make-test-repo.mjs';

function run(command, args, cwd, input) {
  return spawnSync(command, args, { cwd, input, encoding: 'utf8', windowsHide: true });
}

function runNodeTest(cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', 'src/index.test.js'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function snapshotTree(root) {
  const snapshot = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else snapshot.set(path.relative(root, absolute).split(path.sep).join('/'), fs.readFileSync(absolute));
    }
  };
  visit(root);
  return snapshot;
}

function assertSnapshotsEqual(actual, expected) {
  assert.deepEqual([...actual.keys()], [...expected.keys()]);
  for (const [relativePath, bytes] of actual) {
    assert.equal(bytes.equals(expected.get(relativePath)), true, `content differs: ${relativePath}`);
  }
}

function assertLfOnly(root, tracked) {
  for (const relativePath of tracked) {
    const bytes = fs.readFileSync(path.join(root, ...relativePath.split('/')));
    if (relativePath !== 'MANIFEST.json' && relativePath !== 'assets/big.bin') {
      assert.equal(bytes.includes(13), false, `${relativePath} contains a CR byte`);
    }
  }
}

test('REACHABILITY:wp1-vm-generator-determinism content, manifest, tree, and commit are deterministic', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-vm-generator-determinism-'));
  const target = path.join(scratch, 'fixture');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const first = generateTestRepo({ targetDir: target, runId: 'determinism-001' });
  const firstSnapshot = snapshotTree(target);
  const firstManifest = fs.readFileSync(path.join(target, 'MANIFEST.json'));
  fs.rmSync(target, { recursive: true, force: true });
  const second = generateTestRepo({ targetDir: target, runId: 'determinism-001' });
  const secondSnapshot = snapshotTree(target);
  const secondManifest = fs.readFileSync(path.join(target, 'MANIFEST.json'));

  assertSnapshotsEqual(secondSnapshot, firstSnapshot);
  assert.deepEqual(secondManifest, firstManifest);
  assert.deepEqual(second.manifest, first.manifest);
  assert.equal(second.treeOid, first.treeOid);
  assert.equal(second.commitOid, first.commitOid);
});

test('generated repository manifest, Git config, ignore inventory, and status satisfy the contract', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-vm-generator-contract-'));
  const target = path.join(scratch, 'fixture');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const result = generateTestRepo({ targetDir: target, runId: 'contract-002' });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'MANIFEST.json'), 'utf8'));

  assert.equal(manifest.repoRoot, path.resolve(target));
  assert.match(manifest.proposalArtifactId, /^prop_[0-9a-f]{8}$/);
  assert.match(manifest.proposalTitle, /contract-002/);
  assert.match(manifest.intentId, /^int_[0-9a-f]{8}$/);
  assert.equal(manifest.planArtifactId, `plan_${manifest.proposalArtifactId.slice(5)}`);
  assert.deepEqual(manifest.tracked, [...manifest.tracked].sort());
  assert.deepEqual(manifest.ignored, [...manifest.ignored].sort());
  assert.equal(manifest.ignored.length, 5_001);
  assert.equal(manifest.tracked.includes('MANIFEST.json'), true);
  assert.equal(Object.hasOwn(manifest.sha256, 'MANIFEST.json'), false);
  assert.deepEqual(Object.keys(manifest.sha256), manifest.tracked.filter((entry) => entry !== 'MANIFEST.json'));
  for (const [relativePath, expectedHash] of Object.entries(manifest.sha256)) {
    const bytes = fs.readFileSync(path.join(target, ...relativePath.split('/')));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash, relativePath);
  }
  assert.equal(manifest.seededBug.file, 'src/index.js');
  assert.equal(manifest.seededBug.line, 2);
  assert.equal(manifest.expectedRedExit, 1);
  assert.equal(manifest.expectedGreenExit, 0);
  assert.equal(manifest.trackedBytes, manifest.tracked.reduce((sum, relativePath) => sum + fs.statSync(path.join(target, ...relativePath.split('/'))).size, 0));
  assert.equal(manifest.ignoredBytes, manifest.ignored.reduce((sum, relativePath) => sum + fs.statSync(path.join(target, ...relativePath.split('/'))).size, 0));
  assert.equal(manifest.ignored.every((relativePath) => relativePath.length < 200), true);
  assert.equal(manifest.ignored.every((relativePath) => relativePath.split('/').length <= 3), true);
  assert.equal(run('git', ['status', '--porcelain'], target).stdout, '');

  for (const [key, expected] of [['core.autocrlf', 'false'], ['core.eol', 'lf'], ['init.defaultBranch', 'main']]) {
    const config = run('git', ['config', '--local', '--get', key], target);
    assert.equal(config.status, 0);
    assert.equal(config.stdout.trim(), expected);
  }
  const ignored = run('git', ['check-ignore', '--stdin'], target, `${manifest.ignored.join('\n')}\n`);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/), manifest.ignored);
  assertLfOnly(target, manifest.tracked);
  assert.equal(result.git, 'git');
});

test('seed proposal template and advisory zip omission are exact', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-vm-generator-template-'));
  const target = path.join(scratch, 'fixture');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  generateTestRepo({ targetDir: target, runId: 'template-003' });
  const template = fs.readFileSync(path.join(target, 'acceptance', 'fixtures', 'seed-proposal.md.tmpl'), 'utf8');
  const ignore = fs.readFileSync(path.join(target, '.gitignore'), 'utf8');

  for (const field of ['artifact_id:', 'title:', 'author:', 'author_agent_id:', 'author_role:', 'author_provider:', 'authored_at:']) {
    assert.match(template, new RegExp(`^${field}`, 'm'));
  }
  for (const placeholder of ['{{RUN_ID}}', '{{ARTIFACT_ID}}', '{{INTENT_ID}}']) assert.match(template, new RegExp(placeholder.replace(/[{}]/g, '\\$&')));
  assert.match(template, /^## In plain terms$/m);
  assert.match(template, /<!--PLAN-INTENT\n\{ "intent_id": "\{\{INTENT_ID\}\}", "part": "vm-acceptance-smoke", "kind": "groupthink-serial",\n  "targets": \[ \{ "provider": "claude", "model": "claude-fable-5-1" \}, \{ "provider": "codex", "model": "gpt-5\.1-codex" \} \],\n  "reason": "acceptance run \{\{RUN_ID\}\}: exercise GroupThink on the installed app" \}\n-->/);
  assert.equal(ignore, 'node_modules/\ndist/\ngenerated/\n*.bin\n');
  assert.equal([...snapshotTree(target).keys()].some((relativePath) => relativePath.endsWith('.zip')), false);
});

test('generated unit test is red and the documented fix makes it green', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-vm-generator-red-green-'));
  const target = path.join(scratch, 'fixture');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  generateTestRepo({ targetDir: target, runId: 'red-green-004' });

  const red = runNodeTest(target);
  assert.notEqual(red.status, 0, red.stdout || red.stderr);
  const sourcePath = path.join(target, 'src', 'index.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /return left - right;/);
  fs.writeFileSync(sourcePath, source.replace('return left - right;', 'return left + right;'));
  const green = runNodeTest(target);
  assert.equal(green.status, 0, green.stdout || green.stderr);
});

test('--git overrides --lares-exe and --lares-exe resolves bundled MinGit', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-vm-generator-resolution-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const explicitGit = path.join(scratch, 'explicit', 'git.exe');
  const laresExe = path.join(scratch, 'Lares', 'Lares.exe');

  assert.equal(resolveGit({ git: explicitGit, laresExe }), path.resolve(explicitGit));
  const bundledGit = path.join(path.dirname(laresExe), 'resources', 'mingit', 'cmd', 'git.exe');
  assert.equal(resolveGit({ laresExe }), bundledGit);
  assert.equal(resolveGit({}), 'git');
});
