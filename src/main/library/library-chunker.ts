import { createHash } from 'crypto';
import { getEncoding } from 'js-tiktoken';
import { ANCHOR_CONTEXT_CHARS } from '../../shared/anchor-constants';
import type {
  LibraryChunkLocatorV1,
  LibraryTextPosition,
  LibraryTextQuoteSelector,
} from '../../shared/library';

export const CHUNKER_VERSION = 'paragraph-window-v1';
export const TOKENIZER_VERSION = 'cl100k_base-js-tiktoken-1.0.21';
export const CHUNK_TARGET_TOKENS = 350;
export const CHUNK_MAX_TOKENS = 400;
export const CHUNK_OVERLAP_TOKENS = 52;

const tokenizer = getEncoding('cl100k_base');

export interface CanonicalText {
  text: string;
  positionAt(offset: number): LibraryTextPosition;
  byteAt?(offset: number): number;
}

export interface ChunkDocumentInput {
  document_id: string;
  source_hash: string;
  kind: 'text' | 'docx-markdown' | 'pdf';
  text?: string;
  pages?: Array<{ page_index: number; text: string; page_label?: string }>;
  derived_rel_path?: string;
  include_byte_map?: boolean;
}

export interface LibraryChunk {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  content_char_length: number;
  locator: LibraryChunkLocatorV1;
}

export function canonicalizeText(source: string, includeByteMap = false): CanonicalText {
  const text = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const byteMap = includeByteMap ? new Array<number>(text.length + 1) : undefined;
  if (byteMap) {
    for (let i = 0; i <= text.length; i += 1) byteMap[i] = Buffer.byteLength(text.slice(0, i), 'utf8');
  }
  return {
    text,
    positionAt(offset) {
      const bounded = Math.max(0, Math.min(offset, text.length));
      let lo = 0;
      let hi = lineStarts.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if (lineStarts[mid] <= bounded) lo = mid;
        else hi = mid;
      }
      return { line: lo + 1, utf16_column: bounded - lineStarts[lo] };
    },
    ...(byteMap ? { byteAt: (offset: number) => byteMap[Math.max(0, Math.min(offset, text.length))] } : {}),
  };
}

export function makeTextQuoteSelector(text: string, start: number, end: number): LibraryTextQuoteSelector {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + ANCHOR_CONTEXT_CHARS)),
  };
}

export function deriveChunkId(documentId: string, sourceHash: string, ordinal: number): string {
  return createHash('sha256').update(
    `library-chunk\0${CHUNKER_VERSION}\0${TOKENIZER_VERSION}\0${documentId}\0${sourceHash}\0${ordinal}`,
  ).digest('hex');
}

function tokenCount(text: string): number {
  return tokenizer.encode(text).length;
}

function safeCharBoundary(text: string, offset: number): number {
  if (offset > 0 && offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code >= 0xdc00 && code <= 0xdfff) return offset - 1;
  }
  return offset;
}

function furthestWithin(text: string, start: number, maxTokens: number): number {
  let lo = Math.min(text.length, start + 1);
  let hi = text.length;
  let best = lo;
  while (lo <= hi) {
    const mid = safeCharBoundary(text, (lo + hi) >>> 1);
    const count = tokenCount(text.slice(start, mid));
    if (count <= maxTokens) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return Math.max(start + 1, safeCharBoundary(text, best));
}

function preferredEnd(text: string, start: number): number {
  const hard = furthestWithin(text, start, CHUNK_MAX_TOKENS);
  if (hard >= text.length || tokenCount(text.slice(start, hard)) <= CHUNK_TARGET_TOKENS) return hard;
  const target = furthestWithin(text, start, CHUNK_TARGET_TOKENS);
  const before = text.slice(start, target);
  const paragraph = Math.max(before.lastIndexOf('\n\n') + 2, 0);
  if (paragraph > 0) return start + paragraph;
  const sentence = Math.max(before.lastIndexOf('. ') + 2, before.lastIndexOf('! ') + 2, before.lastIndexOf('? ') + 2);
  if (sentence > 1) return start + sentence;
  return target;
}

function overlapStart(text: string, priorStart: number, end: number): number {
  let lo = priorStart;
  let hi = end;
  let best = end;
  while (lo <= hi) {
    const mid = safeCharBoundary(text, (lo + hi) >>> 1);
    if (tokenCount(text.slice(mid, end)) <= CHUNK_OVERLAP_TOKENS) { best = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return best;
}

function rangesFor(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < text.length) {
    const end = preferredEnd(text, start);
    ranges.push([start, end]);
    if (end === text.length) break;
    const next = overlapStart(text, start, end);
    start = next > start ? next : end;
  }
  return ranges;
}

export function chunkDocument(input: ChunkDocumentInput): LibraryChunk[] {
  const chunks: LibraryChunk[] = [];
  const push = (content: string, locator: LibraryChunkLocatorV1) => {
    const ordinal = chunks.length;
    chunks.push({
      id: deriveChunkId(input.document_id, input.source_hash, ordinal),
      document_id: input.document_id,
      ordinal,
      content,
      content_char_length: content.length,
      locator,
    });
  };

  if (input.kind === 'pdf') {
    for (const page of input.pages ?? []) {
      const canonical = canonicalizeText(page.text);
      for (const [start, end] of rangesFor(canonical.text)) {
        push(canonical.text.slice(start, end), {
          version: 1,
          kind: 'pdf',
          extraction: 'pdfium-page-text-v1',
          page_index: page.page_index,
          page_number: page.page_index + 1,
          ...(page.page_label ? { page_label: page.page_label } : {}),
          page_char_start: start,
          page_char_end: end,
          quote: makeTextQuoteSelector(canonical.text, start, end),
        });
      }
    }
    return chunks;
  }

  const canonical = canonicalizeText(input.text ?? '', input.include_byte_map);
  for (const [start, end] of rangesFor(canonical.text)) {
    const startPos = canonical.positionAt(start);
    const endPos = canonical.positionAt(end);
    const common = {
      version: 1 as const,
      line_start: startPos.line,
      line_end: endPos.line,
      start: startPos,
      end: endPos,
      canonical_char_start: start,
      canonical_char_end: end,
      quote: makeTextQuoteSelector(canonical.text, start, end),
    };
    const locator: LibraryChunkLocatorV1 = input.kind === 'docx-markdown'
      ? {
          ...common,
          kind: 'docx-markdown',
          conversion: 'mammoth-markdown-v1',
          derived_rel_path: input.derived_rel_path ?? '',
          ...(canonical.byteAt ? { derived_byte_start: canonical.byteAt(start), derived_byte_end: canonical.byteAt(end) } : {}),
        }
      : {
          ...common,
          kind: 'text',
          encoding: 'utf-8',
          ...(canonical.byteAt ? { source_byte_start: canonical.byteAt(start), source_byte_end: canonical.byteAt(end) } : {}),
        };
    push(canonical.text.slice(start, end), locator);
  }
  return chunks;
}
