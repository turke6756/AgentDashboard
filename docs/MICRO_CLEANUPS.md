# Micro-Cleanups

A running ledger of small, well-scoped cleanups identified across the codebase. Each entry has concrete evidence (file paths, counts) and an explicit ROI judgment so we can pick them off in priority order without guessing.

Conventions:
- **Status**: `open`, `in-progress`, `done`, `deferred`.
- **ROI**: `high` (prevents bugs we've already seen, or unblocks a downstream change), `medium` (real duplication), `low` (cosmetic).
- **Size**: rough effort. `XS` = minutes, `S` = under an hour, `M` = an afternoon, `L` = a day+.

---

## Assessment (2026-04-25)

Overall: agree with the priority and direction. Best order is #1, then #2, then #3. Keep #4 and #6 deferred; measure #5 before spending a full cleanup pass on it.

- **#1 provider fallback:** valid and worth doing now. Prefer a validator-style helper, e.g. `normalizeProvider(value: unknown): AgentProvider`, instead of only `getProvider(agent)`. That catches stale DB/API strings before they index `PROVIDER_META` or `PROVIDER_COMMANDS`.
- **#2 directory cache hook:** valid. The duplication is real between `DirectoryTree.tsx` and `Sidebar.tsx`. The hook should preserve the current refresh/remount behavior from `DirectoryTree` (`refreshTick`/cache clear), not just expose `rootEntries`, `loading`, `reloadRoot`, `invalidateDir`, and `loadChildren`.
- **#3 file operations hook:** valid, but design it around a target directory/entry per operation so root actions and nested-node actions do not get blurred together.
- **#4 themed dialogs:** still correctly deferred until #3 centralizes the operation call sites.
- **#5 lazy-loaded viewers:** direction is valid. Verified `npm run build:renderer` still warns with the main renderer chunk at `4,417.07 kB` (`1,250.22 kB` gzip). `FileContentRenderer` eagerly imports Geo/PDF/notebook/code renderers, so lazy loading is a plausible win. Caveat: `katex` is installed but not currently imported by renderer code, so do not count it as a proven contributor.
- **#6 structured logger:** correctly deferred. The 135 console calls are real, but replacing them needs a logging/product decision, not a string-replace cleanup.

Current caveats:
- The "renderer typecheck swept clean" note below is stale in this worktree. `npx tsc -p tsconfig.json --noEmit` currently fails in `src/renderer/hooks/useYNotebook.ts`.
- The TODO/FIXME note is stale in this worktree. No `TODO` or `FIXME` markers were found under `src`.

---

## 1. Centralize the `provider || 'claude'` fallback

**Status:** open
**ROI:** high
**Size:** XS

12 sites duplicate `agent.provider || 'claude'` across 7 files. The `||` widens `AgentProvider | undefined` to `string`, which already broke the build at `DetailPanel.tsx:67` when used to index `Record<AgentProvider, …>` (since patched with a cast). Every other site is quietly waiting for the same widening to bite.

**Sites:**
- `src/main/api-server.ts:294`
- `src/main/database.ts:259, 353, 432, 448`
- `src/main/supervisor/index.ts:483`
- `src/renderer/components/agent/AgentCard.tsx:183, 232, 314, 370, 373`
- `src/renderer/components/layout/DetailPanel.tsx:67`

**Proposed fix:** add `getProvider(agent: { provider?: AgentProvider | string | null }): AgentProvider` to `src/shared/constants.ts` (next to `PROVIDER_META`). Replace all 12 sites.

**Why now:** the bug already shipped once. Centralizing closes it for good and removes a class of TS widening footgun.

---

## 2. Extract `useDirectoryCache(rootPath, pathType)` hook

**Status:** open
**ROI:** high
**Size:** S

`src/renderer/components/layout/Sidebar.tsx` (`InlineWorkspaceTree`) and `src/renderer/components/fileviewer/DirectoryTree.tsx` independently implement the same directory cache: a `useRef(new Map())`, a root-load `useEffect`, a `loadChildren` function, a `reloadRoot`, and an `invalidateDir`. Both pass the same callbacks into `<DirectoryTreeNode>`.

This duplication is exactly what produced the recent file-viewer wiring bug: `DirectoryTreeNode` grew new required props (`onTreeChanged`, `onSiblingsChanged`), and only `DirectoryTree.tsx` got updated. `Sidebar.tsx` drifted and broke the build.

**Proposed fix:** extract a hook in `src/renderer/components/fileviewer/useDirectoryCache.ts`:

```ts
function useDirectoryCache(rootPath: string, pathType: PathType) {
  // returns { rootEntries, loading, reloadRoot, invalidateDir, loadChildren }
}
```

Both call sites collapse to a few lines, and the contract for `<DirectoryTreeNode>` lives in one place.

**Why now:** prevents the next round of the same drift bug.

---

## 3. Extract `useFileOperations(rootPath, pathType)` hook

**Status:** open
**ROI:** high
**Size:** S

`DirectoryTree.tsx` and `DirectoryTreeNode.tsx` both implement `createFile`, `createFolder`, `rename`, `delete`. Same shape every time:

```ts
const rawName = window.prompt(...);
if (rawName === null) return;
const result = await window.api.files.X(...);
if (!result.ok) {
  window.alert(result.error);
  return;
}
await reloadSomething();
```

Counted: 7 `if (!result.ok) window.alert(...)` sites across these two files alone.

**Proposed fix:** extract `useFileOperations(rootPath, pathType, { onTreeChanged, onSiblingsChanged })` returning `{ createFile, createFolder, rename, deleteEntry }`. Both files lose ~80 lines of repeated logic.

**Why now:** dovetails with cleanup #4 — once the operations live in one place, replacing the native dialogs with themed ones becomes a single edit instead of seven.

---

## 4. Replace `window.prompt` / `window.alert` / `window.confirm` with themed modals

**Status:** deferred (pending #3)
**ROI:** medium
**Size:** M

16+ native browser dialog calls across the file-editing slice. Native dialogs are jarring in an Electron context — they break theme, get clipped on Windows, can't render rich content, and steal focus in ways the rest of the UI doesn't.

**Sites:**
- `DirectoryTree.tsx:42, 49, 57, 63`
- `DirectoryTreeNode.tsx:119, 125, 135, 141, 150, 153, 159, 171, 172, 174, 179`

**Proposed fix:** build promise-returning primitives `confirmDialog()`, `promptDialog()`, `alertDialog()` backed by a themed modal portal. Then rewrite call sites.

**Why deferred:** the call-site replacement is mechanical, but *building* the modal primitives is real work — not a true micro-cleanup. After cleanup #3 lands, the call-site count drops to ~4 and this becomes much cheaper.

---

## 5. Lazy-load heavy file viewers

**Status:** open
**ROI:** medium (perf, not correctness)
**Size:** M

Vite reports a 4.28 MB main JS chunk (1.21 MB gzipped) and warns about it on every build. Likely culprits, all currently eager imports:
- `leaflet` + `react-pdf` (rendering)
- `geotiff` + `sql.js` (geo viewers)
- `lowlight` + `react-syntax-highlighter` (code viewer)
- `katex` (notebook math)

Each is only used by a specific viewer. Cold-start cost falls a lot if they're behind `React.lazy` or dynamic `import()` per renderer.

**Why open, not high-priority:** real perf win on app launch, but not blocking any feature. Defer until cold-start latency actually annoys you.

---

## 6. Structured logger

**Status:** deferred
**ROI:** low (until we need it)
**Size:** L (design + migration)

135 `console.{log,error,warn}` calls across 21 files. There's no consistent format, no log levels, and main-process logs land in whatever terminal Electron was launched from — invisible if the app was double-clicked.

**Why deferred:** a real logger is a design choice (file output? log viewer panel? per-agent vs per-system?), not a string-replace job. Worth doing alongside any "operational provenance" or attention-queue work since both want structured events anyway. Not now.

---

## Won't-do (noted, skipped)

- **`as any` audit.** Only 12 across 5 renderer files, almost all in canvas/geo code where upstream lib types are genuinely thin (`geotiff`, `shpjs`). Each one is a deliberate concession, not debt.
- **TODO/FIXME sweep.** Exactly 1 marker in the whole codebase (`GeoPackageRenderer.tsx`). Healthy.

---

## Recently closed

- **2026-04-24** — `Sidebar.tsx` was missing `onTreeChanged` / `onSiblingsChanged` on `<DirectoryTreeNode>`. Patched directly. (Motivates cleanup #2.)
- **2026-04-24** — Renderer typecheck swept clean: GeoPackage non-null narrowing, GeoTiff library type gaps cast through `any`, DetailPanel provider widening cast, Vite ambient types added via `src/renderer/vite-env.d.ts`.
