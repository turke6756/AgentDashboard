import type { LibraryChunkLocatorV1, LibraryHighlightSpan, LibraryDocumentType, LibraryTrust, LibraryPdfSourceRange, LibraryTextSourceRange } from '../../../shared/library';
import { useDashboardStore, type PdfLibraryHighlight, type TabTextHighlight } from '../../stores/dashboard-store';

export interface LibraryDocumentView {
  id: string;
  type: LibraryDocumentType;
  title: string;
  created: string;
  topics_json: string;
  trust: LibraryTrust;
  source_rel_path: string;
  reader_rel_path: string;
  source_hash: string;
  page_count: number | null;
  provider: string | null;
  summary: string | null;
  status: string;
  error_reason: string | null;
}

export interface LibraryQueryExcerptView {
  chunk_id: string;
  doc_id: string;
  document_hash: string;
  title: string;
  type: LibraryDocumentType;
  trust: LibraryTrust;
  source_rel_path: string;
  reader_rel_path: string;
  quote: string;
  citation: string;
  locator: LibraryChunkLocatorV1;
}

export interface LibraryDocumentHighlightsView {
  doc_id: string;
  document_hash: string;
  spans: LibraryHighlightSpan[];
}

export function resolveWorkspaceRelativePath(root: string, relPath: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]$/, '')}${separator}${relPath.replace(/^[\\/]/, '').replace(/[\\/]/g, separator)}`;
}

export function openLibraryDocument(document: Pick<LibraryDocumentView, 'reader_rel_path'>): { ok: true } | { ok: false; error: string } {
  if (!document.reader_rel_path.trim()) return { ok: false, error: 'This item is still being added.' };
  const state = useDashboardStore.getState();
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId);
  if (!workspace) return { ok: false, error: 'Select a workspace first.' };
  state.openTab(
    resolveWorkspaceRelativePath(workspace.path, document.reader_rel_path),
    workspace.path,
    workspace.pathType,
    undefined,
    workspace.id,
  );
  return { ok: true };
}

function isPdfSource(source: LibraryHighlightSpan['source']): source is LibraryPdfSourceRange {
  return 'page_index' in source;
}

function isTextSource(source: LibraryHighlightSpan['source']): source is LibraryTextSourceRange {
  return 'start' in source;
}

export function openLibraryResult(
  excerpt: LibraryQueryExcerptView,
  documentHighlights?: LibraryDocumentHighlightsView,
  currentDocumentHash?: string,
): { ok: true } | { ok: false; error: string } {
  if (currentDocumentHash && currentDocumentHash !== excerpt.document_hash) {
    return { ok: false, error: 'Source changed; re-index and run the query again.' };
  }
  const state = useDashboardStore.getState();
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId);
  if (!workspace) return { ok: false, error: 'Select a workspace first.' };
  const nonce = Date.now();
  const spans = documentHighlights?.document_hash === excerpt.document_hash
    ? documentHighlights.spans
    : [];

  if (excerpt.locator.kind === 'pdf') {
    const highlights: PdfLibraryHighlight[] = spans
      .filter((span): span is LibraryHighlightSpan & { source: LibraryPdfSourceRange } => isPdfSource(span.source))
      .map((span) => ({
        id: span.id,
        kind: span.kind,
        pageIndex: span.source.page_index,
        selector: span.source.selector,
      }));
    state.openTab(
      resolveWorkspaceRelativePath(workspace.path, excerpt.reader_rel_path), workspace.path, workspace.pathType,
      undefined, workspace.id, undefined,
      {
        pageIndex: excerpt.locator.page_index,
        documentHash: excerpt.document_hash,
        selectedHighlightId: spans[0]?.id,
        highlights,
        nonce,
      },
    );
  } else {
    const highlights: TabTextHighlight[] = spans
      .filter((span): span is LibraryHighlightSpan & { source: LibraryTextSourceRange } => isTextSource(span.source))
      .map((span) => ({ id: span.id, kind: span.kind, start: span.source.start, end: span.source.end }));
    state.openTab(
      resolveWorkspaceRelativePath(workspace.path, excerpt.reader_rel_path), workspace.path, workspace.pathType,
      undefined, workspace.id,
      {
        lineStart: excerpt.locator.start.line,
        lineEnd: excerpt.locator.end.line,
        mode: 'source',
        reason: excerpt.citation,
        documentHash: excerpt.document_hash,
        selectedHighlightId: spans[0]?.id,
        highlights,
        nonce,
      },
    );
  }
  return { ok: true };
}
