# File Management and Editing Execution Plan

Audience: an autonomous coding agent implementing file creation, deletion, rename, and editing in AgentDashboard.

Goal: let a user manage and edit files inside the directories they are working in from the dashboard file viewer. This includes creating/deleting/renaming folders and files, editing text-like files such as `.md`, `.txt`, `.json`, `.py`, config files, and creating/opening `.ipynb` notebooks through the existing notebook/Jupyter path.

Non-goal: do not turn the dashboard into a full VS Code replacement. Keep the MVP focused on safe filesystem operations, light text editing, and handoff to the existing notebook UI for `.ipynb`.

## Current Architecture Context

This is an Electron + Vite + React app.

Key files and current responsibilities:

- `src/main/ipc-handlers.ts`: registers Electron IPC handlers. File viewer IPC currently supports `files:read`, `files:list-directory`, `files:watch-start`, and `files:watch-stop`.
- `src/main/file-reader.ts`: existing safe-ish read path for Windows and WSL paths. Reuse its pattern for new write operations.
- `src/main/path-utils.ts`: converts Windows/WSL/UNC paths. Use `detectPathType()`, `ensureWslPath()`, and `ensureWindowsPath()` instead of reimplementing conversion.
- `src/main/fs-watcher.ts`: existing directory watcher. Windows uses chokidar; WSL uses `inotifywait` or polling. Mutations should usually show up through this, but explicit refresh/invalidation is still needed for immediate UI consistency.
- `src/preload/index.ts`: exposes `window.api.files` to the renderer.
- `src/shared/types.ts`: defines `IpcApi`, `PathType`, `DirectoryEntry`, `FileContent`, `FsEvent`, and `FileTab`.
- `src/renderer/components/fileviewer/DirectoryTree.tsx`: root file tree. It has a directory cache, a refresh button, F5/Ctrl+R refresh handling, and watches the root directory.
- `src/renderer/components/fileviewer/DirectoryTreeNode.tsx`: recursive tree node. Today directories can be expanded, files can be selected/opened, and only files get a context menu.
- `src/renderer/components/shared/FileContextMenu.tsx`: current read-only menu: copy path, copy relative path, open in VS Code, reveal in tree.
- `src/renderer/components/fileviewer/FileContentArea.tsx`: loads file content and chooses media vs text rendering.
- `src/renderer/components/fileviewer/FileContentRenderer.tsx`: routes file content to markdown/code/text/csv/notebook/image/pdf/geospatial renderers.
- `src/renderer/components/fileviewer/useFileContentCache.ts`: module-level tab content cache with `evictTabCache()` and `evictAllCache()`.
- `src/renderer/components/fileviewer/FileViewerHeader.tsx`: breadcrumb/header area with VS Code button.
- `src/renderer/components/fileviewer/FileTabBar.tsx`: open tab UI. No dirty-state indicator exists yet.
- `src/renderer/components/fileviewer/fileTypeUtils.ts`: file type detection. Reuse this to decide editable files.
- `src/renderer/stores/dashboard-store.ts`: Zustand store for workspaces, agents, tabs, layout, and file viewer state.
- `src/renderer/components/fileviewer/InteractiveNotebookRenderer.tsx`: current `.ipynb` renderer, backed by an embedded local JupyterLab iframe.
- `src/renderer/components/fileviewer/NotebookRenderer.tsx`: static notebook renderer used for fallback/non-standard notebooks.
- `docs/FILE_EDITING_MVP.md`: older MVP plan. It is useful background, but this document is the execution plan to follow.

Baseline noted during scoping: `npm run build` passes before this plan was written.

Important repository condition: this worktree may already contain many unrelated modified/untracked files. Do not revert, overwrite, or clean files unrelated to this task. If you need a clean baseline, ask the human to create a branch or checkpoint first.

## Product Scope

MVP features:

