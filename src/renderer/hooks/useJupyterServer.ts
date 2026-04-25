import { useEffect, useState } from 'react';
import type { JupyterServerInfo } from '../../shared/types';

interface State {
  info: JupyterServerInfo | null;
  ready: boolean;
  error: Error | null;
}

let cached: JupyterServerInfo | null = null;
let pending: Promise<JupyterServerInfo> | null = null;

async function getOrCreate(): Promise<JupyterServerInfo> {
  if (cached) return cached;
  if (pending) return pending;
  pending = window.api.notebooks.ensureServer()
    .then((info) => { cached = info; return info; })
    .finally(() => { pending = null; });
  return pending;
}

export function useJupyterServer(): State {
  const [state, setState] = useState<State>({
    info: cached,
    ready: !!cached,
    error: null,
  });

  useEffect(() => {
    if (cached) {
      setState({ info: cached, ready: true, error: null });
      return;
    }
    let cancelled = false;
    getOrCreate()
      .then((info) => { if (!cancelled) setState({ info, ready: true, error: null }); })
      .catch((err) => {
        if (!cancelled) setState({ info: null, ready: false, error: err instanceof Error ? err : new Error(String(err)) });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
