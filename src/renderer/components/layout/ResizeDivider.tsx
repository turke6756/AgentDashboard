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
      {/* Extended hit area */}
      <div
        className={`absolute ${
          isHoriz
            ? 'top-0 bottom-0 -left-[4px] -right-[4px]'
            : 'left-0 right-0 -top-[4px] -bottom-[4px]'
        }`}
      />
      {/* Visible line */}
      <div
        className={`absolute ${
          isHoriz
            ? 'top-0 bottom-0 left-[1px] w-[1px]'
            : 'left-0 right-0 top-[1px] h-[1px]'
        } dark:bg-white/10 light:bg-black/10 group-hover:bg-accent-blue ${
          isResizing ? 'bg-accent-blue' : ''
        } transition-colors`}
      />
    </div>
  );
}
