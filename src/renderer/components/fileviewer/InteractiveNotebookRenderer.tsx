import React, { useMemo } from 'react';
import { useJupyterServer } from '../../hooks/useJupyterServer';
import NotebookRenderer from './NotebookRenderer';
import type { PathType } from '../../../shared/types';

interface Props {
  filePath: string;
  pathType: PathType;
  content: string;
}

// Convert a host-side notebook path to a path relative to the jupyter-server
// root_dir (which is '/'). WSL paths drop the leading slash. Windows paths
// become '/mnt/<drive>/...'.
function toServerPath(filePath: string, pathType: PathType): string {
  if (pathType === 'wsl') return filePath.replace(/^\/+/, '');
  const m = filePath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (m) return `mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export default function InteractiveNotebookRenderer({ filePath, pathType, content }: Props) {
  const { info, ready, error } = useJupyterServer();

  const src = useMemo(() => {
    if (!info) return null;
    const serverPath = toServerPath(filePath, pathType);
    // /doc single-document mode (no Lab chrome). Fallback: /lab/tree/<path>
    const url = new URL(`doc/tree/${serverPath}`, info.baseUrl);
    if (info.token) url.searchParams.set('token', info.token);
    url.searchParams.set('reset', '');
    return url.toString();
  }, [info, filePath, pathType]);

  if (error) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 bg-red-900/30 border-b border-red-700/40 text-xs text-red-300 font-sans">
          Jupyter server failed to start: {error.message}. Showing static view.
        </div>
        <div className="flex-1 overflow-auto">
          <NotebookRenderer content={content} />
        </div>
      </div>
    );
  }

  if (!ready || !src) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="text-gray-400 font-sans text-sm">Starting Jupyter server&hellip;</div>
          <div className="text-gray-600 font-mono text-xs mt-2">first launch takes ~5s</div>
        </div>
      </div>
    );
  }

  return (
    <iframe
      src={src}
      title={filePath}
      className="w-full h-full border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
    />
  );
}
