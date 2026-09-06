#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'scripts', 'docs', 'examples'];
const LEGACY_DOT_PATH = ['.lares', 'research'].join('/');
const LEGACY_DOT_RE = new RegExp(`${LEGACY_DOT_PATH.replace('.', '\\.')}(/|\\b)`);
const LEGACY_INBOX = ['research', 'inbox'].join('/');
const LEGACY_CLEARED = ['research', 'cleared'].join('/');
const FROZEN_FIXTURE = 'src/main/supervisor/guard-script-old-body-fixtures.ts';
const MIGRATION = 'src/main/library/library-migration.ts';

function filesUnder(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-dev') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function frozenVersionLines(source) {
  const frozen = new Set();
  const file = ts.createSourceFile('constants.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !/_V\d+$/.test(declaration.name.text)) continue;
      const start = file.getLineAndCharacterOfPosition(statement.getStart(file)).line;
      const end = file.getLineAndCharacterOfPosition(statement.getEnd()).line;
      for (let line = start; line <= end; line += 1) frozen.add(line);
    }
  }
  return frozen;
}

const files = SCAN_ROOTS.flatMap((root) => filesUnder(path.join(ROOT, root))).concat(path.join(ROOT, '.gitignore'));
const violations = [];
for (const absolute of files) {
  const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
  if (relative === FROZEN_FIXTURE || relative === MIGRATION) continue;
  const source = fs.readFileSync(absolute, 'utf8');
  const lines = source.split(/\r?\n/);
  const frozen = relative === 'src/shared/constants.ts' || relative === 'src/main/supervisor/index.ts'
    ? frozenVersionLines(source)
    : new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replaceAll('\\', '/');
    if (!LEGACY_DOT_RE.test(line) && !line.includes(LEGACY_INBOX) && !line.includes(LEGACY_CLEARED)) continue;
    if (frozen.has(i)) continue;
    violations.push(`${relative}:${i + 1}:${lines[i].trim()}`);
  }
}

assert.deepEqual(violations, [], `legacy research paths remain:\n${violations.join('\n')}`);
console.log('no-legacy-research-path.test: PASS');
