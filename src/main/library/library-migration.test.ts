import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateWorkspaceLibrary } from './library-migration';
import { migrateWorkspaceStateDir, resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';
import { listInboxReports } from '../research/classify-inbox-report';

const VALID_REPORT = `---
id: research-2026-09-06-valid
topic: Valid report
created: 2026-09-06T12:00:00Z
source_urls:
  - https://example.com/source
trust: untrusted
summary: Valid report fixture.
---

## Summary
Valid.
`;

function tempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-library-migration-'));
}

async function main(): Promise<void> {
  {
    const root = tempWorkspace();
    fs.mkdirSync(path.join(root, '.lares', 'research', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(root, '.lares', 'research', 'inbox', 'valid.md'), VALID_REPORT);
    fs.writeFileSync(path.join(root, '.lares', '.scaffold-versions.json'), JSON.stringify({ 'research/README.md': 5 }));
    resetWorkspaceStateDirCacheForTests();
    migrateWorkspaceStateDir(root);
    assert.ok(fs.existsSync(path.join(root, '.lares', 'library', 'inbox', 'valid.md')),
      'REACHABILITY:migrateWorkspaceStateDir:library-rename');
    assert.ok(!fs.existsSync(path.join(root, '.lares', 'research')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.lares', '.scaffold-versions.json'), 'utf8')), { 'library/README.md': 5 });
    for (const name of ['cleared', 'scratch', 'sources', 'derived']) {
      assert.ok(fs.statSync(path.join(root, '.lares', 'library', name)).isDirectory());
    }
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = tempWorkspace();
    const state = path.join(root, '.lares');
    fs.mkdirSync(path.join(state, 'research', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(state, 'library', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(state, 'research', 'inbox', 'keep.md'), VALID_REPORT.replace('Valid report fixture.', 'from research'));
    fs.writeFileSync(path.join(state, 'library', 'inbox', 'keep.md'), VALID_REPORT.replace('Valid report fixture.', 'library wins'));
    fs.writeFileSync(path.join(state, 'research', 'inbox', 'merge.md'), VALID_REPORT);
    migrateWorkspaceLibrary(state);
    assert.match(fs.readFileSync(path.join(state, 'library', 'inbox', 'keep.md'), 'utf8'), /library wins/);
    assert.ok(fs.existsSync(path.join(state, 'library', 'inbox', 'merge.md')));
    migrateWorkspaceLibrary(state);
    assert.match(fs.readFileSync(path.join(state, 'library', 'inbox', 'keep.md'), 'utf8'), /library wins/);
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = tempWorkspace();
    const inbox = path.join(root, '.lares', 'library', 'inbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'ok.md'), VALID_REPORT);
    fs.writeFileSync(path.join(inbox, 'broken.md'), '# missing frontmatter');
    migrateWorkspaceLibrary(path.join(root, '.lares'));
    assert.ok(fs.existsSync(path.join(inbox, '_legacy', 'broken.md')));
    assert.ok(fs.existsSync(path.join(inbox, 'ok.md')));
    assert.deepEqual((await listInboxReports(inbox)).map((report) => report.relPath), ['ok.md']);
    assert.equal(migrateWorkspaceLibrary(path.join(root, '.lares')).archivedReports, 0);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('library-migration.test: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
