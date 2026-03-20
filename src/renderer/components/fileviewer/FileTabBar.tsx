import React, { useRef, useEffect } from 'react';
import type { FileTab } from '../../../shared/types';
import { fileDragStart } from '../../utils/drag-file';

interface Props {
  tabs: FileTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

function getDisplayLabel(tab: FileTab, allTabs: FileTab[]): string {
  if (!tab.filePath) return tab.label; // directory-only tab

  const name = tab.label;
  // Check for duplicate filenames — show parent dir for disambiguation
  const dupes = allTabs.filter((t) => t.label === name && t.id !== tab.id);
  if (dupes.length > 0) {
    const normalized = tab.filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${name} (${segments[segments.length - 2]})`;
    }
  }
  return name;
}

export default function FileTabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view
  useEffect(() => {
    if (!scrollRef.current || !activeTabId) return;
    const activeEl = scrollRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  const handleMouseDown = (e: React.MouseEvent, tabId: string) => {
    // Middle-click to close
    if (e.button === 1) {
      e.preventDefault();
      onCloseTab(tabId);
    }
  };

  return (
    <div className="flex items-stretch border-b border-gray-800 bg-surface-0 shrink-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex items-stretch overflow-x-auto scrollbar-hide flex-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const displayLabel = getDisplayLabel(tab, tabs);
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              draggable={!!tab.filePath}
              onDragStart={(e) => { if (tab.filePath) fileDragStart(e, tab.filePath); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 cursor-pointer shrink-0 max-w-[180px] border-r border-gray-800/50 transition-colors group ${
                isActive
                  ? 'bg-surface-2 border-b-2 border-b-accent-blue text-white'
                  : 'text-gray-500 hover:bg-surface-1 hover:text-gray-300 border-b-2 border-b-transparent'
              }`}
            >
              <span className="text-[11px] font-mono truncate select-none">
                {displayLabel}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className={`text-[10px] leading-none px-0.5 rounded-sm shrink-0 transition-colors ${
                  isActive
                    ? 'text-gray-500 hover:text-white hover:bg-gray-700'
                    : 'text-gray-700 hover:text-gray-400 hover:bg-gray-800 opacity-0 group-hover:opacity-100'
                }`}
                title="Close tab"
              >
                x
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
