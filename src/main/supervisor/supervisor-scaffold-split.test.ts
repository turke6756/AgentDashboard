import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SUPERVISOR_AGENT_MD,
  SUPERVISOR_AGENT_MD_CHILD,
  SUPERVISOR_AGENT_MD_CHILD_V1,
  SUPERVISOR_AGENT_MD_V32,
  SUPERVISOR_CLAUDE_SETTINGS_JSON,
  SUPERVISOR_CLAUDE_SETTINGS_JSON_CHILD,
} from '../../shared/constants';
import { AgentSupervisor } from './index';

interface ScaffoldFileForTest {
  content: string;
  executable?: boolean;
  version: number;
  previousHashes?: Record<number, string>;
  removed?: boolean;
}

type SupervisorStatics = {
  LEGACY_SUPERVISOR_FILES: Record<string, ScaffoldFileForTest>;
  LEGACY_SUPERVISOR_FILES_CODEX: Record<string, ScaffoldFileForTest>;
  SUPERVISOR_SHARED_PARENT_FILES: Record<string, ScaffoldFileForTest>;
  SUPERVISOR_FILES_CLAUDE_CHILD: Record<string, ScaffoldFileForTest>;
  SUPERVISOR_FILES_CODEX_CHILD: Record<string, ScaffoldFileForTest>;
};

type ScaffoldHarness = {
  ensureSupervisorScaffold(workDir: string, provider: string, pathType: string): void;
  writeScaffoldMap(
    workDir: string,
    files: Record<string, ScaffoldFileForTest>,
    pathType: string,
  ): number;
};

const statics = AgentSupervisor as unknown as SupervisorStatics;

