import React from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';

interface Props {
  collapsed: boolean;
  direction: 'left' | 'right' | 'up' | 'down';
  onClick: () => void;
}

const ICONS = {
  left: ChevronLeft,
  right: ChevronRight,
  up: ChevronUp,
  down: ChevronDown,
};

export default function CollapseButton({ collapsed, direction, onClick }: Props) {
  const opposites: Record<string, string> = { left: 'right', right: 'left', up: 'down', down: 'up' };
  const chevronDir = collapsed ? opposites[direction] : direction;
  const Icon = ICONS[chevronDir as keyof typeof ICONS];

  return (
    <button
      onClick={onClick}
      className="inline-flex items-center justify-center min-w-[22px] min-h-[22px] p-1 text-gray-500 hover:text-accent-blue hover:bg-white/[0.06] transition-colors shrink-0"
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}
