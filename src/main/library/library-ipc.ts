import type { IpcMainInvokeEvent } from 'electron';
import type { LibraryIngestRequest, LibraryProgressEvent } from '../../shared/library';
import { createLibraryIngestor } from './library-ingest';
import { closeLibraryStore, listLibraryDocuments, openLibraryStore, queryLibrary, saveLibraryNote, type QueryLibraryArgs, type SaveLibraryNoteInput } from './library-store';

export const LIBRARY_CHANNELS = {
  ingest: 'library:ingest',
  rescan: 'library:rescan',
  list: 'library:list-documents',
  query: 'library:query',
  saveNote: 'library:save-note',
  progress: 'library:progress',
} as const;

export interface LibraryWorkspace {
  id: string;
  path: string;
}

export interface LibraryIpcLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void;
}

export function registerLibraryIpc(
  ipc: LibraryIpcLike,
  resolveWorkspace: (workspaceId: string) => LibraryWorkspace | null,
  sendProgress: (event: LibraryProgressEvent) => void,
): void {
  const withStore = async <T>(workspaceId: string, work: (root: string, store: ReturnType<typeof openLibraryStore>) => Promise<T> | T) => {
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);
    const store = openLibraryStore(workspace.path);
    try { return await work(workspace.path, store); }
    finally { closeLibraryStore(store); }
  };

  const ingest = (_event: IpcMainInvokeEvent, request: LibraryIngestRequest) => withStore(
    request.workspace_id,
    (workspaceRoot, store) => createLibraryIngestor({
      workspaceRoot,
      store,
      publish: (progress) => sendProgress({ ...progress, workspace_id: request.workspace_id }),
    })({
      source_path: request.source_path,
      trigger: request.trigger,
      document_id: request.document_id,
      trust: request.trust,
      type: request.type,
    }),
  );
  ipc.handle(LIBRARY_CHANNELS.ingest, ingest);
  ipc.handle(LIBRARY_CHANNELS.rescan, (event, request: LibraryIngestRequest) => ingest(event, { ...request, trigger: 'rescan' }));
  ipc.handle(LIBRARY_CHANNELS.list, (_event, workspaceId: string, includeUntrusted = false) => withStore(
    workspaceId,
    (_root, store) => listLibraryDocuments(store, { include_untrusted: includeUntrusted }),
  ));
  ipc.handle(LIBRARY_CHANNELS.query, (_event, workspaceId: string, args: QueryLibraryArgs) => withStore(
    workspaceId,
    (_root, store) => queryLibrary(store, args),
  ));
  ipc.handle(LIBRARY_CHANNELS.saveNote, (_event, workspaceId: string, input: SaveLibraryNoteInput) => withStore(
    workspaceId,
    (_root, store) => saveLibraryNote(store, input),
  ));
}

/** Production registration seam, kept injectable so acceptance enters the same call used by ipc-handlers. */
export function registerProductionLibraryIpc(
  ipc: LibraryIpcLike,
  resolveWorkspace: (workspaceId: string) => LibraryWorkspace | null,
  sendProgress: (event: LibraryProgressEvent) => void,
): void {
  registerLibraryIpc(ipc, resolveWorkspace, sendProgress);
}
