import type { LibraryProgressEvent, LibraryRescanResult } from '../../shared/library';
import { ingestLibraryDocuments, withLibraryIngestLock, type LibraryIngestDependencies } from './library-ingest';
import { listLibraryReportSources, type LibraryReportSourcesInventory } from './library-report-sources';
import { listLibraryShelf } from './library-shelf';
import type { LibraryStore } from './library-store';

export interface RescanLibraryReportsDependencies {
  workspaceRoot: string;
  store: LibraryStore;
  publish?: (event: LibraryProgressEvent) => void;
  embedTexts?: LibraryIngestDependencies['embedTexts'];
  inventory?: LibraryReportSourcesInventory;
}

export async function rescanLibraryReports(
  deps: RescanLibraryReportsDependencies,
): Promise<LibraryRescanResult> {
  return withLibraryIngestLock(deps.workspaceRoot, async () => {
    const inventory = deps.inventory ?? await listLibraryReportSources(deps.workspaceRoot);
    const shelf = await listLibraryShelf(deps.workspaceRoot, deps.store, { inventory });
    const byRelPath = new Map(shelf.map((row) => [row.source_rel_path, row]));
    const files = (['inbox', 'cleared'] as const).flatMap((root) => inventory[root].files.map((file) => ({
      file,
      relPath: `.lares/library/${root}/${file.rel_path}`,
    })));
    const result: LibraryRescanResult = { scanned: files.length, ingested: 0, skipped: 0, failed: 0 };

    for (const { file, relPath } of files) {
      const status = byRelPath.get(relPath)?.shelf_status;
      if (status !== 'pending' && status !== 'stale') {
        result.skipped += 1;
        continue;
      }
      try {
        await ingestLibraryDocuments({
          workspaceRoot: deps.workspaceRoot,
          store: deps.store,
          publish: deps.publish,
          embedTexts: deps.embedTexts,
        }, [{ source_path: file.abs_path, trigger: 'rescan' }]);
        result.ingested += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  });
}
