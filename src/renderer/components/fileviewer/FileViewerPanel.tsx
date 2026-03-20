import React, { useEffect, useCallback, useMemo } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useResize } from '../../hooks/useResize';
import FileViewerHeader from './FileViewerHeader';
import FileContentArea from './FileContentArea';
import FileTabBar from './FileTabBar';
import DirectoryTree from './DirectoryTree';
import ResizeDivider from '../layout/ResizeDivider';
import CollapseButton from '../layout/CollapseButton';
import { evictTabCache } from './useFileContentCache';
import { ArrowLeft } from 'lucide-react';

export default function FileViewerPanel() {
  const {
    openTabs,
    activeTabId,
    closeTab,
    setActiveTab,
    closeAllTabs,
    openTab,
    panelLayout,
    togglePanelCollapsed,
  } = useDashboardStore();

  const activeTab = openTabs.find((t) => t.id === activeTabId);

  // Use the active tab's rootDirectory for the tree, falling back to first tab
  const treeRoot = activeTab?.rootDirectory || openTabs[0]?.rootDirectory || '';
  const treePathType = activeTab?.pathType || openTabs[0]?.pathType || 'wsl';

  // Directory tree resize
  const treeResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.directoryTreeWidth,
    min: 150,
    max: 500,
    storageKey: 'panel-tree-width',
  });

  const treeCollapsed = panelLayout.directoryTreeCollapsed;

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close active tab; if it's the last one, closes file viewer
        if (activeTabId) {
          evictTabCache(activeTabId);
          closeTab(activeTabId);
        }
      } else if (e.key === 'w' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (activeTabId) {
          evictTabCache(activeTabId);
          closeTab(activeTabId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, closeTab]);

  // Clicking a file in the tree opens it as a new tab (or focuses existing)
  const handleFileSelect = useCallback((filePath: string) => {
    openTab(filePath, treeRoot, treePathType, activeTab?.agentId);
  }, [openTab, treeRoot, treePathType, activeTab?.agentId]);

  const handleCloseTab = useCallback((tabId: string) => {
    evictTabCache(tabId);
    closeTab(tabId);
  }, [closeTab]);

  const handleBreadcrumbNavigate = useCallback((_dirPath: string) => {
    // Could navigate tree in future
  }, []);

  // Filter tabs to only show those belonging to the current root directory
  const visibleTabs = useMemo(
    () => openTabs.filter((t) => t.rootDirectory === treeRoot),
    [openTabs, treeRoot],
  );

  if (!activeTab) return null;

  // Only show file header + content for tabs that have a file (not directory-only tabs)
  const hasFile = !!activeTab.filePath;

  // Extract directory name for display
  const dirName = treeRoot.split('/').filter(Boolean).pop() || treeRoot;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-surface-0/20">
      {/* Persistent Back Bar — always visible */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-accent-blue/20 bg-surface-1/60 backdrop-blur-md shrink-0">
        <button
          onClick={closeAllTabs}
          className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-xs font-mono shrink-0 group"
          title="Back to agents"
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          <span>BACK</span>
        </button>
        <div className="h-4 w-px bg-accent-blue/20 shrink-0" />
        <span className="text-[11px] font-mono text-gray-500 truncate">{dirName}</span>
      </div>

      {/* Tab Bar */}
      <FileTabBar
        tabs={visibleTabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
      />

      {/* File Header — only for file tabs */}
      {hasFile && (
        <FileViewerHeader
          filePath={activeTab.filePath}
          pathType={activeTab.pathType}
          fileSize={0}
          workingDirectory={activeTab.rootDirectory}
          onNavigate={handleBreadcrumbNavigate}
        />
      )}

      <div className="flex-1 flex min-h-0">
        {/* Directory Tree Sidebar */}
        {treeCollapsed ? (
          <div className="shrink-0 bg-surface-0/40 border-r border-accent-blue/10 flex flex-col items-center py-2" style={{ width: 32 }}>
            <CollapseButton collapsed direction="left" onClick={() => togglePanelCollapsed('directoryTreeCollapsed')} />
            <div className="mt-2 text-[9px] font-mono text-gray-600" style={{ writingMode: 'vertical-rl' }}>
              TREE
            </div>
          </div>
        ) : (
          <>
            <div className="shrink-0 relative" style={{ width: treeResize.size }}>
              <div className="absolute top-1 right-1 z-10">
                <CollapseButton collapsed={false} direction="left" onClick={() => togglePanelCollapsed('directoryTreeCollapsed')} />
              </div>
              <DirectoryTree
                rootPath={treeRoot}
                pathType={treePathType}
                activeFilePath={activeTab.filePath}
                onFileSelect={handleFileSelect}
              />
            </div>
            <ResizeDivider
              direction="horizontal"
              isResizing={treeResize.isResizing}
              onMouseDown={treeResize.handleMouseDown}
            />
          </>
        )}

        {/* File Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {hasFile ? (
            <FileContentArea
              tabId={activeTab.id}
              filePath={activeTab.filePath}
              pathType={activeTab.pathType}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-gray-600 font-mono text-sm uppercase tracking-wider">
                Select a file from the tree
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
