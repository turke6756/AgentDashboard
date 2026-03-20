# Native File Viewer & Directory Explorer

In-app file viewing for AgentDashboard — read markdown, code, and text files without leaving the dashboard.

## Overview

Clicking a file in the CONTEXT or OUTPUTS tabs now opens a native file viewer in the center panel instead of launching VS Code. "Open in VS Code" remains available as a secondary action for editing.

## Architecture

### Backend (IPC Layer)

**`src/main/file-reader.ts`** — New module with two functions:

- `readFileContents(filePath, pathType)` — Reads file content via WSL (`wsl.exe bash -lc "cat ..."`) or Windows (`fs.readFileSync`). Enforces a 1MB cap. Rejects paths containing `$`, backtick, `;`, `|`, `&` to prevent shell injection.
- `listDirectoryEntries(dirPath, pathType)` — Lists directory contents via WSL (`find -printf`) or Windows (`fs.readdirSync`). Returns entries sorted directories-first, then alphabetically.

Both functions use a 10-second timeout for WSL operations.

**IPC channels registered:**

| Channel | Handler |
|---------|---------|
| `files:read` | Returns `FileContent` (path, content, encoding, size, error?) |
| `files:list-directory` | Returns `DirectoryEntry[]` (name, path, isDirectory, size) |

**Types added to `src/shared/types.ts`:**

- `DirectoryEntry { name, path, isDirectory, size }`
- `FileContent { path, content, encoding, size, error? }`
- `IpcApi.files` namespace with `readFile` and `listDirectory`

### Store

**`src/renderer/stores/dashboard-store.ts`** — Added:

- `viewingFile` state: `{ filePath, agentId, workingDirectory, pathType } | null`
- `openFileViewer(filePath, agentId)` — Resolves the agent's workspace pathType and working directory, sets `viewingFile`
- `closeFileViewer()` — Clears `viewingFile`

### Components

Nine new files in `src/renderer/components/fileviewer/`:

| File | Purpose |
|------|---------|
| `fileTypeUtils.ts` | Extension-to-type mapping (markdown/code/text/binary), language detection for syntax highlighter, file size formatting |
| `PlainTextRenderer.tsx` | Monospace `<pre>` with line numbers |
| `CodeRenderer.tsx` | `react-syntax-highlighter` with `vscDarkPlus` theme and line numbers |
| `MarkdownRenderer.tsx` | `react-markdown` + `remark-gfm` with custom HUD-themed components (headings, tables, code blocks, links) |
| `FileContentRenderer.tsx` | Dispatcher — routes to the correct renderer based on file extension, shows error/binary fallback states |
| `DirectoryTreeNode.tsx` | Single tree node with depth indentation, expand/collapse chevron, active file highlighting |
| `DirectoryTree.tsx` | Recursive tree rooted at agent's working directory, lazy-loads children on expand, caches results in a Map ref |
| `FileViewerHeader.tsx` | Breadcrumb path (clickable segments), back button, language/size labels, "VS Code" button |
| `FileViewerPanel.tsx` | Top-level layout: header + split view (250px tree sidebar + flex-1 content area). Loads file on path change. Escape key closes. |

### Integration

**`MainContent.tsx`** — When `viewingFile` is set, renders `<FileViewerPanel />` instead of the agent grid.

**`FileActivityList.tsx`** — Primary click now calls `openFileViewer()` to open files in-app. A hover-visible "VS" button provides direct VS Code access as secondary action.

**`DetailPaneProducts.tsx` / `DetailPaneContext.tsx`** — Pass `agentId` through to `FileActivityList`.

## Dependencies Added

```
react-markdown
remark-gfm
react-syntax-highlighter
@types/react-syntax-highlighter (dev)
```

## Supported File Types

| Type | Extensions | Rendering |
|------|-----------|-----------|
| Markdown | `.md`, `.mdx`, `.markdown` | Rendered GFM with styled headings, tables, code blocks |
| Code | `.ts`, `.tsx`, `.js`, `.py`, `.rs`, `.go`, `.java`, `.css`, `.json`, `.yaml`, `.sql`, `.sh`, +40 more | Syntax-highlighted with `vscDarkPlus` theme |
| Text | `.txt`, `.log`, `.env`, `.gitignore`, etc. | Monospace with line numbers |
| Binary | `.png`, `.zip`, `.exe`, `.pdf`, etc. | Message with "Open in VS Code" fallback |

## Edge Cases Handled

- **Large files (>1MB)**: Content capped, error message with VS Code fallback
- **Binary files**: Detected by extension, shown with informational message
- **WSL path injection**: Paths with `$`, backtick, `;`, `|`, `&` are rejected
- **Slow WSL**: 10-second timeout on all WSL operations, loading spinner shown
- **File not found / read errors**: Error field in `FileContent`, distinct UI state with VS Code fallback
- **Directory caching**: Loaded subdirectories cached in a Map ref to avoid repeated WSL calls

## Interaction Model

### Click Behaviors

| Action | Location | Result |
|--------|----------|--------|
| Single click | File activity list | Opens file in native file viewer |
| Double click | File activity list | Opens file in VS Code (workspace-aware) |
| Right click | File activity list | Context menu |
| Single click | Directory tree (file) | Opens file in native file viewer |
| Double click | Directory tree (file) | Opens file in VS Code (workspace-aware) |
| Right click | Directory tree (file) | Context menu |
| "VS Code" button | File viewer header | Opens file in VS Code (workspace-aware) |

Single click uses a 250ms debounce to distinguish from double click.

### Context Menu

Right-clicking a file shows a context menu with these options:

- **Copy Path** — copies the full file path to clipboard
- **Copy Relative Path** — copies the path relative to the agent's working directory
- **Open in VS Code** — opens the file in the correct VS Code workspace window
- **Reveal in Tree** — (file activity list only) opens the file viewer and navigates the directory tree to the file

### Workspace-Aware VS Code Opening

VS Code opening uses `--folder-uri` to target the correct workspace window. For WSL paths, it constructs a `vscode-remote://wsl+Ubuntu` folder URI. This ensures the file opens in the VS Code window that has the agent's workspace open, rather than a random window.

IPC channel: `system:open-file-in-workspace` — takes `filePath`, `workspaceDir`, and `pathType`.

## User Flow

1. Launch an agent, let it read/write files
2. Click a file in CONTEXT or OUTPUTS tab
3. Center panel switches from agent grid to file viewer
4. Directory tree on left shows agent's working directory — click to navigate
5. File content renders in the main area with appropriate formatting
6. Double-click a file to open it in VS Code in the correct workspace window
7. Right-click a file for copy path, open in VS Code, or reveal in tree
8. Hover a file in the activity list to reveal "VS" button for external editing
9. Click "Back" or press Escape to return to agent grid
