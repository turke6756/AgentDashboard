import React from 'react';
import { useThemeStore } from '../../../../stores/theme-store';
import { useDashboardStore } from '../../../../stores/dashboard-store';

interface Props {
  path: string;
  agentId: string;
  showDir?: boolean;
}

function splitPath(p: string): { dir: string; base: string } {
  const norm = p.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  if (idx < 0) return { dir: '', base: norm };
  return { dir: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

export default function FileHeader({ path, agentId, showDir = true }: Props) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const openFileViewer = useDashboardStore((s) => s.openFileViewer);
  const { dir, base } = splitPath(path);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openFileViewer(path, agentId);
  };

  return (
    <span
      role="link"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          openFileViewer(path, agentId);
        }
      }}
      className={`font-mono text-[11px] truncate hover:underline cursor-pointer select-text ${
        isLight ? 'text-[#0969da]' : 'text-[#79c0ff]'
      }`}
      title={path}
    >
      {showDir && dir && (
        <span className={isLight ? 'text-[#57606a]' : 'text-gray-500'}>{dir}/</span>
      )}
      <span>{base}</span>
    </span>
  );
}
