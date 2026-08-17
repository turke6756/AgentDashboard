import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');

assert.match(
  source,
  /listInboxReports:\s*\(workspaceId\)\s*=>\s*ipcRenderer\.invoke\('research:list-inbox-reports', workspaceId\)/,
  'preload must invoke the production research channel with workspaceId only',
);
assert.doesNotMatch(source, /research:list-inbox-reports[^\n]*(absInboxDir|inboxDir|filePath)/);
console.log('  \u2713 research inbox preload exposes workspaceId-only list binding');
