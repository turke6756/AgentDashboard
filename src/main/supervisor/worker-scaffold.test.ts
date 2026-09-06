// Class IV worker-scaffold tests — plans/class-iv-worker-hook-scaffold.md §12.
//
// Exercises the per-provider branches of AgentSupervisor.ensureWorkerScaffold:
//   1. Claude: writes .lares/scripts/dashboard-status.mjs +
//      .lares/workers/claude/{CLAUDE.md,.claude/settings.json} verbatim
//      (path expansion deferred to Claude Code's ${CLAUDE_PROJECT_DIR}).
//   2. Codex: writes the shared script + .lares/workers/codex/.codex/config.toml
//      with ${WORKSPACE_ROOT} replaced by the absolute workspace path.
//   3. Never-overwrite: re-running on the same workDir does not clobber an
//      existing settings.json / config.toml.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/worker-scaffold.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor, ensureWorkerGitRepoRoot, SCAFFOLD_SIDECAR_REL } from './index';
import {
  SUPERVISOR_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON,
  workerGrokSettingsJson,
  workerAgyHooksJson,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
  WORKER_GROK_AGENTS_MD,
  WORKER_AGY_AGENTS_MD,
  PROPOSAL_TO_PLAN_SKILL_MD,
  LAND_WORK_PACKAGE_SKILL_MD,
  LAND_WORK_PACKAGE_SKILL_MD_V1,
  LAND_WORK_PACKAGE_SKILL_MD_V2,
  LAND_WORK_PACKAGE_SKILL_MD_V3,
  LAND_WORK_PACKAGE_SKILL_MD_V4,
  LAND_WORK_PACKAGE_SKILL_MD_V5,
  LAND_WORK_PACKAGE_SKILL_MD_V6,
  LAND_WORK_PACKAGE_SKILL_MD_V7,
} from '../../shared/constants';
import {
  AGY_STATUS_HOOK_NAME,
} from './agy-hooks';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// Minimal DB patching: ensureWorkerScaffold only calls addEvent on success.
function patchDb(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  return () => {
    db.addEvent = origAddEvent;
  };
}

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
  return dir;
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

type SupervisorWithScaffold = {
  ensureWorkerScaffold: (workDir: string, provider: string, pathType: string) => void;
  ensureSupervisorScaffold: (workDir: string, pathType: string) => void;
};

