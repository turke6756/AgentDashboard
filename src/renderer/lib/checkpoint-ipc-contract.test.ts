// @vitest-environment jsdom

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IpcApi } from '../../shared/types';
import { CHECKPOINT_CHANNELS } from '../../shared/types';
import RestoreDialog from '../components/checkpoints/RestoreDialog';
import { useDashboardStore } from '../stores/dashboard-store';

// WP-G2.2 — contract coverage for the human checkpoint IPC channels. Two failure
// modes, both of which pass every pure unit test and both of which surface in the
// app as one symptom (the recovery UI silently does nothing):
//
//   1. SHAPE drift — preload stops satisfying `IpcApi['checkpoints']`. Caught at
//      typecheck by the witness below (preload declares `const api: IpcApi`, so a
//      missing/mis-typed member fails `npm run build`).
//   2. CHANNEL-NAME drift — preload invokes a channel main never registers (or vice
//      versa). TypeScript cannot see this (string literals in different files), so
//      the channel strings are compared across preload + the main registrar +
//      CHECKPOINT_CHANNELS directly.
//
// A full Electron E2E suite is an explicit non-goal; this is the cheap coverage
// that keeps the non-goal safe (mirrors continuation-ipc-contract.test.ts).

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** Typecheck-only: a value of this type must be assignable to the whole
 *  `checkpoints` sub-API. If any signature drifts, `npm run build` fails here. */
type CheckpointApi = IpcApi['checkpoints'];

const CONTRACT_WITNESS: CheckpointApi = {
  list: async (workspaceId) => ({ workspaceId, turns: [] }),
  diff: async (workspaceId, turnId) => ({
    workspaceId,
    turnId,
    witnessed: { available: false, reason: null, label: '', text: null },
    window: { available: false, reason: null, label: '', text: null },
  }),
  preview: async (_workspaceId, turnId) => ({
    available: false, reason: null, turnId, witnessedSet: [], tokens: {},
    validatedPaths: [], rejectedPaths: [], contention: [],
  }),
  restore: async (req) => ({
    status: 'failed', operationId: '', kind: 'restore_paths', preRef: null, preOid: null,
    requestedPaths: req.paths, completedPaths: [], rejectedPaths: [], failures: [],
    contention: [], failureReason: null,
  }),
  revert: async () => ({
    status: 'failed', operationId: '', kind: 'revert_turn', preRef: null, preOid: null,
    requestedPaths: [], completedPaths: [], rejectedPaths: [], failures: [],
    contention: [], failureReason: null,
  }),
  fileHistory: async (workspaceId, path) => ({ workspaceId, path, versions: [] }),
  gitInit: async () => ({ ok: false, status: 'error', message: '' }),
};

describe('checkpoint IPC contract (WP-G2.2)', () => {
  it('the checkpoints API members are part of IpcApi with the expected shapes', () => {
    expect(typeof CONTRACT_WITNESS.list).toBe('function');
    expect(typeof CONTRACT_WITNESS.diff).toBe('function');
    expect(typeof CONTRACT_WITNESS.preview).toBe('function');
    expect(typeof CONTRACT_WITNESS.restore).toBe('function');
    expect(typeof CONTRACT_WITNESS.revert).toBe('function');
  });

  it('preload declares itself as IpcApi, so a missing member cannot compile', () => {
    expect(read('src/preload/index.ts')).toMatch(/const api:\s*IpcApi\s*=/);
  });

  it('every channel preload invokes is a channel the main registrar handles', () => {
    const preload = read('src/preload/index.ts');
    const registrar = read('src/main/git-checkpoints/checkpoint-ipc.ts');
    for (const ch of Object.values(CHECKPOINT_CHANNELS)) {
      // preload invokes it (via the CHECKPOINT_CHANNELS.<key> reference, resolved
      // to the literal in the const), and the registrar handles the same key.
      const key = Object.entries(CHECKPOINT_CHANNELS).find(([, v]) => v === ch)![0];
      expect(preload).toContain(`CHECKPOINT_CHANNELS.${key}`);
      expect(registrar).toContain(`CHECKPOINT_CHANNELS.${key}`);
      expect(ch.startsWith('checkpoint:')).toBe(true);
    }
  });

  it('preload routes checkpoint IPC through ipcRenderer.invoke (request/response, not fire-and-forget)', () => {
    const preload = read('src/preload/index.ts');
    for (const key of Object.keys(CHECKPOINT_CHANNELS)) {
      expect(preload).toContain(`ipcRenderer.invoke(CHECKPOINT_CHANNELS.${key}`);
    }
  });
});

