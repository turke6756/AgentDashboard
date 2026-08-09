import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    sendSync: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}));

describe('plan delete preload reachability', () => {
  beforeEach(() => {
    vi.resetModules();
    electron.exposeInMainWorld.mockClear();
    electron.invoke.mockReset();
  });

  it('REACHABILITY:wp5b-delete-wire exposes both delete IPC operations on window.api.plans', async () => {
    await import('../../../preload/index');
    const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'api');
    expect(exposed, 'preload must expose the production window.api bridge').toBeDefined();
    const api = exposed![1] as {
      plans: {
        deleteProposal: (input: unknown) => Promise<unknown>;
        deletePermanent: (input: unknown) => Promise<unknown>;
      };
    };
    const proposalRequest = { workspaceId: 'ws-1', proposalDocumentId: 'proposal-doc' };
    const planRequest = { planId: 'plan-1', confirmed: true };

    await api.plans.deleteProposal(proposalRequest);
    await api.plans.deletePermanent(planRequest);

    expect(electron.invoke).toHaveBeenNthCalledWith(1, 'proposal:delete', proposalRequest);
    expect(electron.invoke).toHaveBeenNthCalledWith(2, 'plan:deletePermanent', planRequest);
  });
});