- Right-click a directory: create file, create folder, create notebook, rename, delete.
- Right-click a file: rename, delete, open in editor if editable, open in VS Code.
- Create files inside the selected directory.
- Delete files and folders, with stronger confirmation for recursive folder deletion.
- Rename files and folders.
- Edit text-like files in the dashboard and save changes.
- Show dirty state on tabs and block accidental close/discard.
- Create a valid blank `.ipynb` notebook and open it in the existing notebook renderer.
- Keep binary, geospatial, image, PDF, CSV structured editing, and full custom notebook editing out of MVP.

Editable in MVP:

- `markdown`, `text`, and `code` file types from `fileTypeUtils.ts`.
- JSON/YAML/TOML/config files count as editable through the `code` path.

Read-only in MVP:

- `csv`, `image`, `pdf`, `geotiff`, `shapefile`, `geopackage`, `binary`.
- `.ipynb` should not be edited as raw JSON in the generic editor. Let the existing Jupyter renderer own notebook editing.

## Cross-Cutting Safety Requirements

These are load-bearing. Do not skip them.

- All filesystem mutations must run in the main process, never directly in the renderer.
- Every write/delete/rename/mkdir path must be resolved and validated server-side.
- Do not rely on renderer-provided `isDirectory` for destructive operations. Re-stat the target in the main process.
- Constrain operations to the active root/working directory where possible. The renderer should pass both `targetPath` and `rootDirectory`; the main process should verify the target is inside the root.
- Reject path traversal names: `..`, `/`, `\`, empty names, drive roots, and absolute paths when a name is expected.
- For WSL commands that go through `bash -lc`, reject shell-dangerous characters in paths/names: `$`, backtick, `;`, `&`, `|`.
- Prefer `execFileSync('wsl.exe', ['bash', '-lc', command], ...)` over shell-composed Windows commands.
- For WSL file content writes, pipe content through stdin instead of embedding content in the shell command.
- Enforce a text write size cap. Use 5 MB for MVP.
- Folder deletion must be explicitly recursive and confirmed in the UI. Main process must verify the target is a directory before recursive delete.
- `fs.rmSync(..., { force: false })` for Windows. Do not silently ignore failed deletes.
- Do not auto-create parent directories on file write.
- Do not implement batch operations in MVP.

## Part 0: Preparation and Baseline

Purpose: start from known context and avoid mixing unrelated changes.

Files to inspect:

- `git status --short`
- `package.json`
- `src/main/ipc-handlers.ts`
- `src/main/file-reader.ts`
- `src/main/path-utils.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- `src/renderer/components/fileviewer/*`
- `src/renderer/components/shared/FileContextMenu.tsx`
- `src/renderer/stores/dashboard-store.ts`

Steps:

1. Run `git status --short`.
2. If the worktree contains unrelated changes, do not revert them. Continue only if the touched files for this feature can be edited safely.
3. Run `npm run build` before code changes. If it fails, stop and report the pre-existing failure.
4. Read this whole plan plus `docs/FILE_EDITING_MVP.md`.

Acceptance:

- You know whether the build starts green.
- You have identified the exact files you will touch.
- You have not cleaned or reverted unrelated changes.

## Part 1: Main-Process File Mutation Layer

Purpose: add one safe, reusable main-process module for all filesystem writes and mutations.

Create:

- `src/main/file-writer.ts`

Recommended exported API:

```ts
import type { PathType } from '../shared/types';

export type FileMutationResult =
  | { ok: true; path?: string }
  | { ok: false; error: string };

export function writeFileContents(
  filePath: string,
  rootDirectory: string,
  pathType: PathType,
  content: string,
): FileMutationResult;

export function createFile(
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string,
  template?: 'text' | 'markdown' | 'notebook',
): FileMutationResult;

export function createDirectory(
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string,
): FileMutationResult;

export function renameEntry(
  oldPath: string,
  rootDirectory: string,
  pathType: PathType,
  newName: string,
): FileMutationResult;

export function deleteEntry(
  entryPath: string,
  rootDirectory: string,
  pathType: PathType,
  recursive: boolean,
): FileMutationResult;
```

Implementation context:

- Mirror the error-handling style of `src/main/file-reader.ts`: catch exceptions and return `{ ok: false, error }`.
- Use `ensureWslPath()` for WSL operations.
- For Windows operations, use Node `fs` and `path`.
- For WSL operations, use `wsl.exe bash -lc`.
- Keep helper functions private unless needed elsewhere.

