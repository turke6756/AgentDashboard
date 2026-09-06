export type LibraryDocumentType =
  | 'research'
  | 'md'
  | 'txt'
  | 'pdf'
  | 'docx'
  | 'note';

export type LibraryTrust = 'untrusted' | 'cleared' | 'user-trusted';
export type LibraryHighlightKind = 'exact' | 'similar';

export interface LibraryTextQuoteSelector {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface LibraryTextPosition {
  line: number;          // 1-based
  utf16_column: number;  // 0-based within the logical line
}

export interface LibraryTextSourceRange {
  start: LibraryTextPosition;
  end: LibraryTextPosition;
  canonical_char_start: number;
  canonical_char_end: number;
}

export interface LibraryPdfSourceRange {
  page_index: number;
  selector: LibraryTextQuoteSelector;
}

export type LibraryHighlightSpan = {
  id: string;
  kind: LibraryHighlightKind;
  chunk_id: string;
  source: LibraryTextSourceRange | LibraryPdfSourceRange;
};

export type LibraryChunkLocatorV1 =
  | {
      version: 1;
      kind: 'pdf';
      extraction: 'pdfium-page-text-v1';
      page_index: number;       // 0-based physical identity
      page_number: number;      // page_index + 1
      page_label?: string;      // descriptive only
      page_char_start: number;  // PDFium page-string coordinates
      page_char_end: number;
      quote: LibraryTextQuoteSelector;
    }
  | {
      version: 1;
      kind: 'text';
      encoding: 'utf-8';
      line_start: number;
      line_end: number;
      start: LibraryTextPosition;
      end: LibraryTextPosition;
      canonical_char_start: number;
      canonical_char_end: number;
      source_byte_start?: number;
      source_byte_end?: number;
      quote: LibraryTextQuoteSelector;
    }
  | {
      version: 1;
      kind: 'docx-markdown';
      conversion: 'mammoth-markdown-v1';
      derived_rel_path: string;
      line_start: number;
      line_end: number;
      start: LibraryTextPosition;
      end: LibraryTextPosition;
      canonical_char_start: number;
      canonical_char_end: number;
      derived_byte_start?: number;
      derived_byte_end?: number;
      quote: LibraryTextQuoteSelector;
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isQuote(value: unknown): value is LibraryTextQuoteSelector {
  return isObject(value)
    && typeof value.exact === 'string'
    && typeof value.prefix === 'string'
    && typeof value.suffix === 'string';
}

function isPosition(value: unknown): value is LibraryTextPosition {
  return isObject(value)
    && isPositiveInteger(value.line)
    && isNonNegativeInteger(value.utf16_column);
}

function hasOrderedRange(start: unknown, end: unknown): boolean {
  return isNonNegativeInteger(start) && isNonNegativeInteger(end) && start <= end;
}

/** Runtime guard for the persisted, versioned locator union. */
export function validateChunkLocator(value: unknown): value is LibraryChunkLocatorV1 {
  if (!isObject(value) || value.version !== 1 || !isQuote(value.quote)) return false;

  if (value.kind === 'pdf') {
    return value.extraction === 'pdfium-page-text-v1'
      && isNonNegativeInteger(value.page_index)
      && value.page_number === value.page_index + 1
      && (value.page_label === undefined || typeof value.page_label === 'string')
      && hasOrderedRange(value.page_char_start, value.page_char_end);
  }

  const commonTextRange = isPositiveInteger(value.line_start)
    && isPositiveInteger(value.line_end)
    && value.line_start <= value.line_end
    && isPosition(value.start)
    && isPosition(value.end)
    && value.start.line === value.line_start
    && value.end.line === value.line_end
    && hasOrderedRange(value.canonical_char_start, value.canonical_char_end);
  if (!commonTextRange) return false;

  if (value.kind === 'text') {
    return value.encoding === 'utf-8'
      && (value.source_byte_start === undefined || isNonNegativeInteger(value.source_byte_start))
      && (value.source_byte_end === undefined || isNonNegativeInteger(value.source_byte_end))
      && (value.source_byte_start === undefined || value.source_byte_end === undefined
        || value.source_byte_start <= value.source_byte_end);
  }

  if (value.kind === 'docx-markdown') {
    return value.conversion === 'mammoth-markdown-v1'
      && typeof value.derived_rel_path === 'string'
      && value.derived_rel_path.length > 0
      && (value.derived_byte_start === undefined || isNonNegativeInteger(value.derived_byte_start))
      && (value.derived_byte_end === undefined || isNonNegativeInteger(value.derived_byte_end))
      && (value.derived_byte_start === undefined || value.derived_byte_end === undefined
        || value.derived_byte_start <= value.derived_byte_end);
  }

  return false;
}