describe('RestoreDialog refusal contract (WP-G5)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  const overlapPreview = {
    available: false,
    reason: 'after-snapshot-overlap',
    turnId: 't1',
    witnessedSet: ['src/config.ts'],
    tokens: { 'src/config.ts': 'oid-current' },
    validatedPaths: ['src/config.ts'],
    rejectedPaths: [],
    contention: [{ path: 'src/config.ts', turnId: 't2' }],
    overlap: {
      reason: 'after-snapshot-overlap' as const,
      files: [{
        path: 'src/config.ts',
        blockers: [
          {
            kind: 'later-turn' as const,
            turnId: 't2',
            turnSeq: 22,
            agentId: 'a2',
            agentTitle: 'Builder',
            taskLabel: 'finish settings',
            status: 'accepted',
            endedAt: 2000,
          },
          { kind: 'external' as const },
        ],
      }],
    },
  };

  function apiWithPreview(preview: typeof overlapPreview | Omit<typeof overlapPreview, 'overlap'>) {
    return {
      checkpoints: {
        preview: vi.fn(async () => preview),
        diff: vi.fn(async () => ({
          workspaceId: 'ws', turnId: 't1',
          witnessed: { available: true, reason: null, label: 'witnessed changes', text: '' },
          window: { available: true, reason: null, label: 'unattributed changes in this window', text: '' },
        })),
        restore: vi.fn(async () => ({
          status: 'completed' as const, operationId: 'op', kind: 'restore_paths' as const,
          preRef: 'pre', preOid: 'oid', requestedPaths: ['src/config.ts'],
          completedPaths: ['src/config.ts'], rejectedPaths: [], failures: [], contention: [], failureReason: null,
        })),
        revert: vi.fn(),
        list: vi.fn(async () => ({ workspaceId: 'ws', turns: [] })),
      },
    };
  }

  async function mount(preview: typeof overlapPreview | Omit<typeof overlapPreview, 'overlap'>) {
    (window as any).api = apiWithPreview(preview);
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(RestoreDialog, {
        workspaceId: 'ws',
        agentId: 'a1',
        turn: {
          turnId: 't1', turnSeq: 1, agentId: 'a1', agentTitle: 'Alpha', taskLabel: 'edit config',
          status: 'accepted', startedAt: 1, endedAt: 2, beforeReady: true, afterReady: true,
          beforeQuality: 'guaranteed', afterQuality: 'hook', witnessedPaths: ['src/config.ts'],
          failureReason: null,
        },
        mode: 'restore',
        paths: ['src/config.ts'],
        onClose: () => {},
      }));
    });
    const previewButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Preview')) as HTMLButtonElement;
    await act(async () => { previewButton.click(); });
    await act(async () => { await Promise.resolve(); });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    useDashboardStore.setState({ checkpointTurns: {}, checkpointLoading: {} } as any);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
  });

  it('REACHABILITY:restore-dialog-refusal disables confirm and renders named and external blockers', async () => {
    await mount(overlapPreview);
    const confirm = container.querySelector('[data-testid="confirm-restore"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(container.textContent).toContain('src/config.ts');
    expect(container.textContent).toContain('Builder — finish settings — turn 22');
    expect(container.textContent).toContain('changed after this turn (not by a recorded turn)');
    expect(container.textContent).not.toContain('Override a stale preview (force)');
    await act(async () => { confirm.click(); });
    expect((window as any).api.checkpoints.restore).not.toHaveBeenCalled();
  });

  it.each([
    'after-snapshot-overlap',
    'after-edge-unusable',
    'current-hash-failed',
    'active-turn-witnesses-path',
  ])('%s disables confirm even without an overlap payload', async (reason) => {
    const { overlap: _overlap, ...hashFailed } = overlapPreview;
    await mount({ ...hashFailed, reason });
    const confirm = container.querySelector('[data-testid="confirm-restore"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('a clean preview sends no force field', async () => {
    const { overlap: _overlap, ...clean } = overlapPreview;
    await mount({ ...clean, available: true, reason: null });
    const confirm = container.querySelector('[data-testid="confirm-restore"]') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    await act(async () => { confirm.click(); });
    await act(async () => { await Promise.resolve(); });
    expect((window as any).api.checkpoints.restore).toHaveBeenCalledTimes(1);
    expect((window as any).api.checkpoints.restore.mock.calls[0][0]).not.toHaveProperty('force');
  });
});
