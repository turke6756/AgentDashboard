# File Editing MVP — Basic Editing + Folder/File Creation

**Scope:** Extend AgentDashboard from viewer-only to support light editing (plain text, markdown) plus file/folder create/rename/delete. Keep the "not a VS Code replacement" posture.

**Effort:** ~13 focused hours / ~2 calendar days.

---

## Architecture Overview

The existing read path is clean and well-sanitized: `ipc-handlers.ts` → `file-reader.ts` → `path-utils.ts` (with `ensureWslPath` + `DANGEROUS_CHARS` sanitization). This plan extends the same pattern for writes.

On the renderer side, add CodeMirror 6 as a new editor component that conditionally replaces `PlainTextRenderer`/`MarkdownRenderer` when a tab enters edit mode. Wire dirty state into the existing Zustand store (`dashboard-store.ts`) and `FileTabBar.tsx`. Context menu actions on the tree extend `FileContextMenu.tsx` and bubble up through `DirectoryTreeNode.tsx` → `DirectoryTree.tsx` to trigger cache invalidation/refresh.

---

## Ordered Implementation Steps

### Step 1 — Main-process write/FS-mutation module  *(~2 hr)*

**New file:** `src/main/file-writer.ts`

Mirror the structure of `file-reader.ts`. Export four functions, each taking `(path, pathType, ...args)` returning `{ ok: true } | { ok: false; error: string }`:

- `writeFileContents(filePath, pathType, content)`
  - Windows: `fs.writeFileSync(filePath, content, 'utf-8')`
  - WSL: `execFileSync('wsl.exe', ['bash','-lc',"cat > '<wslPath>'"], { input: content })` — stdin piping avoids content-escape hazards.
- `createDirectory(dirPath, pathType)`
  - Windows: `fs.mkdirSync(dirPath, { recursive: false })`
  - WSL: `wsl.exe bash -lc "mkdir '<wslPath>'"`
- `deleteEntry(entryPath, pathType, isDirectory)`
  - Windows: `fs.rmSync(p, { recursive: isDirectory, force: false })`
  - WSL: `rm -f '<p>'` for files, `rm -rf '<p>'` for dirs (only when `isDirectory === true` from UI confirmation)
- `renameEntry(oldPath, newPath, pathType)`
  - Windows: `fs.renameSync`
  - WSL: `mv '<old>' '<new>'`