function makeSupervisor(): { supervisor: SupervisorWithScaffold; cleanup: () => void } {
  const restoreDb = patchDb();
  const raw = new AgentSupervisor();
  (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const supervisor = raw as unknown as SupervisorWithScaffold;
  return { supervisor, cleanup: restoreDb };
}

// ── Tests ────────────────────────────────────────────────────────────

test('Codex: scaffold writes .codex/config.toml with absolute workspace path interpolated', () => {
  const workDir = mktmp('codex-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);

    const content = fs.readFileSync(configPath, 'utf-8');

    // Stop hook table must be present (TOML array-of-tables syntax).
    assert.ok(content.includes('[[hooks.Stop]]'), `config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `config.toml missing [[hooks.Stop.hooks]]: ${content}`);
    assert.ok(content.includes('type = "command"'), `config.toml missing type=command: ${content}`);

    // Absolute path materialized at scaffold time — no unresolved placeholder.
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );

    // Forward-slash normalized workspace path appears in the command.
    const expectedScriptPath = `${workDir.replace(/\\/g, '/')}/.lares/scripts/dashboard-status.mjs`;
    assert.ok(
      content.includes(expectedScriptPath),
      `config.toml does not reference the workspace's dashboard-status.mjs path. Expected substring: ${expectedScriptPath}\nGot: ${content}`,
    );

    // The shared script is also written.
    const scriptPath = path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs');
    assert.ok(fs.existsSync(scriptPath), `expected shared hook script at ${scriptPath}`);

    // Negative: codex scaffold must not write the Claude-side worker files.
    const claudeSettings = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(
      !fs.existsSync(claudeSettings),
      `codex scaffold should not create ${claudeSettings}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: scaffold writes AGENTS.md standing instructions + NO behavioral.md (WP-G)', () => {
  const workDir = mktmp('codex-agents-md');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    // AGENTS.md is the file the Codex CLI reads from cwd as standing instructions.
    const agentsPath = path.join(workDir, '.lares', 'workers', 'codex', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsPath), `expected ${agentsPath} to exist`);
    const agents = fs.readFileSync(agentsPath, 'utf-8');

    // The rule this whole file exists to deliver must be present.
    assert.ok(
      agents.includes('## Never use git to discard uncommitted work'),
      'codex AGENTS.md must carry the git-discard section',
    );
    // Turn-ending protocol + shared-cwd present.
    assert.ok(agents.includes('end your turn with the question in plain text'), 'turn-ending protocol present');
    assert.ok(agents.includes('.lares/workers/codex/'), 'cwd references point at the codex lane');
    assert.ok(!agents.includes('.lares/workers/claude/'), 'no leftover claude cwd references');
    // WP-P0C: the retired every-turn PLAN-EVENT ceremony is gone; the worker
    // planning-surface section (proposal-to-plan orientation) is present instead.
    assert.ok(!agents.includes('PLAN-EVENT'), 'retired every-turn PLAN-EVENT ceremony must be dropped (WP-P0C)');
    assert.ok(agents.includes('proposal-to-plan'), 'codex AGENTS.md must carry the proposal-to-plan planning-surface section');
    assert.ok(!agents.includes('AskUserQuestion'), 'Claude-Code-specific tool name removed');
    // Directional memory flow: the supervisor brief carries relevant context;
    // recall_memory is exceptional and remember drafts suggestions.
    assert.ok(agents.includes('## Memory & lessons'), 'codex AGENTS.md carries the new memory-lessons section');
    assert.ok(agents.includes('only when your brief explicitly points you at a capsule'), 'codex AGENTS.md limits recall_memory to explicit brief pointers');
    assert.ok(agents.includes('draft it for your supervisor'), 'codex AGENTS.md routes memory suggestions through the supervisor');
    assert.ok(!agents.includes('.lares/supervisor/memory/MEMORY.md'), 'codex AGENTS.md removes raw index-read guidance');
    assert.ok(!agents.includes('The one durable exception is'), 'codex AGENTS.md drops the retired behavioral.md instruction');

    // WP-G retired seeding: fresh Codex scaffold must write NO behavioral.md.
    const memPath = path.join(workDir, '.lares', 'workers', 'codex', 'behavioral.md');
    assert.ok(!fs.existsSync(memPath), `WP-G: no Codex worker behavioral.md must be seeded; found ${memPath}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: never overwrites existing AGENTS.md on second scaffold call', () => {
  const workDir = mktmp('codex-agents-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'codex', 'AGENTS.md');
    const sentinel = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(agentsPath, sentinel, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const after = fs.readFileSync(agentsPath, 'utf-8');
    assert.equal(after, sentinel, `second scaffold call must not overwrite user-edited AGENTS.md; got: ${after}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: never overwrites existing config.toml on second scaffold call', () => {
  const workDir = mktmp('codex-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    const sentinel = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(configPath, sentinel, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const after = fs.readFileSync(configPath, 'utf-8');
    assert.equal(
      after,
      sentinel,
      `second scaffold call must not overwrite user-edited config.toml; got: ${after}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: WSL scaffold writes config.toml with /mnt-style absolute path', () => {
  const workDir = mktmp('codex-wsl');
  const { supervisor, cleanup } = makeSupervisor();

  // The WSL branch of writeScaffoldMap shells out to wsl.exe — for a unit
  // test we only care about what content WOULD be written. Stub
  // writeScaffoldMap on the instance to capture the file map and skip the
  // actual write.
  const captured: Record<string, string> = {};
  (supervisor as unknown as {
    writeScaffoldMap: (
      wd: string,
      files: Record<string, { content: string; executable?: boolean }>,
      pt: string,
    ) => number;
  }).writeScaffoldMap = (_wd, files, _pt) => {
    for (const [rel, { content }] of Object.entries(files)) {
      captured[rel] = content;
    }
    return Object.keys(files).length;
  };

  try {
    // workDir is a real Windows tmp path (e.g. C:\Users\...\Temp\...). The
    // expected conversion for WSL: drive letter → /mnt/<lowercase>/<rest>.
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'wsl');

    const configRel = '.lares/workers/codex/.codex/config.toml';
    const content = captured[configRel];
    assert.ok(content, `expected captured ${configRel}; got keys: ${Object.keys(captured).join(', ')}`);

    // Derive expected /mnt path from the actual tmp workDir's drive letter.
    const driveMatch = workDir.match(/^([A-Za-z]):\\(.*)/);
    assert.ok(driveMatch, `tmp workDir should look like 'X:\\...'; got: ${workDir}`);
    const expectedDrive = driveMatch![1].toLowerCase();
    const expectedRest = driveMatch![2].replace(/\\/g, '/');
    const expectedPrefix = `/mnt/${expectedDrive}/${expectedRest}`;

    assert.ok(
      content.includes(`${expectedPrefix}/.lares/scripts/dashboard-status.mjs`),
      `WSL config.toml should reference /mnt/${expectedDrive}/... path. Expected substring: ${expectedPrefix}/.lares/scripts/dashboard-status.mjs\nGot: ${content}`,
    );

    // Negative: no leftover Windows-style C:/ in the rendered TOML.
    assert.ok(
      !/[A-Za-z]:\//.test(content),
      `WSL config.toml should not contain Windows drive paths like C:/; got: ${content}`,
    );

    // Standard invariants (placeholder resolved, Stop hook table present).
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `WSL config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );
    assert.ok(content.includes('[[hooks.Stop]]'), `WSL config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `WSL config.toml missing [[hooks.Stop.hooks]]: ${content}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold writes .claude/settings.json verbatim (no path materialization)', () => {
  const workDir = mktmp('claude-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const settingsPath = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `expected ${settingsPath}`);

    const content = fs.readFileSync(settingsPath, 'utf-8');

    // Claude's settings keep ${CLAUDE_PROJECT_DIR} unexpanded — Claude Code
    // expands at hook fire time.
    assert.ok(
      content.includes('${CLAUDE_PROJECT_DIR}'),
      `Claude settings.json should retain \${CLAUDE_PROJECT_DIR}; got: ${content}`,
    );

    // Negative: claude scaffold must not write the codex config.
    const codexConfig = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(
      !fs.existsSync(codexConfig),
      `claude scaffold should not create ${codexConfig}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold writes NO worker behavioral.md (WP-G retired seeding)', () => {
  const workDir = mktmp('claude-worker-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    // WP-G (memory-lessons v2): the shared worker behavioral.md is no longer
    // seeded. A worker's CLAUDE.md points at supervisor-carried context + the
    // `remember` skill instead. A fresh scaffold must create no behavioral.md.
    const memPath = path.join(workDir, '.lares', 'workers', 'claude', 'behavioral.md');
    assert.ok(!fs.existsSync(memPath), `WP-G: no Claude worker behavioral.md must be seeded; found ${memPath}`);

    // The worker CLAUDE.md IS still written (its own managed file) and carries the
    // new memory-lessons section rather than a behavioral.md instruction.
    const mdPath = path.join(workDir, '.lares', 'workers', 'claude', 'CLAUDE.md');
    assert.ok(fs.existsSync(mdPath), `expected worker CLAUDE.md at ${mdPath}`);
    const md = fs.readFileSync(mdPath, 'utf-8');
    assert.ok(md.includes('## Memory & lessons'), 'worker CLAUDE.md carries the new memory-lessons section');
    assert.ok(md.includes('only when your brief explicitly points you at a capsule'), 'worker CLAUDE.md makes recall_memory exceptional');
    assert.ok(md.includes('draft it for your supervisor'), 'worker CLAUDE.md routes memory suggestions through the supervisor');
    assert.ok(!md.includes('.lares/supervisor/memory/MEMORY.md'), 'worker CLAUDE.md removes raw index-read guidance');
    assert.ok(!md.includes('The one durable exception is'), 'worker CLAUDE.md drops the retired behavioral.md instruction');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: scaffold seeds memory/MEMORY.md', () => {
  const workDir = mktmp('supervisor-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');
    assert.ok(fs.existsSync(memPath), `expected ${memPath}`);

    const content = fs.readFileSync(memPath, 'utf-8');
    assert.ok(
      content.includes('# Supervisor Memory'),
      `MEMORY.md should carry the seed header; got: ${content.slice(0, 120)}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: MEMORY.md is seed-once — an edited copy survives relaunch byte-identical, no .bak', () => {
  // Regression guard: MEMORY.md must NOT live in the version-managed
  // SUPERVISOR_FILES map. If it did, a future SUPERVISOR_MEMORY_MD version
  // bump would treat an edited MEMORY.md as "user-modified, unknown hash" and
  // `.bak` + overwrite it, wiping accumulated supervisor memory. The seed-once
  // contract (seedSupervisorMemoryIfAbsent) means a second scaffold pass never
  // touches an existing file regardless of any notional version change.
  const workDir = mktmp('supervisor-memory-durable');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // First launch seeds it.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');

    // The supervisor (or human) curates memory across sessions — simulate an
    // edit that the scaffold must preserve verbatim.
    const edited = '# Supervisor Memory\n\n- [SM-99] curated note that must survive relaunch\n';
    fs.writeFileSync(memPath, edited, 'utf-8');
    const before = fs.readFileSync(memPath); // raw bytes

    // Second launch (relaunch / re-open workspace). Even if SUPERVISOR_MEMORY_MD
    // were bumped to a new version, MEMORY.md is no longer in the managed map,
    // so this pass must leave the edit untouched.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const after = fs.readFileSync(memPath);
    assert.ok(
      before.equals(after),
      `edited MEMORY.md must survive a second scaffold pass byte-identical; before=${before.length}B after=${after.length}B`,
    );

    // And no .bak file was spawned for it (the managed-file overwrite signature).
    const dir = path.dirname(memPath);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('MEMORY.md.bak'));
    assert.equal(baks.length, 0, `MEMORY.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── WP-G regression: repo-wide auto-memory stays OFF ─────────────────
//
// memory-lessons v2 does NOT enable Claude's built-in per-project auto-memory —
// the managed supervisor index (injected) + the `remember` skill are the only
// memory path. A lane whose settings.json silently flipped autoMemoryEnabled to
// true would resurrect the isolated per-session memory the design retired.
test('WP-G: every lane settings.json keeps autoMemoryEnabled: false', () => {
  const lanes: Array<[string, string]> = [
    ['supervisor', SUPERVISOR_CLAUDE_SETTINGS_JSON],
    ['worker', WORKER_CLAUDE_SETTINGS_JSON],
    ['researcher', RESEARCHER_CLAUDE_SETTINGS_JSON],
  ];
  for (const [lane, blob] of lanes) {
    const parsed = JSON.parse(blob) as { autoMemoryEnabled?: unknown };
    assert.equal(parsed.autoMemoryEnabled, false,
      `${lane} settings.json must keep autoMemoryEnabled: false (got ${JSON.stringify(parsed.autoMemoryEnabled)})`);
  }
});

// ── Grok Build worker scaffold (plan §2.6) ───────────────────────────
//
// The grok lane's hook carrier is the claude-compat managed file
// .lares/workers/grok/.claude/settings.json. Commit 7 (PowerShell-safe): its
// content is the GENERATED workerGrokSettingsJson() — absolute .lares/scripts
// paths materialized at scaffold-write time, no ${CLAUDE_PROJECT_DIR} (grok runs
// hooks via PowerShell, which does not expand it) — registered under its OWN
// scaffold key at version 2. Plus a seed-once AGENTS.md identity that is NOT in
// the managed map. A native .grok/config.toml may carry MCP configuration, but
// there is no native .grok/hooks carrier or remember skill in this scope.

function readSidecar(workDir: string): Record<string, number> {
  const p = path.join(workDir, ...SCAFFOLD_SIDECAR_REL.split('/'));
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, number>;
}

test('Grok: fresh scaffold writes settings.json + AGENTS.md in the grok cwd + shared scripts', () => {
  const workDir = mktmp('grok-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    // The compat carrier: grok loads <cwd>/.claude/settings.json natively.
    const settingsPath = path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `expected ${settingsPath} to exist`);
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    // Commit 7 (PowerShell-safe carrier): the grok carrier is the generated,
    // path-materialized settings — byte-identical to workerGrokSettingsJson() for
    // this workspace root — NOT the shared claude constant.
    const posixWorkspaceRoot = workDir.replace(/\\/g, '/');
    assert.equal(
      settings,
      workerGrokSettingsJson(posixWorkspaceRoot),
      'grok settings.json must be the generated, path-materialized carrier',
    );
    // NOT the shared claude carrier, and it must carry NO ${CLAUDE_PROJECT_DIR}:
    // grok runs hooks via PowerShell where ${VAR} expands to empty, so the paths
    // are absolute and materialized at scaffold-write time.
    assert.notEqual(settings, WORKER_CLAUDE_SETTINGS_JSON,
      'grok settings.json must NOT be the shared claude carrier (that one is PowerShell-broken for grok)');
    assert.ok(!settings.includes('${'),
      `grok settings.json must contain no \${ sequence (PowerShell-safe); got:\n${settings}`);
    // Every hook command carries the ABSOLUTE workspace .lares/scripts path.
    assert.ok(
      settings.includes(`${posixWorkspaceRoot}/.lares/scripts/dashboard-status.mjs`),
      `grok settings.json must embed the absolute dashboard-status.mjs path; got:\n${settings}`,
    );
    assert.ok(
      settings.includes(`${posixWorkspaceRoot}/.lares/scripts/guard-git-discard.mjs`),
      `grok settings.json must embed the absolute guard-git-discard.mjs path; got:\n${settings}`,
    );

    // The seed-once identity file.
    const agentsPath = path.join(workDir, '.lares', 'workers', 'grok', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsPath), `expected ${agentsPath} to exist`);
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    assert.equal(agents, WORKER_GROK_AGENTS_MD, 'grok AGENTS.md must be the exact derived body');

    // Shared status + guard scripts are present (delivered by WORKSPACE_SCRIPT_FILES).
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs')),
      'shared dashboard-status.mjs must be present for the grok lane',
    );
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'scripts', 'guard-git-discard.mjs')),
      'shared guard-git-discard.mjs must be present for the grok lane',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: sidecar records workers/grok/.claude/settings.json:2, independent of claude', () => {
  const workDir = mktmp('grok-sidecar');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Scaffold BOTH lanes into one workspace so their sidecar entries coexist.
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['workers/grok/.claude/settings.json'], 2,
      `sidecar must record grok carrier v2 (Commit 7 PowerShell-safe bump); got ${JSON.stringify(sidecar)}`,
    );
    // Version independence: the grok carrier key is distinct from the claude
    // carrier key, and the claude carrier is at its own (higher) version — so the
    // two lanes' carrier versions diverge freely.
    assert.equal(
      sidecar['workers/claude/.claude/settings.json'], 8,
      `claude carrier must keep its own version; got ${JSON.stringify(sidecar)}`,
    );
    assert.notEqual(
      sidecar['workers/grok/.claude/settings.json'],
      sidecar['workers/claude/.claude/settings.json'],
      'grok and claude carriers must be version-independent (distinct sidecar keys)',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: never overwrites an edited AGENTS.md on re-scaffold (seed-once identity)', () => {
  const workDir = mktmp('grok-agents-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'grok', 'AGENTS.md');

    // The worker/human edits its identity; a relaunch must preserve it verbatim.
    const edited = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(agentsPath, edited, 'utf-8');
    const before = fs.readFileSync(agentsPath);

    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    const after = fs.readFileSync(agentsPath);
    assert.ok(
      before.equals(after),
      'second scaffold call must not overwrite an edited grok AGENTS.md',
    );
    // And no .bak was spawned (the managed-file overwrite signature) — proves
    // AGENTS.md is seeded, not version-managed.
    const baks = fs.readdirSync(path.dirname(agentsPath)).filter((f) => f.startsWith('AGENTS.md.bak'));
    assert.equal(baks.length, 0, `grok AGENTS.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: NO .grok/hooks carrier and NO remember skill in the minimum scope', () => {
  const workDir = mktmp('grok-no-extras');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    // No native grok hook carrier — grok rides the single claude-compat carrier
    // (two active carriers risk the codex Run-D double-fire).
    const grokHooksDir = path.join(workDir, '.lares', 'workers', 'grok', '.grok', 'hooks');
    assert.ok(!fs.existsSync(grokHooksDir), `no .grok/hooks carrier must be created; found ${grokHooksDir}`);
    const grokConfigPath = path.join(workDir, '.lares', 'workers', 'grok', '.grok', 'config.toml');
    if (fs.existsSync(grokConfigPath)) {
      const grokConfig = fs.readFileSync(grokConfigPath, 'utf-8');
      assert.ok(!/^\s*\[hooks(?:\.|\])/.test(grokConfig),
        `grok config.toml must not define a [hooks] table; got:\n${grokConfig}`);
    }

    // No remember skill in this commit (plan §2.5).
    const rememberClaude = path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'skills', 'remember', 'SKILL.md');
    const rememberAgents = path.join(workDir, '.lares', 'workers', 'grok', '.agents', 'skills', 'remember', 'SKILL.md');
    assert.ok(!fs.existsSync(rememberClaude), `no remember skill (.claude) in minimum scope; found ${rememberClaude}`);
    assert.ok(!fs.existsSync(rememberAgents), `no remember skill (.agents) in minimum scope; found ${rememberAgents}`);

    // Grok scaffold must not create the claude/codex worker sibling lanes.
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json')),
      'grok scaffold must not write the claude worker carrier',
    );
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml')),
      'grok scaffold must not write the codex worker carrier',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Grok worker cwd is git-init'd (Commit 6 — inert-carrier fix) ─────
//
// grok resolves its projectRoot to the NEAREST `.git` ancestor of the cwd and
// only loads `<projectRoot>/.claude/settings.json`. The carrier lives at the
// worker cwd (a subdir), so unless the worker cwd is its own git repo the
// carrier is never read and the status hooks + git-discard guard go inert.
// ensureWorkerScaffold therefore `git init`s the worker cwd. These tests drive
// the REAL git binary (present in the build env); the git-unavailable case is
// forced by clearing PATH so `git` cannot resolve.

test('Grok: fresh scaffold git-inits the worker cwd (.lares/workers/grok/.git exists)', () => {
  const workDir = mktmp('grok-gitinit');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const gitDir = path.join(workDir, '.lares', 'workers', 'grok', '.git');
    assert.ok(
      fs.existsSync(gitDir),
      `expected the worker cwd to be its own git repo at ${gitDir} (grok projectRoot = nearest .git)`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: healthy repo takes the verified no-init fast path', () => {
  const workDir = mktmp('grok-gitinit-noop');
  try {
    fs.mkdirSync(path.join(workDir, '.git'));
    const calls: string[][] = [];
    ensureWorkerGitRepoRoot(workDir, 'grok', (args) => {
      calls.push(args);
      return `${workDir}\n`;
    });
    assert.deepEqual(calls, [['rev-parse', '--show-toplevel']], 'healthy repo must verify once and skip git init');
  } finally {
    rmrf(workDir);
  }
});

test('Grok: corrupt .git directory is repaired before exact-root verification', () => {
  const workDir = mktmp('grok-gitinit-repair');
  const workerDir = path.join(workDir, '.lares', 'workers', 'grok');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.join(workerDir, '.git'), { recursive: true });
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const root = String(require('node:child_process').execFileSync(
      'git', ['rev-parse', '--show-toplevel'], { cwd: workerDir, encoding: 'utf-8' },
    )).trim();
    assert.equal(path.resolve(root).toLowerCase(), path.resolve(workerDir).toLowerCase());
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: git unavailable refuses scaffold with a clear launch error', () => {
  const workDir = mktmp('grok-gitinit-nogit');
  const { supervisor, cleanup } = makeSupervisor();
  const origPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(
      () => supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows'),
      /Cannot launch Grok worker:.*must be its own Git repository root; status hooks and the git-discard guard cannot load.*git init failed/is,
    );
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'settings.json')),
      'scaffold files may be repaired before the pre-launch refusal',
    );
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'grok', '.git')),
      'no .git should exist when git is unavailable',
    );
  } finally {
    process.env.PATH = origPath;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: git init failure is also a loud refusal', () => {
  const workDir = mktmp('agy-gitinit-nogit');
  const fakeHome = path.join(workDir, 'fake-home');
  const priorUserProfile = process.env.USERPROFILE;
  const priorPath = process.env.PATH;
  process.env.USERPROFILE = fakeHome;
  process.env.PATH = '';
  const { supervisor, cleanup } = makeSupervisor();
  try {
    assert.throws(
      () => supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows'),
      /Cannot launch Antigravity worker:.*must be its own Git repository root; workspace hooks cannot load.*git init failed/is,
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

// ── Antigravity worker scaffold (agy plan Commit 2 + Phase-0 addendum) ──

test('Agy: fresh scaffold seeds a flat workspace hook carrier in its own git root', () => {
  const workDir = mktmp('agy-scaffold');
  const fakeHome = path.join(workDir, 'fake-home');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');

    const workerDir = path.join(workDir, '.lares', 'workers', 'agy');
    assert.equal(
      fs.readFileSync(path.join(workerDir, 'AGENTS.md'), 'utf-8'),
      WORKER_AGY_AGENTS_MD,
      'agy AGENTS.md must be the exact derived seed body',
    );
    assert.ok(
      !fs.existsSync(path.join(workerDir, 'GEMINI.md')),
      'the plan designates one AGENTS.md identity; do not duplicate it through GEMINI.md',
    );
    const carrierPath = path.join(workerDir, '.agents', 'hooks.json');
    assert.ok(fs.existsSync(carrierPath), 'workspace .agents/hooks.json must be scaffolded');
    const carrier = JSON.parse(fs.readFileSync(carrierPath, 'utf-8')) as any;
    const handlers = carrier[AGY_STATUS_HOOK_NAME].PreInvocation;
    assert.equal(handlers.length, 1);
    assert.equal(typeof handlers[0].command, 'string');
    assert.ok(!('matcher' in handlers[0]) && !('hooks' in handlers[0]), 'PreInvocation must be flat');
    const stopHandlers = carrier[AGY_STATUS_HOOK_NAME].Stop;
    assert.equal(stopHandlers.length, 1);
    assert.ok(!('matcher' in stopHandlers[0]) && !('hooks' in stopHandlers[0]), 'Stop must be flat');
    assert.ok(!fs.readFileSync(carrierPath, 'utf-8').includes('${'));
    assert.ok(fs.existsSync(path.join(workerDir, '.git')), 'agy worker cwd must be a git root');
    assert.ok(fs.existsSync(path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs')));

    const generated = JSON.parse(workerAgyHooksJson('C:\\Workspace With Space', 'C:\\Node Runtime\\node.cmd')) as any;
    const encoded = generated[AGY_STATUS_HOOK_NAME].PreInvocation[0].command.match(/-EncodedCommand\s+(\S+)$/)?.[1];
    const invocation = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(invocation, /& "C:\/Node Runtime\/node\.cmd" "C:\/Workspace With Space\/\.lares\/scripts\/dashboard-status\.mjs" working --event PreInvocation/);
    const stopEncoded = generated[AGY_STATUS_HOOK_NAME].Stop[0].command.match(/-EncodedCommand\s+(\S+)$/)?.[1];
    const stopInvocation = Buffer.from(stopEncoded, 'base64').toString('utf16le');
    assert.match(stopInvocation, /& "C:\/Node Runtime\/node\.cmd" "C:\/Workspace With Space\/\.lares\/scripts\/dashboard-status\.mjs" --event Stop/);
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: re-scaffold preserves identity + foreign global hooks and removes obsolete global entry', () => {
  const workDir = mktmp('agy-idempotent');
  const fakeHome = path.join(workDir, 'fake-home');
  const hooksPath = path.join(fakeHome, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, '{"human-hook":{"PreInvocation":null},"lares-dashboard-status":{"PreInvocation":[]}}\n', 'utf-8');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'agy', 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# user-owned agy identity\n', 'utf-8');
    const hooksAfterFirst = fs.readFileSync(hooksPath, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');

    assert.equal(fs.readFileSync(agentsPath, 'utf-8'), '# user-owned agy identity\n');
    assert.equal(fs.readFileSync(hooksPath, 'utf-8'), hooksAfterFirst, 'second merge must be a no-op');
    const hooks = JSON.parse(hooksAfterFirst) as Record<string, unknown>;
    assert.deepEqual(hooks['human-hook'], { PreInvocation: null }, 'foreign named hook must survive');
    assert.ok(!(AGY_STATUS_HOOK_NAME in hooks), 'obsolete global hook must be removed');
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: malformed global hooks config is never clobbered', () => {
  const workDir = mktmp('agy-malformed-hooks');
  const fakeHome = path.join(workDir, 'fake-home');
  const hooksPath = path.join(fakeHome, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const malformed = '{ user-owned malformed json';
  fs.writeFileSync(hooksPath, malformed, 'utf-8');
  const priorUserProfile = process.env.USERPROFILE;
  const priorWarn = console.warn;
  process.env.USERPROFILE = fakeHome;
  console.warn = () => {};
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    assert.equal(fs.readFileSync(hooksPath, 'utf-8'), malformed);
  } finally {
    console.warn = priorWarn;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy identity: derived cwd and provider-neutral question protocol stay correct', () => {
  assert.ok(WORKER_AGY_AGENTS_MD.includes('.lares/workers/agy/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('.lares/workers/claude/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('.lares/workers/codex/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('AskUserQuestion'));
  assert.ok(WORKER_AGY_AGENTS_MD.includes('end your turn with the question in plain text'));
  assert.ok(WORKER_AGY_AGENTS_MD.includes('Never use git to discard uncommitted work'));
});

// ── Grok identity derivation parity (anti-drift, plan §2.1) ──────────
//
// WORKER_GROK_AGENTS_MD is DERIVED from WORKER_CLAUDE_MD via the same
// `.split().join()` chain WORKER_CODEX_AGENTS_MD uses — NOT reused from the codex
// body. These guard against drift and against accidentally shipping codex tokens.

test('Grok identity: derived cwd points at the grok lane, never claude or codex', () => {
  assert.ok(WORKER_GROK_AGENTS_MD.includes('.lares/workers/grok/'), 'grok body must reference its own cwd');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('.lares/workers/claude/'), 'grok body must not reference the claude cwd');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('.lares/workers/codex/'), 'grok body must not reference the codex cwd (not reused from WORKER_CODEX_AGENTS_MD)');
});

test('Grok identity: git-discard section survived byte-identical; blocking-dialog intent preserved', () => {
  const header = '## Never use git to discard uncommitted work';
  const i = WORKER_GROK_AGENTS_MD.indexOf(header);
  assert.ok(i >= 0, 'grok body must carry the git-discard section');
  // The section contains none of the transformed tokens, so it must enumerate
  // the four forbidden commands verbatim.
  assert.ok(
    WORKER_GROK_AGENTS_MD.includes('git checkout -- <file>') &&
      WORKER_GROK_AGENTS_MD.includes('git restore') &&
      WORKER_GROK_AGENTS_MD.includes('git clean') &&
      WORKER_GROK_AGENTS_MD.includes('git stash'),
    'the git-discard section must still enumerate the four forbidden commands',
  );
  // Claude-Code-specific dialog names gone; the intent preserved.
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('AskUserQuestion'), 'grok body must not name the Claude-specific AskUserQuestion tool');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('plan-mode approval prompts'), 'grok body must not name Claude plan-mode prompts');
  assert.ok(WORKER_GROK_AGENTS_MD.includes('end your turn with the question in plain text'), 'intent: end the turn in plain text preserved');
});

// ── WP-P0C: proposal-to-plan skill tree on the worker lanes ──────────

const P2P_REL_FILES = [
  'SKILL.md',
  'references/activities/scope.md',
  'references/activities/promote.md',
  'references/activities/deliberate.md',
  'references/activities/integrate.md',
  'references/activities/package.md',
  'references/activities/orient.md',
  'references/contracts/arc.md',
  'references/contracts/folder-schema.md',
  'references/contracts/intent-lifecycle.md',
  'references/contracts/manifest-lock.md',
  'scripts/plan-manifest.mjs',
];

test('WP-P0C: fresh Claude worker scaffold writes the whole proposal-to-plan tree under .claude/skills', () => {
  const workDir = mktmp('p2p-worker-claude');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    const root = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'skills', 'proposal-to-plan');
    for (const rel of P2P_REL_FILES) {
      assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `claude worker root missing ${rel}`);
    }
    assert.ok(!fs.existsSync(path.join(root, 'references', 'activities', 'capture.md')),
      'retired capture.md must not be written to a fresh Claude worker scaffold');
    assert.equal(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8'), PROPOSAL_TO_PLAN_SKILL_MD,
      'SKILL.md must be the exact bundled content');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-P0C: fresh Codex worker scaffold writes the whole proposal-to-plan tree under .agents/skills', () => {
  const workDir = mktmp('p2p-worker-codex');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    const root = path.join(workDir, '.lares', 'workers', 'codex', '.agents', 'skills', 'proposal-to-plan');
    for (const rel of P2P_REL_FILES) {
      assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `codex worker root missing ${rel}`);
    }
    assert.ok(!fs.existsSync(path.join(root, 'references', 'activities', 'capture.md')),
      'retired capture.md must not be written to a fresh Codex worker scaffold');
    assert.equal(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8'), PROPOSAL_TO_PLAN_SKILL_MD,
      'SKILL.md must be the exact bundled content in the codex root');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('wp1h-land-work-package-executes-complete-step-7', () => {
  const repoDir = mktmp('wp1g-cacheinfo-add');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const git = (args: string[], options: Record<string, unknown> = {}): Buffer =>
      execFileSync('git', args, { cwd: repoDir, ...options });
    git(['init', '--quiet']);
    fs.writeFileSync(path.join(repoDir, 'rename-source.txt'), 'rename source\n');
    git(['add', '--', 'rename-source.txt']);
    git(['-c', 'user.name=Lares Test', '-c', 'user.email=lares@example.invalid',
      'commit', '--quiet', '-m', 'base']);

    supervisor.ensureWorkerScaffold(repoDir, 'codex', 'windows');
    const deployedSkill = fs.readFileSync(path.join(
      repoDir, '.lares', 'workers', 'codex', '.agents', 'skills',
      'land-work-package', 'SKILL.md',
    ), 'utf8');
    assert.ok(LAND_WORK_PACKAGE_SKILL_MD_V7.includes('`git ls-tree -z` proves'),
      'WP-1h precondition: frozen v7 must contain the stale bare ls-tree bullet');
    assert.equal(deployedSkill.includes('`git ls-tree -z` proves'), false,
      'WP-1h deployed v8 must remove the stale bare ls-tree bullet');
    const appendixStart = deployedSkill.indexOf('## windows-partial-staging-blob');
    const appendixEnd = deployedSkill.indexOf(
      '\n## commit-prepared-index-not-pathspec', appendixStart,
    );
    assert.ok(appendixStart >= 0 && appendixEnd > appendixStart,
      'WP-1h executed step-7 test must find the Windows appendix');
    const appendix = deployedSkill.slice(appendixStart, appendixEnd);
    const documented = appendix.match(
      /`(git update-index (?:--add )?--cacheinfo <mode>,<oid>,<path>)`/,
    )?.[1];
    assert.ok(documented, 'WP-1h executed step-7 test must extract the documented command');

    const indexPath = path.join(repoDir, 'candidate.index');
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    git(['read-tree', 'HEAD'], { env });
    const newOid = git(['hash-object', '-w', '--stdin'], {
      input: Buffer.from('genuinely new\n'),
    }).toString('utf8').trim();
    const renameOid = git(['hash-object', '-w', '--stdin'], {
      input: Buffer.from('rename target\n'),
    }).toString('utf8').trim();

    const runDocumentedInstall = (oid: string, repoPath: string): void => {
      const command = documented
        .replace('<mode>', '100644')
        .replace('<oid>', oid)
        .replace('<path>', repoPath);
      const [program, ...args] = command.split(/\s+/);
      execFileSync(program, args, { cwd: repoDir, env });
    };
    runDocumentedInstall(newOid, 'genuinely-new.txt');
    runDocumentedInstall(renameOid, 'rename-target.txt');
    git(['update-index', '--force-remove', '--', 'rename-source.txt'], { env });
    const tree = git(['write-tree'], { env }).toString('utf8').trim();
    const base = git(['rev-parse', 'HEAD']).toString('utf8').trim();
    const branchRef = git(['symbolic-ref', 'HEAD']).toString('utf8').trim();
    const message = `[worker] WP-1h: execute complete step 7

Plan: plan_test
WP: WP-1h
Verified: complete step 7
Scope-omitted: none
`;
    const candidate = git([
      '-c', 'user.name=Lares Test', '-c', 'user.email=lares@example.invalid',
      'commit-tree', tree, '-p', base,
    ], { input: Buffer.from(message) }).toString('utf8').trim();

    assert.equal(git(['rev-parse', `${candidate}^`]).toString('utf8').trim(), base,
      'step 7 must prove the candidate sole parent is BASE');
    const committedMessage = git(['show', '-s', '--format=%B', candidate]);
    const parsedTrailers = git(['interpret-trailers', '--parse'], {
      input: committedMessage,
    }).toString('utf8');
    for (const key of ['Plan', 'WP', 'Verified', 'Scope-omitted']) {
      assert.equal(parsedTrailers.split('\n').filter((line) => line.startsWith(`${key}: `)).length, 1,
        `step 7 must parse exactly one ${key} trailer`);
      assert.equal(committedMessage.toString('utf8').split('\n')
        .filter((line) => line.startsWith(`${key}: `)).length, 1,
      `step 7 must find exactly one physical ${key} trailer line`);
    }
    assert.equal(committedMessage.toString('utf8').split('\n')
      .some((line) => /^[ \t]/.test(line)), false,
    'step 7 message must contain no folded physical trailer lines');

    const plainNumstat = git([
      'diff-tree', '-r', '--no-renames', '--numstat', base, candidate,
    ]);
    const crIgnoredNumstat = git([
      'diff-tree', '-r', '--no-renames', '--ignore-cr-at-eol', '--numstat', base, candidate,
    ]);
    assert.deepEqual(plainNumstat, crIgnoredNumstat,
      'step 7 numstat outputs must be byte-identical');

    const frozenPaths = ['genuinely-new.txt', 'rename-source.txt', 'rename-target.txt'];
    const candidatePaths = git([
      'diff-tree', '-r', '-z', '--no-renames', '--name-only', base, candidate,
    ]).toString('utf8').split('\0').filter(Boolean);
    assert.deepEqual(candidatePaths, frozenPaths,
      'step 7 NUL-delimited candidate path set must equal the frozen set');

    const records = git(['ls-tree', '-r', '-z', candidate, '--', ...frozenPaths]).toString('utf8')
      .split('\0').filter(Boolean);
    const entries = new Map(records.map((record) => {
      const match = record.match(/^(\d+) blob ([0-9a-f]+)\t(.*)$/s);
      assert.ok(match, `unexpected ls-tree record: ${JSON.stringify(record)}`);
      return [match[3], { mode: match[1], oid: match[2] }];
    }));
    assert.deepEqual(entries.get('genuinely-new.txt'), { mode: '100644', oid: newOid });
    assert.deepEqual(entries.get('rename-target.txt'), { mode: '100644', oid: renameOid });
    assert.equal(entries.has('rename-source.txt'), false,
      'rename source must be ABSENT after --force-remove');
    git(['update-ref', '--create-reflog', branchRef, candidate, base]);
    assert.equal(git(['rev-parse', branchRef]).toString('utf8').trim(), candidate,
      'step 8 CAS must advance the branch ref to CANDIDATE');
  } finally {
    cleanup();
    rmrf(repoDir);
  }
});

test('wp1-land-work-package-both-lanes', () => {
  const claudeWorkDir = mktmp('land-wp-claude');
  const codexWorkDir = mktmp('land-wp-codex');
  const { supervisor, cleanup } = makeSupervisor();
  const marker = 'REACHABILITY:wp1-land-work-package-both-lanes';
  try {
    // Frozen SHA-256 values computed from the dispatch-tip runtime bodies before
    // WP-1h edited the file; these guard every deployed historical body.
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V1).digest('hex'),
      'c6b725d512a160d0644b6656e6a4b8c22abc5c36d27ebcc2e59a5decfa36b99c');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V2).digest('hex'),
      'd97b84d641560574b2f9678b22a24c2b650ac17559fa2cb62c1d68be0941deb8');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V3).digest('hex'),
      'daaf43602edd1eb682fbf7744a326fb9f56dca548b863a7b0625aa420e70cf5f');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V4).digest('hex'),
      'd04568a13e8e548503edca3a605afeb4ff633c7225e78aff736fc4d1d0ace756');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V5).digest('hex'),
      '14533fa7e6eb0906c963cb7beb0f9716d9aa960ab4dcd096406f6fa3cc465579');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V6).digest('hex'),
      '1406b367736cad82c20666264c528e6067e10e9fc9a9972f7adb1a4fce673248');
    assert.equal(createHash('sha256').update(LAND_WORK_PACKAGE_SKILL_MD_V7).digest('hex'),
      '961652d4f6d14b006d8ad76932dedd6817adcbd422d56ace1322d5585adb9faa');

    const v3ReplacementLiterals = [
      `4. For a shared file, reconstruct the exact owned post-image from \`BASE:path\`
   plus only owned hunks. Write the scratch post-image as raw bytes with no CRLF
   conversion and no BOM. For example, resolve the base blob OID and use
   \`git cat-file blob <oid> > <file>\` in Git Bash, or PowerShell
   \`[IO.File]::WriteAllBytes(...)\`; never use \`Set-Content\`, \`Out-File\`, or
   text redirection. \`git hash-object -w\` accepts either a file path or
   \`--stdin\`. After hashing, require \`git diff <base-oid> <new-oid>\` to show
   only the owned hunks and no whole-file line-ending churn. Preserve the exact
   mode and install the blob with
   \`git update-index --cacheinfo <mode>,<oid>,<path>\`. If reconstruction is
   uncertain, stop. For explicit deletions use
   \`git update-index --force-remove -- <path>\` and expect absence even when the
   worktree file is still present.`,
      `   - the complete message satisfies the contract, using
     \`git interpret-trailers --parse\` plus explicit key counts over the full
     message to reject duplicates and folded physical lines;
   - \`git diff-tree -r -z --no-renames BASE CANDIDATE\` yields a NUL-safe path
     set exactly equal to the frozen set; and`,
    ];
    for (const [index, literal] of v3ReplacementLiterals.entries()) {
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V2.split(literal).length - 1, 1,
        `${marker}: v3 replacement literal ${index + 1} must match v2 exactly once`);
    }

    const v4ReplacementLiterals = [
      `4. For a shared file, start from the repository blob bytes, NEVER from the
   worktree file: reconstruct the exact owned post-image from
   \`git cat-file blob BASE:<path>\` plus only owned hunks. Preserve those raw
   bytes, for example with \`git cat-file blob BASE:<path> > <file>\` under Git
   Bash or PowerShell \`[IO.File]::WriteAllBytes\` after \`git cat-file --batch\`.
   This checkout uses \`core.autocrlf=true\`: worktree files are CRLF while
   repository blobs are LF, so a worktree-derived post-image re-encodes every
   line. Never use \`Set-Content\`, \`Out-File\`, or text redirection in
   PowerShell. Hash the finished raw-byte post-image with \`git hash-object -w\`.

   Before \`git update-index --cacheinfo\` installs the new blob, state the
   expected added and deleted line counts for the worker's intended hunks. Run
   \`git diff --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\` and
   \`git diff --ignore-cr-at-eol --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\`.
   The outputs MUST be identical, and added plus deleted MUST equal the stated
   intended hunk line count. Also inspect the blob prefix and reject a new UTF-8
   BOM (bytes \`EF BB BF\`) when the base blob did not have one. Any mismatch
   means abort: do not install the blob and do not commit. Preserve the base
   mode and install only a blob that passes every gate with
   \`git update-index --cacheinfo <mode>,<oid>,<path>\`. If reconstruction is
   uncertain, stop. For explicit deletions use
   \`git update-index --force-remove -- <path>\` and expect absence even when the
   worktree file is still present.`,
      `   - \`git diff-tree -r --numstat BASE CANDIDATE\` equals
     \`git diff-tree -r --ignore-cr-at-eol --numstat BASE CANDIDATE\`
     line-for-line; any mismatch aborts before the update-ref CAS;`,
      `On Windows, do not depend on interactive \`git add -p\` or filtered
\`git apply --cached\` for a shared CRLF file. Reconstruct \`BASE:path\` in a
scratch artifact, replay only owned literal old-to-new replacements, assert each
old block matches exactly once, and select hunks by distinctive content rather
than shifting line numbers. The write side is byte-oriented: use
\`[IO.File]::WriteAllBytes\` (or Git Bash \`git cat-file blob <oid> > <file>\`),
never \`Set-Content\`, \`Out-File\`, or text redirection. Hash the file by path or
with \`hash-object -w --stdin\`, then diff the base and new blob OIDs to reject
BOM or line-ending churn before installing its exact mode with \`update-index
--cacheinfo\`.`,
    ];
    for (const [index, literal] of v4ReplacementLiterals.entries()) {
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V3.split(literal).length - 1, 1,
        `${marker}: v4 replacement literal ${index + 1} must match v3 exactly once`);
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V4.split(literal).length - 1, 0,
        `${marker}: v4 replacement literal ${index + 1} must be absent from v4`);
    }

    const v5ReplacementLiterals = [
      `3. For whole-file owned paths use \`git add -- <exact paths>\` only inside the
   temporary index. It preserves modes and handles additions/deletions.`,
      `4. For a shared file, start from the repository blob bytes, NEVER from the
   worktree file: reconstruct the exact owned post-image from
   \`git cat-file blob BASE:<path>\` plus only owned hunks. The worktree MAY
   differ from repository blob bytes because of \`core.autocrlf\` or
   \`.gitattributes\`; preserve the \`cat-file\` bytes exactly and never normalize
   line endings in either direction. Use byte-oriented writes such as
   \`[IO.File]::WriteAllBytes\`; never use \`Set-Content\`, \`Out-File\`, or text
   redirection in PowerShell. Hash the finished raw-byte post-image with
   \`git hash-object -w\`.

   Before running the diff, state the expected numstat pair (added, deleted) for
   the edit. A one-line substitution is \`1\\t1\`. Run
   \`git diff --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\` and
   \`git diff --ignore-cr-at-eol --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\`.
   The two numstat outputs MUST be byte-identical, and their added/deleted
   columns MUST equal the pre-stated pair. Numstat equality does NOT catch a new
   BOM: inspect the blob prefix as the only BOM guard, and reject leading bytes
   \`EF BB BF\` when the base blob had none. Any mismatch means abort: do not
   install the blob and do not commit. Preserve the base mode and install only a
   blob that passes every gate with \`git update-index --cacheinfo
   <mode>,<oid>,<path>\`. If reconstruction is uncertain, stop. For explicit
   deletions use \`git update-index --force-remove -- <path>\` and expect absence
   even when the worktree file is still present.

   The step-7 diff-tree check is commit-wide. A path staged with plain \`git add\`
   in step 3 can still abort the CAS when its repository blob stores CRLF but
   \`autocrlf\` re-encodes it as LF. Whole-file owners of CRLF-stored blobs MUST
   use this same prepared-blob and \`update-index --cacheinfo\` path.`,
      `   - \`git diff-tree -r --no-renames --numstat BASE CANDIDATE\` equals
     \`git diff-tree -r --no-renames --ignore-cr-at-eol --numstat BASE CANDIDATE\`
     byte-for-byte; any mismatch aborts before the update-ref CAS;`,
      `On Windows, do not depend on interactive \`git add -p\` or filtered
\`git apply --cached\` for a shared CRLF file. Start the post-image from
\`git cat-file blob BASE:<path>\` bytes, NEVER from worktree bytes, replay only
owned literal old-to-new replacements, and assert each old block matches exactly
once. Preserve the base bytes exactly and use byte-oriented writes such as
\`[IO.File]::WriteAllBytes\`; never normalize line endings in either direction.
Before installing the prepared blob, apply the same step-4 gates: pre-state the
expected (added, deleted) pair; require \`git diff --numstat
<BASE_BLOB_OID> <NEW_BLOB_OID>\` and \`git diff --ignore-cr-at-eol --numstat
<BASE_BLOB_OID> <NEW_BLOB_OID>\` to be byte-identical with added/deleted columns
equal to that pair; and inspect the prefix as the only BOM guard, rejecting
leading \`EF BB BF\` when the base blob had none. Install its exact mode only
after every gate passes, using \`git update-index --cacheinfo\`.`,
    ];
    for (const [index, literal] of v5ReplacementLiterals.entries()) {
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V4.split(literal).length - 1, 1,
        `${marker}: v5 replacement literal ${index + 1} must match v4 exactly once`);
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(literal).length - 1, 0,
        `${marker}: v5 replacement literal ${index + 1} must be absent from v5`);
    }

    const v6ReplacementLiterals = [
      `3. For whole-file owned paths, plain \`git add -- <exact paths>\` is allowed
   only inside the temporary index and only when an existing text path's
   worktree bytes outside the owned hunks equal the bytes from
   \`git cat-file blob BASE:<path>\`. Prove that with a byte comparison: extract
   the base blob, remove the same owned byte ranges from base and worktree
   copies, then require Git Bash \`cmp -s <base-outside-owned>
   <worktree-outside-owned>\` or PowerShell
   \`[Linq.Enumerable]::SequenceEqual(<base-bytes>, <worktree-bytes>)\` to
   succeed. If bytes outside the owned hunks differ, the path is subject to
   filtering and MUST use the step-4 prepared-blob plus
   \`git update-index --cacheinfo\` path; any comparison failure MUST abort.
   This includes CRLF-stored blobs whose worktree bytes are filtered by
   \`core.autocrlf\`. Plain \`git add\` is permitted only after the outside-hunk
   byte comparison passes. Additions and deletions still preserve their exact
   intended modes through the temporary index.`,
      `4. For a shared or filtered existing text file, start from repository blob
   bytes, NEVER from the worktree file: reconstruct the exact owned post-image
   from \`git cat-file blob BASE:<path>\` plus only owned hunks. The worktree MAY
   differ because of \`core.autocrlf\` or \`.gitattributes\`; preserve the
   \`cat-file\` bytes exactly. Use byte-oriented writes such as
   \`[IO.File]::WriteAllBytes\`; never use \`Set-Content\`, \`Out-File\`, or text
   redirection in PowerShell. Hash the raw-byte post-image with
   \`git hash-object -w\`.

   Before running the diff, pre-state the expected numstat pair (added, deleted)
   and the expected CR count. A one-line substitution is \`1\\t1\`. Run exactly
   \`git diff --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\` and
   \`git diff --ignore-cr-at-eol --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\`.
   The two outputs MUST be byte-identical and their columns MUST equal the
   pre-stated pair. This equality does NOT detect line-ending churn on lines
   edited anyway, and it does NOT detect a BOM.

   Add a byte-level EOL gate. Count CR bytes in each blob with Git Bash
   \`git cat-file blob <oid> | tr -cd '\\r' | wc -c\`, or count byte \`0x0D\`
   in PowerShell after \`git cat-file --batch\`. Pre-state
   \`EXPECTED_CR = BASE_CR + ADDED_HUNK_CR - DELETED_HUNK_CR\`, where the hunk
   terms are CR bytes in the exact intended added and deleted line slices. If
   \`BASE_CR\` is zero, \`NEW_CR\` MUST be zero. Otherwise the new CR count MUST
   equal the pre-stated expected CR count. Any CR mismatch MUST abort.

   Inspect each prefix with \`git cat-file blob <oid> | head -c 3 | xxd -p\`
   (or compare the first three PowerShell bytes) for \`EF BB BF\`. BOM presence
   MUST be unchanged between base and new blob. Any BOM mismatch MUST abort.
   Do not install or commit after any gate failure. Preserve the base mode and
   install only a blob that passes every gate with
   \`git update-index --cacheinfo <mode>,<oid>,<path>\`. If reconstruction is
   uncertain, stop. For explicit deletions use
   \`git update-index --force-remove -- <path>\` and expect absence even when the
   worktree file is still present.`,
      `   - \`git diff-tree -r --no-renames --numstat BASE CANDIDATE\` equals
     \`git diff-tree -r --no-renames --ignore-cr-at-eol --numstat BASE CANDIDATE\`
     byte-for-byte; any mismatch MUST abort before the update-ref CAS;
   - run \`git diff-tree -r --no-renames --name-status BASE CANDIDATE\` and, for
     EVERY \`M\` entry, resolve both blob OIDs with \`git rev-parse
     BASE:<path>\` and \`git rev-parse CANDIDATE:<path>\` (or \`git ls-tree\`).
     Before checking, pre-state the intended hunk numstat and
     \`EXPECTED_CR = BASE_CR + ADDED_HUNK_CR - DELETED_HUNK_CR\` for each path.
     Count CR bytes with \`git cat-file blob <oid> | tr -cd '\\r' | wc -c\`.
     For an LF-only base, candidate CR count MUST be zero; otherwise the new CR
     count MUST equal the pre-stated expected CR count. Compare each prefix with
     \`git cat-file blob <oid> | head -c 3 | xxd -p\` for \`EF BB BF\`; BOM
     presence MUST be unchanged between base and candidate blob. This applies
     to all modified existing text paths, not only shared paths. Any CR or BOM
     mismatch MUST abort before the update-ref CAS;`,
      `On Windows, do not depend on interactive \`git add -p\` or filtered
\`git apply --cached\` for a shared or filtered text file. Start the post-image
from \`git cat-file blob BASE:<path>\` bytes, NEVER from worktree bytes, replay
only owned literal old-to-new replacements, and assert each old block matches
exactly once. Preserve base bytes and use byte-oriented writes such as
\`[IO.File]::WriteAllBytes\`; never normalize line endings in either direction.

Before installing the prepared blob, pre-state the expected numstat pair and
\`EXPECTED_CR = BASE_CR + ADDED_HUNK_CR - DELETED_HUNK_CR\`. Require exactly
\`git diff --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\` and
\`git diff --ignore-cr-at-eol --numstat <BASE_BLOB_OID> <NEW_BLOB_OID>\` to be
byte-identical with columns equal to the pre-stated pair. Numstat equality does
NOT detect line-ending churn on edited lines and does NOT detect a BOM. Count CR
bytes with \`git cat-file blob <oid> | tr -cd '\\r' | wc -c\`: when
\`BASE_CR\` is zero, \`NEW_CR\` MUST be zero; otherwise the new CR count MUST
equal the pre-stated expected CR count. Any CR mismatch MUST abort.

Compare each three-byte prefix with
\`git cat-file blob <oid> | head -c 3 | xxd -p\` for \`EF BB BF\`. BOM presence
MUST be unchanged between base and new blob. Any BOM mismatch MUST abort. Only
after every gate passes may the exact base mode be installed with
\`git update-index --cacheinfo <mode>,<oid>,<path>\`.`,
    ];
    for (const [index, literal] of v6ReplacementLiterals.entries()) {
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V5.split(literal).length - 1, 1,
        `${marker}: v6 replacement literal ${index + 1} must match v5 exactly once`);
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(literal).length - 1, 0,
        `${marker}: v6 replacement literal ${index + 1} must be absent from v6`);
    }

    const v7ReplacementLiterals = [
      `Before step 3, declare a manifest for EVERY path in the frozen set in the
turn record or commit-time notes. Each line is exactly \`<path> <mode> <expected
post-image blob OID>\`, or \`<path> ABSENT\` for a deletion. Build each expected
post-image from raw \`git cat-file blob BASE:<path>\` bytes plus only owned hunks,
or from the worker-controlled raw bytes for a genuinely new file, then run
\`git hash-object -w <raw-post-image>\`. Whole-file owners and new files are not
exempt. Declare a rename as an ABSENT old path plus a new path with mode and OID.
If any path, mode, or expected OID is uncertain, MUST abort before index mutation.

3. Install EVERY declared present path only with \`git update-index --cacheinfo
   <mode>,<oid>,<path>\`. Install EVERY declared deletion only with
   \`git update-index --force-remove -- <path>\`. Plain \`git add\` is REMOVED
   from this recipe because clean filters may rewrite even a whole-file owner's
   bytes. The declared manifest, not worktree content, is staging authority.`,
      `   These numstat, CR-count, and BOM checks are advisory sanity checks on the way
   to the declared OID. They are not landing gates and cannot prove byte equality.
   Only the declared mode/OID manifest is the landing gate.`,
      `5. Freeze the intended changed-path set as repo-relative literal paths and each
   intended tree entry as mode plus blob OID, or \`absent\` for a deletion.`,
      `   - \`git diff-tree -r --no-renames --name-only BASE CANDIDATE\` MUST yield
     exactly the frozen set, using NUL-safe comparison where paths are consumed;`,
      `Freeze a rename
as both entries: the old path expected absent and the new path expected present.`,
      `The resulting OID MUST equal the declared OID. Install present entries only with
\`git update-index --cacheinfo <mode>,<oid>,<path>\` and deletions only with`,
    ];
    for (const [index, literal] of v7ReplacementLiterals.entries()) {
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V6.split(literal).length - 1, 1,
        `${marker}: v7 replacement literal ${index + 1} must match v6 exactly once`);
      assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(literal).length - 1, 0,
        `${marker}: v7 replacement literal ${index + 1} must be absent from v7`);
    }

    const v8OldLiteral = `     byte-exact content. No CR-count, BOM, or numstat heuristic can substitute,
     and none is needed for \`A\` or \`D\` entries;
   - \`git diff-tree -r -z --no-renames BASE CANDIDATE\` yields a NUL-safe path
     set exactly equal to the frozen set; and
   - \`git ls-tree -z\` proves each exact mode/blob and every deletion's absence.
     Do not call \`rev-parse CANDIDATE:path\` for a deleted path.`;
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V7.split(v8OldLiteral).length - 1, 1,
      `${marker}: v8 old literal must match v7 exactly once`);
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(v8OldLiteral).length - 1, 0,
      `${marker}: v8 old literal must be absent from v8`);

    supervisor.ensureWorkerScaffold(claudeWorkDir, 'claude', 'windows');
    supervisor.ensureWorkerScaffold(codexWorkDir, 'codex', 'windows');
    const claudeSkill = path.join(
      claudeWorkDir, '.lares', 'workers', 'claude', '.claude',
      'skills', 'land-work-package', 'SKILL.md',
    );
    const codexSkill = path.join(
      codexWorkDir, '.lares', 'workers', 'codex', '.agents',
      'skills', 'land-work-package', 'SKILL.md',
    );
    assert.ok(fs.existsSync(claudeSkill), `${marker}: Claude scaffold skill must exist`);
    assert.ok(fs.existsSync(codexSkill), `${marker}: Codex scaffold skill must exist`);
    assert.deepEqual(
      fs.readFileSync(claudeSkill),
      Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
      `${marker}: Claude scaffold skill must be byte-equal to the constant`,
    );
    assert.deepEqual(
      fs.readFileSync(codexSkill),
      Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
      `${marker}: Codex scaffold skill must be byte-equal to the constant`,
    );
    assert.ok(LAND_WORK_PACKAGE_SKILL_MD.includes('--force-remove'),
      `${marker}: v3 must force-remove deletions from the temporary index`);
    const staleDiffTree = '`git diff-tree -r -z --no-renames BASE CANDIDATE` yields';
    const staleLsTree = '`git ls-tree -z` proves';
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V7.split(staleDiffTree).length - 1, 1,
      `${marker}: v7 must contain the stale diff-tree spelling exactly once`);
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(staleDiffTree).length - 1, 0,
      `${marker}: v8 must remove the stale diff-tree spelling across the runtime`);
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD_V7.split(staleLsTree).length - 1, 1,
      `${marker}: v7 must contain the stale bare ls-tree spelling exactly once`);
    assert.equal(LAND_WORK_PACKAGE_SKILL_MD.split(staleLsTree).length - 1, 0,
      `${marker}: v8 must remove the stale bare ls-tree spelling across the runtime`);
    assert.ok(LAND_WORK_PACKAGE_SKILL_MD.includes('CANDIDATE NEW_BASE'),
      `${marker}: v3 CAS retry must use NEW_BASE as the old-value`);
    assert.ok(LAND_WORK_PACKAGE_SKILL_MD.includes('git cat-file blob BASE:<path>'),
      `${marker}: v3 shared-file post-images must start from repository blob bytes`);
    const section = (start: string, end: string): string => {
      const startIndex = LAND_WORK_PACKAGE_SKILL_MD.indexOf(start);
      const endIndex = LAND_WORK_PACKAGE_SKILL_MD.indexOf(end, startIndex);
      assert.ok(startIndex >= 0 && endIndex > startIndex,
        `${marker}: section markers must exist in order: ${start} .. ${end}`);
      return LAND_WORK_PACKAGE_SKILL_MD.slice(startIndex, endIndex);
    };
    const count = (body: string, literal: string): number => body.split(literal).length - 1;
    const manifest = section('Before step 3, declare a NUL-safe manifest', '\n4. For every modified');
    const step4 = section('4. For every modified existing path', '\n5. Freeze');
    const step5 = section('5. Freeze', '\n6. Run');
    const appendix = section(
      '## windows-partial-staging-blob',
      '\n## commit-prepared-index-not-pathspec',
    );
    const step7 = section(
      '7. Before branch advancement verify against the same `BASE`',
      '\n8. Only then run',
    );
    assert.equal(count(manifest, '<path> ABSENT'), 1,
      `${marker}: manifest declaration must define ABSENT exactly once`);
    assert.equal(count(manifest, 'git hash-object -w <raw-post-image>'), 1,
      `${marker}: manifest declaration must hash raw post-images exactly once`);
    assert.equal(count(manifest, 'git update-index --add --cacheinfo'), 1,
      `${marker}: manifest section must install present entries exactly once`);
    assert.equal(count(manifest, 'git update-index --force-remove'), 1,
      `${marker}: manifest section must install ABSENT entries exactly once`);
    assert.equal(count(manifest, 'Plain `git add` is REMOVED'), 1,
      `${marker}: manifest section must remove plain git add exactly once`);
    assert.equal(count(step4, 'git cat-file blob BASE:<path> > <raw-post-image>'), 1,
      `${marker}: step 4 must name the Git Bash byte read exactly once`);
    assert.equal(count(step4, 'PowerShell 5.1 string-converts native output and drops CR bytes'), 1,
      `${marker}: step 4 must forbid byte-unsafe PowerShell capture exactly once`);
    assert.equal(count(step4, 'git diff --numstat'), 1,
      `${marker}: step 4 must retain the plain numstat sanity check exactly once`);
    assert.equal(count(step4, 'git diff --ignore-cr-at-eol --numstat'), 1,
      `${marker}: step 4 must retain the CR-ignoring numstat sanity check exactly once`);
    assert.equal(count(step4, 'Only the declared mode/OID manifest is the landing gate'), 1,
      `${marker}: step 4 must identify the sole landing gate exactly once`);
    assert.equal(count(step4, 'git update-index --add --cacheinfo'), 1,
      `${marker}: step 4 must install present entries with --add exactly once`);
    assert.equal(count(step5, '`ABSENT`'), 1,
      `${marker}: step 5 must use ABSENT exactly once`);
    assert.equal(count(appendix, '<path> ABSENT'), 1,
      `${marker}: Windows appendix must mirror ABSENT exactly once`);
    assert.equal(count(appendix, 'git cat-file blob BASE:<path> > <raw-post-image>'), 1,
      `${marker}: Windows appendix must use the Git Bash byte read exactly once`);
    assert.equal(count(appendix, 'git ls-tree -r -z CANDIDATE'), 1,
      `${marker}: Windows appendix must mirror manifest verification exactly once`);
    assert.equal(count(appendix, 'Plain `git add` is not an install'), 1,
      `${marker}: Windows appendix must reject plain git add exactly once`);
    assert.equal(count(appendix, 'git update-index --add --cacheinfo'), 1,
      `${marker}: Windows appendix must install present entries with --add exactly once`);
    assert.equal(count(step7, 'git diff-tree -r --no-renames --numstat BASE CANDIDATE'), 1,
      `${marker}: step 7 must contain the plain no-renames numstat command exactly once`);
    assert.equal(
      count(step7, 'git diff-tree -r --no-renames --ignore-cr-at-eol --numstat BASE CANDIDATE'),
      1,
      `${marker}: step 7 must contain the CR-ignoring no-renames numstat command exactly once`,
    );
    assert.equal(count(step7, 'git diff-tree -r -z --no-renames --name-only BASE CANDIDATE'), 1,
      `${marker}: step 7 must compare the frozen path set exactly once`);
    assert.equal(count(step7, 'git ls-tree -r -z CANDIDATE -- <every frozen path>'), 1,
      `${marker}: step 7 must compare the declared manifest exactly once`);
    assert.equal(count(step7, 'ABSENT'), 1,
      `${marker}: step 7 must verify ABSENT entries exactly once`);
    assert.equal(count(step7, 'an OID match proves\n     byte-exact content'), 1,
      `${marker}: step 7 must state why OID equality is byte-exact exactly once`);
    assert.equal(count(step7, 'EVERY `M` entry'), 0,
      `${marker}: step 7 must remove the v5 M-entry-only clause`);
    assert.equal(count(LAND_WORK_PACKAGE_SKILL_MD, 'git cat-file --batch'), 0,
      `${marker}: v6 must remove the PowerShell cat-file batch variant`);
    assert.equal(count(LAND_WORK_PACKAGE_SKILL_MD, 'git add -- <exact paths>'), 0,
      `${marker}: v6 recipe must contain no plain git-add install command`);
    assert.equal(count(LAND_WORK_PACKAGE_SKILL_MD, 'git update-index --cacheinfo <mode>'), 0,
      `${marker}: v7 must contain no cacheinfo install without --add`);
    assert.equal(
      count(LAND_WORK_PACKAGE_SKILL_MD,
        'git diff-tree -r --no-renames --name-only BASE CANDIDATE'),
      0,
      `${marker}: v7 must contain no line-oriented frozen-set command`,
    );
    assert.equal(count(manifest, '`100644`, `100755`, and `120000` only'), 1,
      `${marker}: manifest must scope supported modes exactly once`);
    assert.equal(count(manifest, '`160000`\n(submodule) entry'), 1,
      `${marker}: manifest must refuse gitlinks exactly once`);
    assert.equal(count(manifest, 'entry of type `commit` at any frozen\npath'), 1,
      `${marker}: manifest must refuse base commit entries exactly once`);
    assert.equal(count(manifest, 'escalate the out-of-scope package to the supervisor'), 1,
      `${marker}: manifest must escalate gitlinks exactly once`);
    assert.equal(count(LAND_WORK_PACKAGE_SKILL_MD, '`absent`'), 0,
      `${marker}: v7 must use the canonical ABSENT token`);
    assert.equal(count(manifest, 'newline byte'), 1,
      `${marker}: manifest must reject newline-bearing paths up front`);
    assert.equal(count(appendix, 'ABSENT'), 2,
      `${marker}: Windows appendix must use ABSENT in declaration and verification`);
    assert.ok(!LAND_WORK_PACKAGE_SKILL_MD.includes('reject BOM or line-ending churn'),
      `${marker}: v5 must not retain the qualitative v2 gate`);

    const migrationCases = [
      {
        workDir: claudeWorkDir,
        provider: 'claude',
        skillPath: claudeSkill,
        sidecarKey: 'workers/claude/.claude/skills/land-work-package/SKILL.md',
      },
      {
        workDir: codexWorkDir,
        provider: 'codex',
        skillPath: codexSkill,
        sidecarKey: 'workers/codex/.agents/skills/land-work-package/SKILL.md',
      },
    ];
    for (const migration of migrationCases) {
      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V1, 'utf-8');
      const sidecarPath = path.join(
        migration.workDir,
        ...SCAFFOLD_SIDECAR_REL.split('/'),
      );
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8')) as Record<string, number>;
      sidecar[migration.sidecarKey] = 1;
      fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v1 skill must upgrade byte-exactly to v8`,
      );
      const migratedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(migratedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v1 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v1 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V2, 'utf-8');
      migratedSidecar[migration.sidecarKey] = 2;
      fs.writeFileSync(sidecarPath, JSON.stringify(migratedSidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v2 skill must upgrade byte-exactly to v8`,
      );
      const v6Sidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(v6Sidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v2 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v2 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V3, 'utf-8');
      v6Sidecar[migration.sidecarKey] = 3;
      fs.writeFileSync(sidecarPath, JSON.stringify(v6Sidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v3 skill must upgrade byte-exactly to v8`,
      );
      const upgradedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(upgradedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v3 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v3 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V4, 'utf-8');
      upgradedSidecar[migration.sidecarKey] = 4;
      fs.writeFileSync(sidecarPath, JSON.stringify(upgradedSidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v4 skill must upgrade byte-exactly to v8`,
      );
      const v4UpgradedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(v4UpgradedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v4 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v4 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V5, 'utf-8');
      v4UpgradedSidecar[migration.sidecarKey] = 5;
      fs.writeFileSync(sidecarPath, JSON.stringify(v4UpgradedSidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v5 skill must upgrade byte-exactly to v8`,
      );
      const v5UpgradedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(v5UpgradedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v5 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v5 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V6, 'utf-8');
      v5UpgradedSidecar[migration.sidecarKey] = 6;
      fs.writeFileSync(sidecarPath, JSON.stringify(v5UpgradedSidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v6 skill must upgrade byte-exactly to v8`,
      );
      const v6UpgradedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(v6UpgradedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v6 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v6 upgrade must not create a backup`,
      );

      fs.writeFileSync(migration.skillPath, LAND_WORK_PACKAGE_SKILL_MD_V7, 'utf-8');
      v6UpgradedSidecar[migration.sidecarKey] = 7;
      fs.writeFileSync(sidecarPath, JSON.stringify(v6UpgradedSidecar, null, 2) + '\n', 'utf-8');

      supervisor.ensureWorkerScaffold(migration.workDir, migration.provider, 'windows');

      assert.deepEqual(
        fs.readFileSync(migration.skillPath),
        Buffer.from(LAND_WORK_PACKAGE_SKILL_MD),
        `${marker}: pristine ${migration.provider} v7 skill must upgrade byte-exactly to v8`,
      );
      const v7UpgradedSidecar = JSON.parse(
        fs.readFileSync(sidecarPath, 'utf-8'),
      ) as Record<string, number>;
      assert.equal(v7UpgradedSidecar[migration.sidecarKey], 8,
        `${marker}: ${migration.provider} sidecar must advance from v7 to v8`);
      assert.equal(
        fs.readdirSync(path.dirname(migration.skillPath))
          .some((name) => name.startsWith('SKILL.md.bak.')),
        false,
        `${marker}: pristine ${migration.provider} v7 upgrade must not create a backup`,
      );
    }
  } finally {
    cleanup();
    rmrf(claudeWorkDir);
    rmrf(codexWorkDir);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
