import React from 'react';

interface Props {
  direction: 'horizontal' | 'vertical';
  isResizing: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}

export default function ResizeDivider({ direction, isResizing, onMouseDown }: Props) {
  const isHoriz = direction === 'horizontal';
  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 relative group z-30 ${
        isHoriz
          ? 'w-[4px] cursor-col-resize hover:bg-gray-500/20'
          : 'h-[4px] cursor-row-resize hover:bg-gray-500/20'
      } ${isResizing ? 'bg-gray-500/40' : 'bg-transparent'} transition-colors`}
    >
      {/* Extended hit area. The adjacent panel borders provide the single visible line at rest;
          the divider only renders its hover/resize highlight via the parent's background. */}
      <div
        className={`absolute ${
          isHoriz
            ? 'top-0 bottom-0 -left-[4px] -right-[4px]'
            : 'left-0 right-0 -top-[4px] -bottom-[4px]'
        }`}
      />
    </div>
  );
}
