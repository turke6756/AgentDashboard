import React from 'react';

interface Props {
  collapsed: boolean;
  direction: 'left' | 'right' | 'up' | 'down';
  onClick: () => void;
}

const CHEVRONS: Record<string, string> = {
  left: '\u25C0',
  right: '\u25B6',
  up: '\u25B2',
  down: '\u25BC',
};

export default function CollapseButton({ collapsed, direction, onClick }: Props) {
  // When collapsed, chevron points toward the panel (to expand); when expanded, away (to collapse)
  const opposites: Record<string, string> = { left: 'right', right: 'left', up: 'down', down: 'up' };
  const chevronDir = collapsed ? opposites[direction] : direction;

  return (
    <button
      onClick={onClick}
      className="text-[9px] font-mono text-gray-600 hover:text-accent-blue transition-colors px-1 py-0.5 border border-gray-800 hover:border-accent-blue/40 bg-surface-1 shrink-0"
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      {CHEVRONS[chevronDir]}
    </button>
  );
}
