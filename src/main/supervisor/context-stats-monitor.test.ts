// Self-contained tests for ContextStatsMonitor file-activity extraction.
//
//   npm run build:main
//   node dist/main/main/supervisor/context-stats-monitor.test.js

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ContextStatsMonitor, type JsonlFileActivity } from './context-stats-monitor';
import type { ToolResultEvent, ToolUseEvent } from '../../shared/session-events';

class FakeReader extends EventEmitter {
  pollNow(): void {}
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeHarness(): {
  reader: FakeReader;
  monitor: ContextStatsMonitor;
  emitted: JsonlFileActivity[];
} {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();
  return { reader, monitor, emitted };
}

function toolUse(toolName: string, input: unknown, toolUseId = 'tool-1'): ToolUseEvent {
  return {
    type: 'tool-use',
    uuid: `use:${toolUseId}`,
    timestamp: '2026-05-02T12:00:00.000Z',
    agentId: 'agent-1',
    toolUseId,
    toolName,
    input,
  };
}

function toolResult(toolUseId: string, content: string, isError = false): ToolResultEvent {
  return {
    type: 'tool-result',
    uuid: `result:${toolUseId}`,
    timestamp: '2026-05-02T12:00:01.000Z',
    agentId: 'agent-1',
    toolUseId,
    content,
    truncated: false,
    isError,
  };
}

test('Gemini read_file with file_path emits one read', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'src/a.ts', operation: 'read' }]);
});

test('Gemini read_many_files with paths emits multiple reads', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { paths: ['a.ts', 'b.ts'] }));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'b.ts', operation: 'read' },
  ]);
});

test('Gemini read_many_files with file_paths ignores non-string members', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { file_paths: ['a.ts', 42, null, 'b.ts'] }));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'b.ts', operation: 'read' },
  ]);
});

test('structured tool duplicate paths are deduped', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { paths: ['a.ts', 'a.ts'] }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-2'));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'a.ts', operation: 'read' }]);
});

test('apply_patch activity is emitted only after successful tool-result', () => {
  const { reader, emitted } = makeHarness();
  const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+const x = 1;\n*** End Patch';
  reader.emit('tool-use', toolUse('apply_patch', { input: patch, workdir: 'C:\\repo' }, 'patch-1'));
  assert.equal(emitted.length, 0, 'tool-use should only stash pending activity');
  reader.emit('tool-result', toolResult('patch-1', 'patch applied successfully'));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'C:\\repo\\src\\foo.ts', operation: 'write' }]);
});

test('failed apply_patch result drops pending activity', () => {
  const { reader, emitted } = makeHarness();
  const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+const x = 1;\n*** End Patch';
  reader.emit('tool-use', toolUse('apply_patch', { input: patch, workdir: 'C:\\repo' }, 'patch-1'));
  reader.emit('tool-result', toolResult('patch-1', 'Exit code: 1\nfailed'));
  assert.deepEqual(emitted, []);
});

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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
