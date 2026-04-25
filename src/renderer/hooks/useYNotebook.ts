import { useEffect, useState } from 'react';
import { YNotebook, type ISharedCell } from '@jupyter/ydoc';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { useJupyterServer } from './useJupyterServer';
import {
  getCollabRoomServerUrl,
  resolveCollabSession,
} from '../lib/jupyterCollab';

type YNotebookStatus = 'connecting' | 'synced' | 'error';

interface YNotebookState {
  ydoc: Y.Doc | null;
  ynotebook: YNotebook | null;
  status: YNotebookStatus;
  error?: string;
}

type DestroyableWebsocketProvider = WebsocketProvider & { destroy: () => void };
type ProviderStatus = { status: 'connected' | 'connecting' | 'disconnected' };

export function useYNotebook(path: string): YNotebookState {
  const server = useJupyterServer();
  const [state, setState] = useState<YNotebookState>({
    ydoc: null,
    ynotebook: null,
    status: 'connecting',
  });

  useEffect(() => {
    if (server.error) {
      setState({
        ydoc: null,
        ynotebook: null,
        status: 'error',
        error: server.error.message,
      });
      return;
    }

    if (!server.ready || !server.info) {
      setState({ ydoc: null, ynotebook: null, status: 'connecting' });
      return;
    }

    let cancelled = false;
    let ydoc: Y.Doc | null = null;
    let ynotebook: YNotebook | null = null;
    let provider: DestroyableWebsocketProvider | null = null;
    const cellHandlers = new Map<ISharedCell, () => void>();

    const emitNotebookChange = () => {
      if (cancelled) return;
      syncCellHandlers();
      setState((current) => ({ ...current }));
    };

    const syncCellHandlers = () => {
      if (!ynotebook) return;

      for (const [cell, handler] of cellHandlers) {
        if (!ynotebook.cells.includes(cell)) {
          cell.changed.disconnect(handler);
          cellHandlers.delete(cell);
        }
      }

      for (const cell of ynotebook.cells) {
        if (cellHandlers.has(cell)) continue;
        const handler = () => {
          if (!cancelled) {
            setState((current) => ({ ...current }));
          }
        };
        cell.changed.connect(handler);
        cellHandlers.set(cell, handler);
      }
    };

    const connect = async () => {
      try {
        setState({ ydoc: null, ynotebook: null, status: 'connecting' });

        const session = await resolveCollabSession(server.info.baseUrl, path, server.info.token);
        if (cancelled) return;

        ynotebook = new YNotebook();
        ydoc = ynotebook.ydoc;
        ynotebook.changed.connect(emitNotebookChange);
        syncCellHandlers();

        provider = new WebsocketProvider(
          getCollabRoomServerUrl(server.info.baseUrl),
          session.roomName,
          ydoc,
          {
            awareness: ynotebook.awareness,
            disableBc: true,
            params: session.sessionId ? { sessionId: session.sessionId } : {},
          }
        ) as DestroyableWebsocketProvider;

        provider.on('sync', (isSynced: boolean) => {
          if (cancelled) return;
          syncCellHandlers();
          setState({
            ydoc,
            ynotebook,
            status: isSynced ? 'synced' : 'connecting',
          });
        });

        provider.on('status', ({ status }: ProviderStatus) => {
          if (cancelled) return;
          if (status === 'connecting' || status === 'disconnected') {
            setState((current) => ({
              ...current,
              status: current.status === 'synced' && status === 'connecting' ? 'synced' : 'connecting',
            }));
          }
        });

        provider.on('connection-error', (event: Event) => {
          if (cancelled) return;
          setState({
            ydoc,
            ynotebook,
            status: 'error',
            error: describeConnectionError(event),
          });
        });

        provider.on('connection-close', (event: CloseEvent) => {
          if (cancelled || event.wasClean) return;
          setState({
            ydoc,
            ynotebook,
            status: 'error',
            error: `Notebook collaboration socket closed (${event.code}${event.reason ? `: ${event.reason}` : ''})`,
          });
        });

        setState({ ydoc, ynotebook, status: 'connecting' });
      } catch (error) {
        if (cancelled) return;
        setState({
          ydoc: null,
          ynotebook: null,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void connect();

    return () => {
      cancelled = true;
      for (const [cell, handler] of cellHandlers) {
        cell.changed.disconnect(handler);
      }
      cellHandlers.clear();
      if (ynotebook) {
        ynotebook.changed.disconnect(emitNotebookChange);
      }
      provider?.destroy();
      ynotebook?.dispose();
    };
  }, [path, server.error, server.info, server.ready]);

  return state;
}

function describeConnectionError(event: Event): string {
  if ('message' in event && typeof event.message === 'string') {
    return `Notebook collaboration socket error: ${event.message}`;
  }
  return 'Notebook collaboration socket error';
}
