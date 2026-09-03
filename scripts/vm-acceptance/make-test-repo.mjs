#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXED_GIT_DATE = '2000-01-01T00:00:00 +0000';
const BIG_FILE_BYTES = 8 * 1024 * 1024;
const NODE_MODULE_FILES = 2_000;
const GENERATED_FILES = 3_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function seedFromRunId(runId) {
  return Number.parseInt(sha256(runId).slice(0, 8), 16) >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function writeFile(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, contents);
}

function runGit(git, args, options = {}) {
  const result = spawnSync(git, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

export function resolveGit({ git, laresExe }) {
  if (git) return path.resolve(git);
  if (laresExe) {
    return path.join(path.dirname(path.resolve(laresExe)), 'resources', 'mingit', 'cmd', 'git.exe');
  }
  return 'git';
}

function assertEmptyTarget(repoRoot) {
  if (!fs.existsSync(repoRoot)) return;
  if (!fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`target exists and is not a directory: ${repoRoot}`);
  }
  if (fs.readdirSync(repoRoot).length !== 0) {
    throw new Error(`target directory must be empty: ${repoRoot}`);
  }
}

function makeBigFile(runId) {
  const random = mulberry32(seedFromRunId(runId));
  const bytes = Buffer.allocUnsafe(BIG_FILE_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes.writeUInt32LE(Math.floor(random() * 0x1_0000_0000) >>> 0, offset);
  }
  return bytes;
}

function manifestJson(manifest, trackedBytesWithoutManifest) {
  let manifestBytes = 0;
  for (;;) {
    manifest.trackedBytes = trackedBytesWithoutManifest + manifestBytes;
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const nextBytes = Buffer.byteLength(serialized);
    if (nextBytes === manifestBytes) return serialized;
    manifestBytes = nextBytes;
  }
}

export function generateTestRepo(opts) {
  if (!opts || typeof opts !== 'object') throw new TypeError('options are required');
  if (!opts.targetDir) throw new Error('targetDir is required');
  if (!opts.runId || typeof opts.runId !== 'string') throw new Error('runId is required');

  const repoRoot = path.resolve(opts.targetDir);
  const runId = opts.runId;
  const git = resolveGit(opts);
  assertEmptyTarget(repoRoot);
  fs.mkdirSync(repoRoot, { recursive: true });

  const proposalHex = sha256(`proposal:${runId}`).slice(0, 8);
  const intentHex = sha256(`intent:${runId}`).slice(0, 8);
  const trackedContents = new Map([
    ['.gitignore', 'node_modules/\ndist/\ngenerated/\n*.bin\n'],
    ['README.md', `# VM acceptance fixture\n\nDeterministic fixture for acceptance run ${runId}.\n`],
    ['acceptance/fixtures/seed-proposal.md.tmpl', `---\nartifact_id: {{ARTIFACT_ID}}\ntitle: VM acceptance run {{RUN_ID}}\nauthor: Lares acceptance supervisor\nauthor_agent_id: external-cli-session\nauthor_role: supervisor\nauthor_provider: claude\nauthored_at: 2000-01-01T00:00:00Z\n---\n\n# VM acceptance run {{RUN_ID}}\n\n## In plain terms\n\nExercise the installed application end to end for acceptance run {{RUN_ID}}.\n\n<!--PLAN-INTENT\n{ "intent_id": "{{INTENT_ID}}", "part": "vm-acceptance-smoke", "kind": "groupthink-serial",\n  "targets": [ { "provider": "claude", "model": "claude-fable-5-1" }, { "provider": "codex", "model": "gpt-5.1-codex" } ],\n  "reason": "acceptance run {{RUN_ID}}: exercise GroupThink on the installed app" }\n-->\n`],
    ['package.json', '{\n  "name": "lares-vm-acceptance-fixture",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "test": "node --test"\n  }\n}\n'],
    ['src/index.js', 'export function add(left, right) {\n  return left - right;\n}\n'],
    ['src/index.test.js', `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './index.js';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n`],
  ]);

  for (const [relativePath, contents] of trackedContents) writeFile(repoRoot, relativePath, contents);

  const ignored = [];
  let ignoredBytes = 0;
  for (let index = 0; index < NODE_MODULE_FILES; index += 1) {
    const packageNumber = Math.floor(index / 20).toString().padStart(3, '0');
    const fileNumber = (index % 20).toString().padStart(2, '0');
    const relativePath = `node_modules/pkg-${packageNumber}/file-${fileNumber}.js`;
    const contents = `export default ${index}; // ${runId}\n`;
    writeFile(repoRoot, relativePath, contents);
    ignored.push(relativePath);
    ignoredBytes += Buffer.byteLength(contents);
  }
  for (let index = 0; index < GENERATED_FILES; index += 1) {
    const relativePath = `generated/item-${index.toString().padStart(4, '0')}.txt`;
    const contents = `${runId}:${index}\n`;
    writeFile(repoRoot, relativePath, contents);
    ignored.push(relativePath);
    ignoredBytes += Buffer.byteLength(contents);
  }
  const bigFile = makeBigFile(runId);
  writeFile(repoRoot, 'assets/big.bin', bigFile);
  ignored.push('assets/big.bin');
  ignoredBytes += bigFile.length;
  ignored.sort();

  const tracked = [...trackedContents.keys(), 'MANIFEST.json'].sort();
  const hashes = {};
  let trackedBytesWithoutManifest = 0;
  for (const relativePath of tracked.filter((entry) => entry !== 'MANIFEST.json')) {
    const contents = fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')));
    hashes[relativePath] = sha256(contents);
    trackedBytesWithoutManifest += contents.length;
  }

  const manifest = {
    runId,
    repoRoot,
    proposalArtifactId: `prop_${proposalHex}`,
    proposalTitle: `VM acceptance run ${runId}`,
    intentId: `int_${intentHex}`,
    planArtifactId: `plan_${proposalHex}`,
    tracked,
    ignored,
    sha256: hashes,
    seededBug: {
      file: 'src/index.js',
      line: 2,
      description: 'Replace `return left - right;` with `return left + right;`.',
    },
    expectedRedExit: 1,
    expectedGreenExit: 0,
    trackedBytes: 0,
    ignoredBytes,
  };
  writeFile(repoRoot, 'MANIFEST.json', manifestJson(manifest, trackedBytesWithoutManifest));

  runGit(git, ['init', '--quiet', '--initial-branch=main', repoRoot]);
  const config = [
    ['core.autocrlf', 'false'],
    ['core.eol', 'lf'],
    ['init.defaultBranch', 'main'],
    ['user.name', 'Lares VM Acceptance'],
    ['user.email', 'vm-acceptance@lares.invalid'],
  ];
  for (const [key, value] of config) runGit(git, ['-C', repoRoot, 'config', '--local', key, value]);
  runGit(git, ['-C', repoRoot, 'add', '--all']);
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  };
  runGit(git, ['-C', repoRoot, 'commit', '--quiet', '-m', 'Initial VM acceptance fixture'], { env: commitEnv });

  return {
    repoRoot,
    git,
    manifest,
    commitOid: runGit(git, ['-C', repoRoot, 'rev-parse', 'HEAD']),
    treeOid: runGit(git, ['-C', repoRoot, 'rev-parse', 'HEAD^{tree}']),
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const targetDir = args.shift();
  let runId;
  let git;
  let laresExe;
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === '--run-id') runId = value;
    else if (flag === '--git') git = value;
    else if (flag === '--lares-exe') laresExe = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!targetDir || !runId) {
    throw new Error('usage: make-test-repo.mjs <target-dir> --run-id <id> [--git <git.exe>] [--lares-exe <Lares.exe>]');
  }
  return { targetDir, runId, git, laresExe };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = generateTestRepo(parseArgs(process.argv.slice(2)));
    console.log(`  ok   [1] generated VM acceptance repo — ${result.repoRoot}`);
    console.log('\nmake-test-repo: 1 passed, 0 failed, 0 skipped');
  } catch (error) {
    console.error(` FAIL  [1] generate VM acceptance repo — ${error instanceof Error ? error.message : String(error)}`);
    console.error('\nmake-test-repo: 0 passed, 1 failed, 0 skipped');
    process.exitCode = 1;
  }
}
