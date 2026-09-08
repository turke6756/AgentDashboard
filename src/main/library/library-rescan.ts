import type { LibraryProgressEvent, LibraryRescanInitiator, LibraryRescanResult } from '../../shared/library';
import { ingestLibraryDocuments, withLibraryIngestLock, type LibraryIngestDependencies } from './library-ingest';
import { listLibraryReportSources, type LibraryReportSourcesInventory } from './library-report-sources';
import { listLibraryShelf } from './library-shelf';
import { clearLibraryDocumentAttemptsForErrorPaths, listLibraryDocumentsByRelPaths, type LibraryStore } from './library-store';

export interface RescanLibraryReportsDependencies {
  workspaceRoot: string;
  store: LibraryStore;
  publish?: (event: LibraryProgressEvent) => void;
  embedTexts?: LibraryIngestDependencies['embedTexts'];
  inventory?: LibraryReportSourcesInventory;
  initiator?: LibraryRescanInitiator;
}

export interface LibraryRetryableFailure {
  document_id: string;
  source_rel_path: string;
  attempt_count: number;
}

export interface LibraryRescanExecutionResult extends LibraryRescanResult {
  retryable_failures: LibraryRetryableFailure[];
}

export async function rescanLibraryReportsDetailed(
  deps: RescanLibraryReportsDependencies,
): Promise<LibraryRescanExecutionResult> {
  return withLibraryIngestLock(deps.workspaceRoot, async () => {
    const inventory = deps.inventory ?? await listLibraryReportSources(deps.workspaceRoot);
    const files = (['inbox', 'cleared'] as const).flatMap((root) => inventory[root].files.map((file) => ({
      file,
      relPath: `.lares/library/${root}/${file.rel_path}`,
    })));
    if (deps.initiator === 'manual') {
      clearLibraryDocumentAttemptsForErrorPaths(deps.store, files.map(({ relPath }) => relPath));
    }
    const shelf = await listLibraryShelf(deps.workspaceRoot, deps.store, { inventory });
    const byRelPath = new Map(shelf.map((row) => [row.source_rel_path, row]));
    const result: LibraryRescanExecutionResult = {
      scanned: files.length,
      ingested: 0,
      skipped: 0,
      failed: 0,
      retryable_failures: [],
    };

    for (const { file, relPath } of files) {
      const status = byRelPath.get(relPath)?.shelf_status;
      if (status !== 'pending' && status !== 'stale' && status !== 'error') {
        result.skipped += 1;
        continue;
      }
      try {
        const [ingested] = await ingestLibraryDocuments({
          workspaceRoot: deps.workspaceRoot,
          store: deps.store,
          publish: deps.publish,
          embedTexts: deps.embedTexts,
        }, [{ source_path: file.abs_path, trigger: 'rescan', initiator: deps.initiator ?? 'automatic' }]);
        if (ingested.skipped_error) result.skipped += 1;
        else result.ingested += 1;
      } catch {
        result.failed += 1;
        const row = listLibraryDocumentsByRelPaths(deps.store, [relPath])[0];
        if (row && row.attempt_count < 3) {
          result.retryable_failures.push({
            document_id: row.id,
            source_rel_path: row.source_rel_path,
            attempt_count: row.attempt_count,
          });
        }
      }
    }
    return result;
  });
}

export async function rescanLibraryReports(
  deps: RescanLibraryReportsDependencies,
): Promise<LibraryRescanResult> {
  const { scanned, ingested, skipped, failed } = await rescanLibraryReportsDetailed({
    ...deps,
    initiator: deps.initiator ?? 'manual',
  });
  return { scanned, ingested, skipped, failed };
}
