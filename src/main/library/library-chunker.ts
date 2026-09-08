import { createHash } from 'crypto';
import { getEncoding } from 'js-tiktoken';
import { ANCHOR_CONTEXT_CHARS } from '../../shared/anchor-constants';
import type {
  LibraryChunkLocatorV1,
  LibraryTextPosition,
  LibraryTextQuoteSelector,
} from '../../shared/library';

export const CHUNKER_VERSION = 'paragraph-window-v2';
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

/**
 * One unit of chunk placement: a run of non-whitespace together with the
 * whitespace that precedes it (`/\s*\S+/`), or a trailing whitespace-only tail.
 *
 * Attaching the LEADING whitespace mirrors cl100k's own pre-tokenizer, which
 * glues a leading space onto the following word (" world" is one token). That
 * keeps the per-atom token count an accurate, slightly pessimistic estimate of
 * the count cl100k would produce for the same span, so we can place every
 * boundary from cumulative sums without re-tokenizing the document per probe.
 *
 * `\S+` never splits a surrogate pair, so atom edges are always safe char
 * boundaries. Chunk content starts at `textStart` (after the leading
 * whitespace) and ends at the next atom's `start`, so inter-chunk whitespace
 * belongs to neither chunk and paragraph breaks land exactly between atoms.
 */
interface Atom {
  start: number;      // first char of the atom (leading whitespace included)
  textStart: number;  // first non-whitespace char
  end: number;        // exclusive
  tokens: number;     // cl100k count of text.slice(start, end)
  paragraphBreak: boolean; // leading whitespace contains a blank line
  sentenceEnd: boolean;    // preceding atom ended a sentence and this one follows whitespace
}

const ATOM = /\s*\S+|\s+$/g;
const SENTENCE_END = /[.!?]$/;

function atomize(text: string): Atom[] {
  const atoms: Atom[] = [];
  let previousWord = '';
  for (const match of text.matchAll(ATOM)) {
    const start = match.index ?? 0;
    const piece = match[0];
    const end = start + piece.length;
    const leadLength = piece.length - piece.trimStart().length;
    const lead = piece.slice(0, leadLength);
    const word = piece.slice(leadLength);
    atoms.push({
      start,
      textStart: start + leadLength,
      end,
      tokens: tokenCount(piece),
      paragraphBreak: lead.includes('\n\n'),
      sentenceEnd: leadLength > 0 && SENTENCE_END.test(previousWord),
    });
    previousWord = word;
  }
  return atoms;
}

/** Prefix sums so any atom span's token estimate is one subtraction. */
function prefixTokens(atoms: Atom[]): number[] {
  const prefix = new Array<number>(atoms.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < atoms.length; i += 1) prefix[i + 1] = prefix[i] + atoms[i].tokens;
  return prefix;
}

/** Largest atom index `e > s` with estimate(atoms[s..e)) <= maxTokens. */
function furthestWithin(prefix: number[], s: number, maxTokens: number): number {
  let e = s + 1;
  while (e < prefix.length - 1 && prefix[e + 1] - prefix[s] <= maxTokens) e += 1;
  return e;
}

/** Where to end the chunk that starts at atom `s`; mirrors paragraph-window-v1's preferences. */
function preferredEnd(atoms: Atom[], prefix: number[], s: number): number {
  const hard = furthestWithin(prefix, s, CHUNK_MAX_TOKENS);
  if (hard >= atoms.length || prefix[hard] - prefix[s] <= CHUNK_TARGET_TOKENS) return hard;
  const target = furthestWithin(prefix, s, CHUNK_TARGET_TOKENS);
  for (let k = target; k > s + 1; k -= 1) if (atoms[k].paragraphBreak) return k;
  for (let k = target; k > s + 1; k -= 1) if (atoms[k].sentenceEnd) return k;
  return target;
}

/** Smallest atom index in (s, e] whose tail up to `e` fits the overlap budget. */
function overlapStart(prefix: number[], s: number, e: number): number {
  let m = e;
  while (m > s + 1 && prefix[e] - prefix[m - 1] <= CHUNK_OVERLAP_TOKENS) m -= 1;
  return m;
}

/** Shrink `[s, e)` by whole atoms until cl100k agrees it fits CHUNK_MAX_TOKENS. */
function enforceMax(text: string, atoms: Atom[], s: number, e: number): number {
  while (e > s + 1 && tokenCount(text.slice(atoms[s].textStart, atoms[e - 1].end)) > CHUNK_MAX_TOKENS) e -= 1;
  return e;
}

/**
 * Chunk ranges as `[charStart, charEnd)` pairs over canonical text.
 *
 * Linear in document length: the document is tokenized once, atom by atom,
 * and every boundary decision is a prefix-sum lookup plus one confirming
 * `encode` of the finished chunk. (v1 re-tokenized up to the whole remaining
 * document ~50 times per chunk, which froze the main process for minutes on a
 * 50 KB report.)
 */
function rangesFor(text: string): Array<[number, number]> {
  const atoms = atomize(text);
  const prefix = prefixTokens(atoms);
  const ranges: Array<[number, number]> = [];
  let s = 0;
  while (s < atoms.length) {
    if (atoms[s].textStart >= atoms[s].end) break; // whitespace-only tail
    const e = enforceMax(text, atoms, s, preferredEnd(atoms, prefix, s));
    ranges.push([atoms[s].textStart, atoms[e - 1].end]);
    if (e >= atoms.length) break;
    const next = overlapStart(prefix, s, e);
    s = next > s ? next : e;
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