Required helpers:

- `sanitizeName(name: string): string`
- `sanitizeShellPath(p: string): string`
- `assertInsideRoot(targetPath: string, rootDirectory: string, pathType: PathType): void`
- `joinPath(parentDir: string, name: string, pathType: PathType): string`
- `blankNotebookJson(): string`

Name validation:

- Reject empty names.
- Reject `.` and `..`.
- Reject names containing `/` or `\`.
- Reject names containing `$`, backtick, `;`, `&`, `|`.
- Reject names with ASCII control characters.
- Consider rejecting trailing spaces/dots on Windows because they behave poorly in Explorer.

Root containment:

- For Windows: resolve both target and root with `path.resolve()`, then ensure target starts with root plus separator or equals root when appropriate.
- For WSL: convert both to WSL paths with `ensureWslPath()`, normalize duplicated slashes, and ensure target starts with root plus `/` or equals root when appropriate.
- Do not allow deleting or renaming the root directory itself.

Blank notebook template:

Use a valid nbformat 4 notebook:

```json
{
  "cells": [],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python"
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
```

WSL command notes:

- Write content with stdin:

```ts
execFileSync('wsl.exe', ['bash', '-lc', `cat > '${wslPath}'`], {
  input: content,
  encoding: 'utf-8',
  timeout: WSL_TIMEOUT,
  maxBuffer: 1024 * 1024,
});
```

- For create file, prefer `: > 'path'` for empty text files or stdin for templates.
- For mkdir, use `mkdir 'path'`, not `mkdir -p`, so duplicate names fail.
- For rename, use `mv -- 'old' 'new'` after path sanitization.
- For delete file, use `rm -- 'path'`.
- For delete directory, use `rm -r -- 'path'` only when `recursive === true` and main process stat confirms directory.

Acceptance:

- Windows create/write/mkdir/rename/delete functions work in direct manual invocation or through IPC added in Part 2.
- WSL equivalents work.
- Invalid names are rejected consistently.
- Targets outside `rootDirectory` are rejected.
- Deleting root is rejected.
- Writes over 5 MB are rejected.

## Part 2: IPC, Preload, and Shared Types

Purpose: expose the safe mutation layer to the renderer.

Modify:

- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`

Shared type additions:

```ts
export type FileMutationResult =
  | { ok: true; path?: string }
  | { ok: false; error: string };
```

Extend `IpcApi.files`:

```ts
writeFile: (
  filePath: string,
  rootDirectory: string,
  pathType: PathType,
  content: string
) => Promise<FileMutationResult>;

createFile: (
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string,
  template?: 'text' | 'markdown' | 'notebook'
) => Promise<FileMutationResult>;

mkdir: (
  parentDir: string,
  rootDirectory: string,
  pathType: PathType,
  name: string
) => Promise<FileMutationResult>;

rename: (
  oldPath: string,
  rootDirectory: string,
  pathType: PathType,
  newName: string
) => Promise<FileMutationResult>;

deleteEntry: (
  entryPath: string,
  rootDirectory: string,
  pathType: PathType,
  recursive: boolean
) => Promise<FileMutationResult>;
```

IPC names:

- `files:write`
- `files:create-file`
- `files:mkdir`
- `files:rename`
- `files:delete`

Implementation notes:

- Resolve `pathType || detectPathType(path)` in each handler.
- Do not trust renderer-provided path type blindly if a path clearly contradicts it; use existing app conventions here.
- IPC handlers should return `FileMutationResult`, not throw.

Acceptance:

- TypeScript build passes.
- `window.api.files.*` exposes all new methods.
- IPC calls return `{ ok: false, error }` for invalid input and do not crash the app.

## Part 3: Directory Tree and Context Menu Operations

Purpose: let users create, rename, and delete files/folders from the tree.

Modify:

- `src/renderer/components/shared/FileContextMenu.tsx`
- `src/renderer/components/fileviewer/DirectoryTreeNode.tsx`
- `src/renderer/components/fileviewer/DirectoryTree.tsx`

Context menu changes:

- Add props:

```ts
isDirectory: boolean;
onCreateFile?: () => void;
onCreateFolder?: () => void;
onCreateNotebook?: () => void;
onRename?: () => void;
onDelete?: () => void;
```

- Show these items:
  - `New File...` for directories.
  - `New Markdown File...` for directories.
  - `New Notebook...` for directories.
  - `New Folder...` for directories.
  - `Rename...` for files and directories.
  - `Delete...` for files and directories.

MVP prompt UX:

- Use `window.prompt()` and `window.confirm()` for MVP.
- If time allows, replace with app-styled dialogs later, but do not block the MVP on custom modal work.
- Folder delete prompt must clearly say recursive delete, for example: `Delete folder "data" and everything inside it?`

DirectoryTreeNode changes:

- Remove the current early return that blocks context menu on directories.
- For a directory node, right-click should open the menu without toggling expansion.
- For create actions, parent dir is `entry.path` if `entry.isDirectory`.
- For file rename/delete, target is `entry.path`.
- For directory rename/delete, target is `entry.path`.
- After a successful create inside a collapsed directory, either expand it and reload children or leave collapsed and rely on watcher. Prefer expand/reload for immediate feedback.
- After a successful create file/notebook, call `onFileSelect(result.path)` if `result.path` exists.
- After deleting an open file, the tab should eventually be closed in Part 4/6. For Part 3, at least refresh the tree.

DirectoryTree changes:

- Add explicit invalidation helpers:

```ts
function invalidateDir(dirPath: string): void;
function reloadRoot(): void;
```

- Pass `onTreeChanged(parentDir)` down to nodes.
- When mutation succeeds, delete cache entries for the affected parent directory and force affected node/root reload.
- Keep the existing watcher; explicit invalidation is for immediate UX.

Path parent handling:

- In Windows renderer code, use simple helpers that handle both `/` and `\`.
- Do not import Node `path` in renderer unless already configured for it. A simple split on `/` and `\` is enough.

Acceptance:

- Right-click works on both files and folders.
- Create file/folder/notebook appears in tree without app restart.
- Rename updates tree.
- Delete removes entry from tree.
- Creating a notebook opens the new `.ipynb` through existing file selection.
- Invalid names show a clear error.

## Part 4: Text Editing and Dirty Tab State

Purpose: allow editing and saving text-like files inside the dashboard.

Modify:

- `package.json`
- `src/renderer/stores/dashboard-store.ts`
- `src/renderer/components/fileviewer/FileContentArea.tsx`
- `src/renderer/components/fileviewer/FileViewerHeader.tsx`
- `src/renderer/components/fileviewer/FileViewerPanel.tsx`
- `src/renderer/components/fileviewer/FileTabBar.tsx`
- `src/renderer/components/fileviewer/fileTypeUtils.ts` if a helper is useful.

Create:

- `src/renderer/components/fileviewer/CodeMirrorEditor.tsx`

Dependencies:

Install focused CodeMirror packages, not the `codemirror` meta-package:

```bash
npm install @codemirror/state @codemirror/view @codemirror/commands @codemirror/language @codemirror/lang-markdown @codemirror/theme-one-dark
```

If package versions conflict with future notebook work, prefer the version pins from `docs/NOTEBOOK_FULL_SEND_PLAN.md`.

Editable file helper:

Add a helper in `fileTypeUtils.ts`:

```ts
export function isEditableFileType(filePath: string): boolean {
  const type = detectFileType(filePath);
  return type === 'markdown' || type === 'text' || type === 'code';
}
```

Store state shape:

Add to `dashboard-store.ts`:

```ts
interface TabEditState {
  mode: 'view' | 'edit';
  draftContent: string;
  originalContent: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

tabEditState: Record<string, TabEditState>;
enterEditMode: (tabId: string, initialContent: string) => void;
exitEditMode: (tabId: string) => void;
setDraftContent: (tabId: string, content: string) => void;
saveTab: (tabId: string) => Promise<boolean>;
discardTabChanges: (tabId: string) => void;
```

Save flow:

- `saveTab(tabId)` finds the tab, sends `window.api.files.writeFile(tab.filePath, tab.rootDirectory, tab.pathType, draftContent)`.
- On success:
  - set `originalContent = draftContent`
  - set `dirty = false`
  - set `saving = false`
  - clear error
  - call `evictTabCache(tabId)`
- On failure:
  - keep draft
  - set error
  - set `saving = false`

CodeMirrorEditor props:

```ts
interface Props {
  initialContent: string;
  language: 'markdown' | 'text';
  saving?: boolean;
  error?: string | null;
  onChange: (content: string) => void;
  onSave: () => void;
}
```

Editor requirements:

- Mount `EditorView` in a ref container.
- Use `history()`, `defaultKeymap`, `historyKeymap`, and `Mod-s` save binding.
- Use line wrapping.
- Use `markdown()` when language is `markdown`.
- Destroy the editor on unmount.
- Match the height behavior of existing renderers.

FileContentArea integration:

- Load content through `useFileContentCache()`.
- If active tab edit state is `edit` and file is editable, render `CodeMirrorEditor`.
- Otherwise render `FileContentRenderer`.
- If content has an error, do not enter edit mode.

FileViewerHeader integration:

- Add `Edit` button for editable files.
- In edit mode, show `View` and `Save`.
- Disable Save when not dirty or saving.
- Show saving state.
- Show an inline save error if present.

Keyboard behavior:

- In `FileViewerPanel.tsx`, intercept Ctrl/Cmd+S when the active tab is in edit mode and call `saveTab`.
- Prevent the browser/Electron save-page behavior.

Tab dirty indicator:

- In `FileTabBar.tsx`, show a small dot or marker when a tab is dirty.
- On tab close, if dirty, prompt `Discard unsaved changes?`.
- On Escape/Ctrl+W close shortcuts, enforce the same dirty check.

Acceptance:

- `.md`, `.txt`, `.json`, and `.py` can enter edit mode.
- Typing marks the tab dirty.
- Save writes to disk and clears dirty state.
- Ctrl/Cmd+S saves.
- Close dirty tab prompts before discard.
- Failed save keeps draft content and shows error.
- Read-only file types do not show Edit.

## Part 5: Notebook-Specific Handling

Purpose: support the user's `.ipynb` requirement without corrupting notebooks through raw JSON editing.

Relevant existing files:

- `src/renderer/components/fileviewer/FileContentRenderer.tsx`
- `src/renderer/components/fileviewer/InteractiveNotebookRenderer.tsx`
- `src/main/jupyter-server.ts`
- `src/main/jupyter-kernel-client.ts`
- `scripts/notebook-kernel-smoke.mjs`
- `docs/NOTEBOOK_PROTOTYPE.md`
- `docs/NOTEBOOK_FULL_SEND_PLAN.md`

Scope:

- Creating `.ipynb` notebooks is in scope.
- Opening/editing `.ipynb` through the existing `InteractiveNotebookRenderer` is in scope.
- Raw JSON editing of `.ipynb` in the generic CodeMirror editor is out of scope.

Implementation:

- `New Notebook...` context menu action should ensure the name ends with `.ipynb`.
- Use `createFile(..., template: 'notebook')`.
- After success, call `onFileSelect(result.path)` to open the notebook.
- Do not mark `.ipynb` as editable via `isEditableFileType()`.

Acceptance:

- Creating `analysis.ipynb` creates valid JSON.
- Clicking the new notebook routes to `InteractiveNotebookRenderer`.
- The app does not offer generic raw edit mode for `.ipynb`.
- Static fallback still works if Jupyter server fails.

## Part 6: External Changes, Cache Invalidation, and Open Tabs

Purpose: keep UI state coherent when files are mutated by the dashboard, agents, or external tools.

Relevant existing context:

- `DirectoryTree.tsx` already watches root directory and applies `applyFsEvent()`.
- `DirectoryTreeNode.tsx` watches expanded directories.
- `useFileContentCache.ts` caches by tab id.
- Agents may modify files independently while the user has them open.

MVP behavior:

- For dashboard save, evict the tab cache after successful save.
- For dashboard rename/delete:
  - If the renamed/deleted file has an open tab, either close that tab or update it.
  - MVP can close affected tabs with a brief user-visible error/notice if easier.
- For external file changes while viewing:
  - Existing file watcher will update tree entries.
  - Do not automatically overwrite unsaved drafts.

Recommended minimal store additions:

```ts
closeTabsForPath: (path: string) => void;
renameTabPath: (oldPath: string, newPath: string) => void;
hasDirtyTabForPath: (path: string) => boolean;
```

Delete behavior:

- If deleting a dirty open file, prompt before delete:
  - `This file has unsaved changes in an open tab. Delete anyway?`
- After successful delete, close tabs for that path and evict their cache.

Rename behavior:

- If renaming a dirty open file, prompt before rename or block the rename until saved/discarded.
- After successful rename, update the open tab path and label if feasible.
- If updating tabs is risky, close the old tab and open the new path after rename.

Conflict detection:

- Full mtime conflict detection is out of MVP.
- If implemented later, add file stat metadata to `FileContent` and compare before save.

Acceptance:

- Deleting an open file does not leave a broken active tab.
- Renaming an open file does not leave a stale path tab.
- Unsaved drafts are not silently discarded by tree operations.

## Part 7: QA and Manual Test Matrix

Purpose: verify safety and core workflows.

Run:

```bash
npm run build
```

Manual Windows path tests:

- Create folder at workspace root.
- Create nested folder.
- Create `.txt`, edit, save, close, reopen, verify content.
- Create `.md`, edit, save, verify markdown renders in view mode.
- Create `.json`, edit, save, verify content.
- Rename file.
- Rename folder.
- Delete file.
- Delete non-empty folder after confirmation.
- Try invalid names: `..`, `a/b`, `a\b`, `bad;name`, `bad&name`, `bad|name`, `bad$name`, ``bad`name``.

Manual WSL path tests:

- Repeat the same matrix in a WSL workspace or WSL working directory.
- Confirm paths created by the tree are usable by the existing agent/Jupyter workflows.

Notebook tests:

- Create `new_test.ipynb`.
- Open it from the tree.
- Confirm the Jupyter renderer or static fallback appears.
- Confirm generic Edit button does not appear for `.ipynb`.

Dirty-state tests:

- Edit a file and close tab: discard prompt appears.
- Edit a file and press Ctrl/Cmd+S: save occurs.
- Edit a file, create external change, save: MVP overwrite behavior is understood and no draft is lost before save.
- Save failure: draft remains.

Destructive safety tests:

- Attempt to delete the workspace root: rejected.
- Attempt to rename root: rejected.
- Attempt traversal name: rejected.
- Attempt operation outside root by direct IPC from DevTools if possible: rejected.

Acceptance:

- `npm run build` passes.
- Manual matrix passes for at least Windows paths.
- WSL parity is tested if WSL is part of the user's active workflow.
- Any skipped WSL/notebook case is documented in the final report.

## Suggested Commit Boundaries

Use small commits so another agent can recover if context is lost:

1. `file management: add safe main-process writer`
2. `file management: expose mutation IPC`
3. `file management: add tree create rename delete actions`
4. `file editing: add editor and dirty tab state`
5. `file management: add notebook creation handling`
6. `file management: handle open tabs after rename delete`
7. `file management: final qa fixes`

Do not amend commits unless the human explicitly asks.

## Final Report Template

When finished, report:

- What shipped.
- Files changed at a high level.
- Build/test result.
- Manual test matrix summary.
- Known limitations.
- Any risks left for Phase 2.

Known likely Phase 2 items:

- Custom modal dialogs instead of `window.prompt()`/`window.confirm()`.
- File import/upload by drag and drop.
- Copy/duplicate/move operations.
- mtime-based conflict detection.
- Autosave option.
- Syntax-highlighted editing per language.
- Rich CSV editing.
- Custom React notebook editor from `docs/NOTEBOOK_FULL_SEND_PLAN.md`.
