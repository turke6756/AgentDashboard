import type { ShelfRow } from '../../../shared/library';
import type { LibraryQueryExcerptView } from './library-result-navigation';

export interface NormalizedRange {
  start: number;
  end: number;
}

export interface PreviewSegment {
  text: string;
  marked: boolean;
}

export interface LibraryResultGroup {
  document: ShelfRow;
  excerpts: LibraryQueryExcerptView[];
  bestExcerpt: LibraryQueryExcerptView;
  matchCount: number;
}

export interface GroupedLibraryResults {
  groups: LibraryResultGroup[];
  orphanDocumentIds: string[];
}

export function normalizeMatchRanges(
  ranges: ReadonlyArray<{ chunk_char_start: number; chunk_char_end: number }>,
  textLength: number,
): NormalizedRange[] {
  const valid = ranges
    .filter(({ chunk_char_start: start, chunk_char_end: end }) => (
      Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= textLength
    ))
    .map(({ chunk_char_start: start, chunk_char_end: end }) => ({ start, end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  return valid.reduce<NormalizedRange[]>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

export function buildMatchPreview(
  quote: string,
  exactRanges: ReadonlyArray<NormalizedRange>,
  targetLength = 220,
): PreviewSegment[] {
  const windowLength = Math.max(1, targetLength);
  const earliest = exactRanges[0]?.start ?? 0;
  const desiredStart = exactRanges.length > 0 ? earliest - Math.floor(windowLength / 2) : 0;
  const start = Math.max(0, Math.min(desiredStart, Math.max(0, quote.length - windowLength)));
  const end = Math.min(quote.length, start + windowLength);
  const relative = exactRanges
    .map((range) => ({ start: Math.max(range.start, start) - start, end: Math.min(range.end, end) - start }))
    .filter((range) => range.end > range.start);
  const segments: PreviewSegment[] = [];
  if (start > 0) segments.push({ text: '…', marked: false });
  let cursor = 0;
  for (const range of relative) {
    if (range.start > cursor) segments.push({ text: quote.slice(start + cursor, start + range.start), marked: false });
    segments.push({ text: quote.slice(start + range.start, start + range.end), marked: true });
    cursor = range.end;
  }
  if (cursor < end - start) segments.push({ text: quote.slice(start + cursor, end), marked: false });
  if (end < quote.length) segments.push({ text: '…', marked: false });
  return segments;
}

export function groupLibraryResults(
  documents: readonly ShelfRow[],
  excerpts: readonly LibraryQueryExcerptView[],
): GroupedLibraryResults {
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  const grouped = new Map<string, LibraryQueryExcerptView[]>();
  const orphanDocumentIds: string[] = [];
  const seenOrphans = new Set<string>();

  for (const excerpt of excerpts) {
    if (!documentsById.has(excerpt.doc_id)) {
      if (!seenOrphans.has(excerpt.doc_id)) {
        seenOrphans.add(excerpt.doc_id);
        orphanDocumentIds.push(excerpt.doc_id);
      }
      continue;
    }
    const group = grouped.get(excerpt.doc_id);
    if (group) group.push(excerpt);
    else grouped.set(excerpt.doc_id, [excerpt]);
  }

  return {
    groups: [...grouped].map(([documentId, groupExcerpts]) => ({
      document: documentsById.get(documentId)!,
      excerpts: groupExcerpts,
      bestExcerpt: groupExcerpts[0],
      matchCount: groupExcerpts.length,
    })),
    orphanDocumentIds,
  };
}