All paths go through `sanitizePath()` (reuse or export from `file-reader.ts`) and `ensureWslPath()`. **The DANGEROUS_CHARS regex `/[$\`;&|]/` MUST apply to every WSL path passed into `bash -lc`.** Since new files/folders contain user-entered names, add a `sanitizeName()` that also disallows `/`, `\`, `..` on both Windows and WSL to prevent traversal.

Enforce a 5 MB write cap.

### Step 2 — Register IPC handlers  *(~30 min)*

**File:** `src/main/ipc-handlers.ts` (after the existing `files:read` / `files:list-directory` block, ~line 230-237)

- `files:write` → `writeFileContents(...)`
- `files:mkdir` → `createDirectory(...)`
- `files:delete` → `deleteEntry(...)`
- `files:rename` → `renameEntry(...)`

### Step 3 — Preload surface  *(~15 min)*

**File:** `src/preload/index.ts` (the `files:` block, ~lines 49-52)

```ts
writeFile: (filePath, pathType, content) => ipcRenderer.invoke('files:write', filePath, pathType, content),
mkdir: (dirPath, pathType) => ipcRenderer.invoke('files:mkdir', dirPath, pathType),
deleteEntry: (entryPath, pathType, isDirectory) => ipcRenderer.invoke('files:delete', entryPath, pathType, isDirectory),
rename: (oldPath, newPath, pathType) => ipcRenderer.invoke('files:rename', oldPath, newPath, pathType),
```

**File:** `src/shared/types.ts` — extend `IpcApi.files` (~lines 361-364) + add `FileWriteResult = { ok: true } | { ok: false; error: string }`.

### Step 4 — Add CodeMirror 6 dependencies  *(~10 min)*

```
@codemirror/state
@codemirror/view
@codemirror/commands
@codemirror/language
@codemirror/lang-markdown
@codemirror/theme-one-dark
```

Size budget: ~200 kB gzipped. Do **not** install the `codemirror` meta-package — slimmer this way.

### Step 5 — CodeMirror editor component  *(~3 hr)*

**New file:** `src/renderer/components/fileviewer/CodeMirrorEditor.tsx`

Props: `{ initialContent: string; language: 'markdown' | 'text'; onChange: (content: string) => void; onSave: () => void }`.

- Create `EditorView` in a `useRef`'d container on mount.
- Extensions: `history()`, `keymap.of([...defaultKeymap, ...historyKeymap, { key: 'Mod-s', run: () => { onSave(); return true } }])`, `EditorView.lineWrapping`, `oneDark` (gated on `useThemeStore`), conditionally `markdown()`.
- `EditorView.updateListener.of` → propagate `onChange` on `docChanged`.
- Clean up view on unmount.
- Match sizing pattern of `PlainTextRenderer` (`h-full overflow-auto`).

### Step 6 — Dirty-state + save flow in store  *(~1 hr)*

**File:** `src/renderer/stores/dashboard-store.ts`

Add a sibling `Map<tabId, { mode: 'view' | 'edit'; draftContent: string; originalContent: string; dirty: boolean; saving: boolean }>` called `tabEditState`. Keep `FileTab` in `types.ts` unchanged so other code paths stay quiet.

Actions: `enterEditMode(tabId)`, `exitEditMode(tabId)`, `setDraftContent(tabId, content)`, `saveActiveTab()`.

`saveActiveTab()` calls `window.api.files.writeFile(...)`. On success: update `originalContent`, clear `dirty`, call `evictTabCache(tabId)` from `useFileContentCache.ts` (already exists). On failure: surface an inline error in the editor chrome.

### Step 7 — Wire edit mode into FileContentArea  *(~1.5 hr)*

**File:** `src/renderer/components/fileviewer/FileContentArea.tsx`

Read edit state from store. If `mode === 'edit'` AND file type is `text`, `markdown`, or `code` → render `<CodeMirrorEditor>` instead of `<FileContentRenderer>`.

Note: code-mode files in edit render with `language='text'` (no syntax highlighting). Conscious trade-off to keep bundle small.

### Step 8 — Edit toggle + Save button  *(~45 min)*

**File:** `src/renderer/components/fileviewer/FileViewerHeader.tsx`

Add two buttons next to "Open in VS Code":
- "Edit" / "View" toggle (only for editable file types)
- "Save" (visible only in edit mode; disabled when `!dirty`; spinner when `saving`)

Also guard Ctrl+S in `FileViewerPanel.tsx` keyboard handler (~lines 61-78): `e.preventDefault()` when active tab is in edit mode, to block browser save-page default.

### Step 9 — Dirty indicator on tabs  *(~20 min)*

**File:** `src/renderer/components/fileviewer/FileTabBar.tsx`

Render a small filled circle to the left of the close X when `dirty`. On close of dirty tab, use `window.confirm('Discard unsaved changes?')` for MVP.

### Step 10 — Context menu: New/Rename/Delete  *(~2 hr)*

**File:** `src/renderer/components/shared/FileContextMenu.tsx`

Extend props: `isDirectory: boolean`, `onCreateFile?`, `onCreateFolder?`, `onRename?`, `onDelete?`.

New items (under a divider):
- "New File..." (directories only — `window.prompt` for name)
- "New Folder..." (directories only)
- "Rename..." (files + dirs)
- "Delete" (files + dirs, confirmation prompt — for dirs, call out recursive delete)

**File:** `src/renderer/components/fileviewer/DirectoryTreeNode.tsx`

Current node shows context menu only on **files** (line 63: `if (entry.isDirectory) return;`). Change that — directories need the menu too for New File/Folder. Wire callbacks to `window.api.files.*`, then call a new `onTreeChanged()` prop to refresh parent listing.

**File:** `src/renderer/components/fileviewer/DirectoryTree.tsx`

Tree caches entries in `useRef(new Map<string, DirectoryEntry[]>)` (~lines 15, 32-34). Add `refreshDir(dirPath)` that deletes the key and forces the node to re-fetch. Pass `invalidate: (dirPath: string) => void` down into `DirectoryTreeNode`.

For root-level mutations, also re-run the top-level `listDirectory` call.

### Step 11 — Manual tree refresh button  *(~20 min)*

**File:** `src/renderer/components/fileviewer/DirectoryTree.tsx`

Add a small refresh icon next to "Explorer" header (~lines 44-49). Calls the same invalidation + reload path. Covers external edits (other processes, agents) until Phase 2 adds a watcher.

### Step 12 — Smoke / manual test checklist  *(~1 hr)*

No automated test infra in this repo. Manual matrix:

- New file at root + in nested dir, Windows + WSL roots
- Rename file; rename folder (open tabs for renamed paths — close tab if read fails)
- Delete file; delete folder (confirm prompt)
- Edit `.md`, save, reload — content persists
- Edit `.txt`, Ctrl+S, close tab immediately — no hang
- Close dirty tab → discard prompt
- Injection attempts: filename with `$`, `` ` ``, `;`, `&`, `|`, `..`, `/`, `\` — all rejected
- Full WSL parity: every case above on a `\\wsl.localhost\Ubuntu\...` root

---

## New Files

- `src/main/file-writer.ts`
- `src/renderer/components/fileviewer/CodeMirrorEditor.tsx`

## Modified Files

- `src/main/ipc-handlers.ts`
- `src/preload/index.ts`
- `src/shared/types.ts`
- `src/renderer/stores/dashboard-store.ts`
- `src/renderer/components/fileviewer/FileContentArea.tsx`
- `src/renderer/components/fileviewer/FileViewerHeader.tsx`
- `src/renderer/components/fileviewer/FileViewerPanel.tsx`
- `src/renderer/components/fileviewer/FileTabBar.tsx`
- `src/renderer/components/shared/FileContextMenu.tsx`
- `src/renderer/components/fileviewer/DirectoryTreeNode.tsx`
- `src/renderer/components/fileviewer/DirectoryTree.tsx`

## Dependency Additions (package.json)

```json
"@codemirror/state": "^6",
"@codemirror/view": "^6",
"@codemirror/commands": "^6",
"@codemirror/language": "^6",
"@codemirror/lang-markdown": "^6",
"@codemirror/theme-one-dark": "^6"
```

---

## Security Considerations

1. **Path + name sanitization.** Existing `sanitizePath()` regex `/[$\`;&|]/` currently only runs for WSL (since only WSL shells into `bash -lc`). For writes:
   - WSL writes still shell out → regex still applies.
   - User-entered **names** must be sanitized *before* concatenation to the parent dir. A malicious name like `foo;rm -rf /` into a `bash -lc` command is command injection.
   - Add `sanitizeName()` rejecting `/`, `\`, `..`, and the existing dangerous chars. Apply on both Windows and WSL sides to prevent traversal.

2. **Recursive delete gating.** `rm -rf` (WSL) and `fs.rmSync({ recursive: true })` (Windows) are the blast-radius risk. Only allow `recursive: true` when target is a directory AND UI passed explicit confirmation. IPC handler validates `isDirectory` before forwarding.

3. **Write size cap.** 5 MB max to prevent OOM on WSL stdin pipe.

4. **Symlink traversal.** Keep `fs.rmSync({ force: false })` default — refuses to cross symlinks.

5. **No auto-mkdir on write.** `fs.writeFileSync` fails on missing parent dir (default). Don't silently create intermediate directories — catches typos.

## WSL Parity — Confirmed Pattern

The read pattern in `file-reader.ts` lines 26-45:
1. `ensureWslPath(filePath, 'wsl')` converts UNC/Windows-style to Linux path
2. `sanitizePath()` rejects shell-dangerous chars
3. `execFileSync('wsl.exe', ['bash','-lc',"<cmd> '<wslPath>'"], opts)`

Writes mirror this exactly — write via stdin, mkdir/mv/rm via shelled commands, all paths sanitized, all wrapped in try/catch returning `{ ok: false, error }`.

---

## Out of Scope (Phase 2)

- **CSV editing** — stays read-only; editing structured data needs a different UX
- **Syntax-highlighted editing** for `.ts`/`.py`/`.json`/etc. — CM6 with plain text only in edit mode; view-mode keeps Prism highlighting
- **FS watcher** (chokidar / `fs.watch`) — manual refresh button covers MVP
- **Cross-tab undo/redo** — only CM6's built-in per-tab `history()`
- **Multi-file operations** — no multi-select, batch rename, drag-to-reorganize
- **Copy/paste/duplicate** in tree context menu
- **Conflict detection** — no mtime check; save overwrites. Phase 2 adds "file changed on disk" banner
- **Custom modals** — MVP uses `window.prompt`/`window.confirm`
- **Notebook editing** — already handled by embedded JupyterLab
- **Binary writes** — all write IPC assumes UTF-8 text

---

## Critical Files for Implementation

- `src/main/file-reader.ts` — pattern reference for new `file-writer.ts`
- `src/main/ipc-handlers.ts` — IPC registration
- `src/preload/index.ts` — renderer-exposed API surface
- `src/renderer/components/shared/FileContextMenu.tsx` — action wiring pattern
- `src/renderer/stores/dashboard-store.ts` — dirty state + save flow home