function digest(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function diskPath(workDir: string, rel: string): string {
  return path.join(workDir, ...rel.split('/'));
}

function writeSeed(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function digestText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertChildMap(name: string, files: Record<string, ScaffoldFileForTest>): void {
  assert.ok(Object.keys(files).length > 0, `${name} child map must not be empty`);
  for (const [rel, file] of Object.entries(files)) {
    const isInstructions = /\/(?:CLAUDE|AGENTS)\.md$/.test(rel);
    assert.equal(file.version, isInstructions ? 2 : 1, `${rel} must carry its expected scaffold version`);
    if (isInstructions) {
      assert.deepEqual(
        file.previousHashes,
        { 1: digestText(SUPERVISOR_AGENT_MD_CHILD_V1) },
        `${rel} must retain the superseded v1 child instructions hash`,
      );
    } else {
      assert.equal(file.previousHashes, undefined, `${rel} must have no pre-child hash history`);
    }
    assert.equal(file.removed, undefined, `${rel} must not introduce a retired child row`);
    assert.doesNotMatch(
      rel,
      /\.lares\/supervisor\/(?:claude|codex)\/(?:scripts|memory)\//,
      `${rel} must not put parent scripts or memory in a provider child`,
    );
  }
}

function makeHarness(): ScaffoldHarness {
  const harness = Object.create(AgentSupervisor.prototype) as ScaffoldHarness;
  const productionWrite = harness.writeScaffoldMap.bind(harness);
  harness.writeScaffoldMap = (workDir, files, pathType) => {
    productionWrite(workDir, files, pathType);
    // Keep ensureSupervisorScaffold below its telemetry threshold; this test is
    // about disk reachability and does not initialize the database singleton.
    return 0;
  };
  return harness;
}

function run(): void {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-supervisor-split-'));
  try {
    const legacyMaps = [
      statics.LEGACY_SUPERVISOR_FILES,
      statics.LEGACY_SUPERVISOR_FILES_CODEX,
    ];
    assert.ok(legacyMaps.every((files) => Object.keys(files).length > 0), 'LEGACY_* maps remain defined');
    for (const [files, rel] of [
      [statics.LEGACY_SUPERVISOR_FILES, '.lares/supervisor/CLAUDE.md'],
      [statics.LEGACY_SUPERVISOR_FILES_CODEX, '.lares/supervisor/AGENTS.md'],
    ] as const) {
      const instructions = files[rel];
      assert.equal(instructions.version, 34, `${rel} must advance to scaffold version 34`);
      assert.equal(
        instructions.previousHashes?.[32],
        digestText(SUPERVISOR_AGENT_MD_V32),
        `${rel} must retain the superseded v32 instructions hash`,
      );
    }
    assert.equal(
      SUPERVISOR_AGENT_MD_CHILD,
      SUPERVISOR_AGENT_MD.split('./memory/').join('../memory/'),
      'child instructions rewrite only the supervisor-memory depth',
    );
    assert.ok(count(SUPERVISOR_AGENT_MD, './memory/') > 0, 'legacy instructions exercise memory rewrites');
    assert.ok(
      SUPERVISOR_AGENT_MD_CHILD.includes('node .lares/scripts/memory-index.mjs'),
      'workspace-root-anchored memory-index command must remain unchanged',
    );
    assert.equal(
      SUPERVISOR_CLAUDE_SETTINGS_JSON_CHILD,
      SUPERVISOR_CLAUDE_SETTINGS_JSON
        .split('${CLAUDE_PROJECT_DIR}/../scripts/')
        .join('${CLAUDE_PROJECT_DIR}/../../scripts/'),
      'child settings rewrite only the five script-depth references',
    );
    assert.equal(count(SUPERVISOR_CLAUDE_SETTINGS_JSON, '${CLAUDE_PROJECT_DIR}/../scripts/'), 5);

    const flatHashes = new Map<string, string>();
    for (const files of legacyMaps) {
      for (const rel of Object.keys(files)) {
        const filePath = diskPath(workDir, rel);
        writeSeed(filePath, `flat-kit-sentinel:${rel}\n`);
        flatHashes.set(filePath, digest(filePath));
      }
    }
    const memoryPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');
    const detailPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'details', 'keep.md');
    writeSeed(memoryPath, 'memory-index-sentinel\n');
    writeSeed(detailPath, 'memory-detail-sentinel\n');
    flatHashes.set(memoryPath, digest(memoryPath));
    flatHashes.set(detailPath, digest(detailPath));

    assertChildMap('Claude', statics.SUPERVISOR_FILES_CLAUDE_CHILD);
    assertChildMap('Codex', statics.SUPERVISOR_FILES_CODEX_CHILD);
    assert.deepEqual(
      Object.keys(statics.SUPERVISOR_SHARED_PARENT_FILES).sort(),
      [
        '.lares/supervisor/scripts/get-context-stats.sh',
        '.lares/supervisor/scripts/list-agents.sh',
        '.lares/supervisor/scripts/read-agent-log.sh',
        '.lares/supervisor/scripts/send-message.sh',
      ],
      'the shared parent map contains exactly the four unchanged script keys',
    );

    const harness = makeHarness();
    harness.ensureSupervisorScaffold(workDir, 'claude', 'windows');

    const claudeMdPath = path.join(workDir, '.lares', 'supervisor', 'claude', 'CLAUDE.md');
    const claudeSettingsPath = path.join(
      workDir, '.lares', 'supervisor', 'claude', '.claude', 'settings.json',
    );
    assert.equal(fs.readFileSync(claudeMdPath, 'utf8'), SUPERVISOR_AGENT_MD_CHILD);
    assert.ok(fs.readFileSync(claudeMdPath, 'utf8').includes('../memory/MEMORY.md'));
    const settings = fs.readFileSync(claudeSettingsPath, 'utf8');
    assert.equal(settings, SUPERVISOR_CLAUDE_SETTINGS_JSON_CHILD);
    assert.equal(count(settings, '${CLAUDE_PROJECT_DIR}/../../scripts/'), 5);
    assert.equal(count(settings, '${CLAUDE_PROJECT_DIR}/../scripts/'), 0);
    assert.equal(
      fs.existsSync(path.join(workDir, '.lares', 'supervisor', 'codex')),
      false,
      'a Claude pass must not create the Codex child folder',
    );

    for (const rel of Object.keys(statics.SUPERVISOR_SHARED_PARENT_FILES)) {
      assert.ok(fs.existsSync(diskPath(workDir, rel)), `shared parent script must exist: ${rel}`);
    }
    for (const [filePath, beforeHash] of flatHashes) {
      assert.ok(fs.existsSync(filePath), `flat kit and memory file must not be deleted: ${filePath}`);
      assert.equal(digest(filePath), beforeHash, `flat kit and memory file must not be rewritten: ${filePath}`);
    }

    harness.ensureSupervisorScaffold(workDir, 'codex', 'windows');
    const codexAgentsPath = path.join(workDir, '.lares', 'supervisor', 'codex', 'AGENTS.md');
    assert.equal(fs.readFileSync(codexAgentsPath, 'utf8'), SUPERVISOR_AGENT_MD_CHILD);
    for (const [filePath, beforeHash] of flatHashes) {
      assert.ok(fs.existsSync(filePath), `Codex pass must not delete flat state: ${filePath}`);
      assert.equal(digest(filePath), beforeHash, `Codex pass must not rewrite flat state: ${filePath}`);
    }

    console.log('REACHABILITY:supervisor-scaffold-split ok');
    console.log('1 passed, 0 failed');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error('REACHABILITY:supervisor-scaffold-split failed');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
}
