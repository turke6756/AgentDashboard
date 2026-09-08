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
  keyword_matches?: Array<{ kind: 'exact'; chunk_char_start: number; chunk_char_end: number; text: string }>;
  similar_passage?: { kind: 'similar'; chunk_char_start: number; chunk_char_end: number } | null;
  scores?: { keyword_rank: number | null; semantic_rank: number | null; semantic_score: number | null; fused_score: number };
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

function validSpans(spans: readonly LibraryHighlightSpan[]): LibraryHighlightSpan[] {
  return spans.filter((span) => {
    if (isPdfSource(span.source)) return Number.isInteger(span.source.page_index) && span.source.page_index >= 0 && Boolean(span.source.selector.exact);
    return Number.isInteger(span.source.start.line) && Number.isInteger(span.source.end.line)
      && span.source.start.line > 0 && span.source.end.line >= span.source.start.line
      && span.source.start.utf16_column >= 0 && span.source.end.utf16_column >= 0;
  });
}

function chooseFocusSpan(spans: readonly LibraryHighlightSpan[]): LibraryHighlightSpan | undefined {
  return [...spans].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'exact' ? -1 : 1;
    if (isPdfSource(left.source) && isPdfSource(right.source)) return left.source.page_index - right.source.page_index;
    if (isTextSource(left.source) && isTextSource(right.source)) {
      return left.source.canonical_char_start - right.source.canonical_char_start;
    }
    return isTextSource(left.source) ? -1 : 1;
  })[0];
}

let lastFocusNonce = 0;

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
  const nonce = Math.max(Date.now(), lastFocusNonce + 1);
  lastFocusNonce = nonce;
  const spans = documentHighlights?.document_hash === excerpt.document_hash
    ? validSpans(documentHighlights.spans)
    : [];
  const chosen = chooseFocusSpan(spans);

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
        pageIndex: chosen && isPdfSource(chosen.source) ? chosen.source.page_index : excerpt.locator.page_index,
        documentHash: excerpt.document_hash,
        selectedHighlightId: chosen?.id,
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
        lineStart: chosen && isTextSource(chosen.source) ? chosen.source.start.line : excerpt.locator.start.line,
        lineEnd: chosen && isTextSource(chosen.source) ? chosen.source.end.line : excerpt.locator.end.line,
        mode: 'source',
        reason: excerpt.citation,
        documentHash: excerpt.document_hash,
        selectedHighlightId: chosen?.id,
        highlights,
        nonce,
      },
    );
  }
  return { ok: true };
}
