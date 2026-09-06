import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { freezeMembersFromBoundary } from './boundary-filter-replay';
import { runGit, runGitBytes } from './git-command';
import { finalizeSaveUnit } from '../commit-engine/finalization-service';
import type { CommitRepresentationEntry } from '../commit-engine/commit-representation';

const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const gitBytes = (cwd: string, args: string[], input: Buffer): Buffer => execFileSync('git', args, { cwd, input });
const encoded = (value: string): string => Buffer.from(value).toString('base64');
const gitPath = (value: string) => ({ pathBytesBase64: encoded(value), displayPath: value, utf8Clean: true });
const opts = { maxBytes: 8 << 20, timeoutMs: 30_000 };

async function fixture(): Promise<{ root: string; boundaryOid: string; entry: CommitRepresentationEntry }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lares-boundary-filter-test-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Boundary Test']);
  git(root, ['config', 'filter.demo.clean', 'tr a-z A-Z']);
  git(root, ['config', 'filter.demo.smudge', 'tr A-Z a-z']);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt filter=demo\n');
  await fs.writeFile(path.join(root, 'member.txt'), 'boundary bytes\n');
  git(root, ['add', '.gitattributes', 'member.txt']);
  git(root, ['commit', '-m', 'boundary']);
  const boundaryOid = git(root, ['rev-parse', 'HEAD']);
  const blobOid = git(root, ['rev-parse', 'HEAD:member.txt']);
  return {
    root,
    boundaryOid,
    entry: {
      path: gitPath('member.txt'),
      commitPathspecs: [gitPath('member.txt')],
      expectedWorktreeState: 'present',
      rawWorktreeBlobOid: blobOid,
    },
  };
}

test('boundary freezer uses boundary bytes and boundary .gitattributes after live mutation', async () => {
  const { root, boundaryOid, entry } = await fixture();
  try {
    // This is the capture -> finalization race: both live inputs change after
    // the immutable boundary identity has already been captured.
    await fs.writeFile(path.join(root, 'member.txt'), 'mutated live content\n');
    await fs.writeFile(path.join(root, '.gitattributes'), '*.txt -filter\n');
    const runtime = { repoRoot: root, runGit, runGitBytes };
    const frozen = await freezeMembersFromBoundary({
      boundaryOid, pinnedHeadOid: boundaryOid, members: [entry], repoRuntime: runtime,
    });
    const representation = frozen.get(entry.path.pathBytesBase64);
    assert.ok(representation, 'REACHABILITY:boundary-filter-replay freezer must return the selected member');
    assert.equal(representation.rawBlobOid, git(root, ['rev-parse', 'HEAD:member.txt']));
    const boundaryClean = gitBytes(root, ['hash-object', '--stdin'], Buffer.from('BOUNDARY BYTES\n')).toString().trim();
    assert.equal(representation.commitBlobOid, boundaryClean);
    assert.notEqual(representation.rawBlobOid, git(root, ['hash-object', 'member.txt']), 'manifest must not read mutated live content');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('finalization injects one boundary-backed per-entry freezer without changing manifest schema', async () => {
  const { root, boundaryOid, entry } = await fixture();
  try {
    await fs.writeFile(path.join(root, 'member.txt'), 'changed before finalization\n');
    await fs.writeFile(path.join(root, '.gitattributes'), '*.txt -filter\n');
    const rows: any[] = [];
    const result = await finalizeSaveUnit({
      saveUnitId: 'unit-1', saveUnitKind: 'named-save-set', repositoryKey: 'repo',
      finalizedBy: 'test', boundaryOid,
      members: [entry], repoRoot: root, pinnedHeadOid: boundaryOid,
    }, {
      store: {
        getActive: () => null, maxRevision: () => 0, insert: (row) => rows.push(row),
        supersede: () => undefined, setBoundaryStatus: () => undefined, transact: (fn) => fn(),
      },
      writeRef: async () => ({ ok: true, ref: 'refs/test' }),
    });
    const manifest = JSON.parse(result.memberManifestJson) as Array<Record<string, unknown>>;
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].rawBlobOid, git(root, ['rev-parse', 'HEAD:member.txt']));
    assert.equal(rows.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(manifest[0], 'rawMode'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
