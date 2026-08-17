// Pure research-artifact frontmatter validator — NO Electron / Node-fs imports,
// so it is a compiled-node unit-test surface (frontmatter.test.ts) AND its logic
// is mirrored verbatim into the PreToolUse hook script (RESEARCH_WRITE_GUARD_MJS,
// src/shared/constants.ts) which cannot import from dist at hook time.
//
// WP-G — Research store (plans/groupthink/browser-parity-and-research-store.md §G1).
//
// A research artifact begins with a leading `---`…`---` YAML-ish frontmatter
// block. We hand-roll the parse (NO yaml dependency): scalar `key: value` lines
// plus a `source_urls:` block list. `expectTrust` is parameterized so WP-F can
// reuse this validator for inbox→cleared promotion (expectTrust: 'cleared').

export interface ResearchFrontmatter {
  id: string;
  topic: string;
  created: string;
  source_urls: string[];
  trust: 'untrusted' | 'cleared';
  summary: string;
  provider?: 'claude' | 'codex' | 'agy';
  agent_id?: string;
  updated?: string;
  confidence?: string;
}

export type FmFailure = { ok: false; reason: string; recovered?: Partial<ResearchFrontmatter> };
export type FmResult =
  | { ok: true; frontmatter: ResearchFrontmatter }
  | FmFailure;

/** Frontmatter keys every research artifact must carry, in report order. */
export const REQUIRED_FRONTMATTER_KEYS = [
  'id', 'topic', 'created', 'source_urls', 'trust', 'summary',
] as const;

const REJECT = 'Research artifact rejected:';

function fail(reason: string): FmFailure {
  return { ok: false, reason: `${REJECT} ${reason}` };
}

/** Loose ISO-8601 shape check: YYYY-MM-DD with an optional Thh:mm[:ss[.sss]] and
 *  optional Z / ±hh:mm offset. Paired with Date.parse so a structurally-valid
 *  but nonsensical date (e.g. month 99) is still rejected. */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface ParsedResearchFrontmatter {
  scalars: Record<string, string>;
  sourceUrls: string[] | null; // null = key absent; [] = key present but empty
}

/** Hand-rolled frontmatter parse. Returns the scalar map plus the parsed
 *  source_urls block list, or null if there is no valid `---`…`---` block. */
export function parseResearchFrontmatter(fileContent: string): ParsedResearchFrontmatter | null {
  if (typeof fileContent !== 'string') return null;
  // Strip a UTF-8 BOM and normalize CRLF so the leading-fence check and the
  // line walk are newline-agnostic.
  const normalized = fileContent.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return null;

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;

  const fmLines = lines.slice(1, closeIdx);
  const scalars: Record<string, string> = {};
  let sourceUrls: string[] | null = null;

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (line.trim() === '') continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s?(.*)$/);
    if (!m) continue; // tolerate stray lines (e.g. block-list items handled below)
    const key = m[1];
    const rest = m[2];
    if (key === 'source_urls') {
      const urls: string[] = [];
      // Block-list form: subsequent indented `- <url>` lines.
      let j = i + 1;
      for (; j < fmLines.length; j++) {
        const item = fmLines[j].match(/^\s*-\s+(.*\S)\s*$/);
        if (!item) break;
        urls.push(item[1].trim());
      }
      i = j - 1;
      sourceUrls = urls;
      continue;
    }
    scalars[key] = rest.trim();
  }

  return { scalars, sourceUrls };
}

/** Best-effort recognized fields for degraded cards. Validation remains the
 * authority for whether the returned values form a research report. */
export function recoverResearchFrontmatter(
  parsed: ParsedResearchFrontmatter | null,
): Partial<ResearchFrontmatter> | undefined {
  if (!parsed) return undefined;
  const recovered: Partial<ResearchFrontmatter> = {};
  const scalarKeys = ['id', 'topic', 'created', 'summary', 'agent_id', 'updated', 'confidence'] as const;
  for (const key of scalarKeys) {
    if (parsed.scalars[key]) recovered[key] = parsed.scalars[key];
  }
  const provider = parsed.scalars.provider;
  if (provider === 'claude' || provider === 'codex' || provider === 'agy') {
    recovered.provider = provider;
  }
  const trust = parsed.scalars.trust;
  if (trust === 'untrusted' || trust === 'cleared') recovered.trust = trust;
  if (parsed.sourceUrls !== null) recovered.source_urls = parsed.sourceUrls;
  return Object.keys(recovered).length > 0 ? recovered : undefined;
}

/** Validate a research artifact's leading frontmatter block. Every failure
 *  returns a single self-correctable reason string so the writing agent (or the
 *  PreToolUse hook) can fix the artifact without further guidance. */
export function validateResearchFrontmatter(
  fileContent: string,
  opts: { expectTrust: 'untrusted' | 'cleared' },
): FmResult {
  const parsed = parseResearchFrontmatter(fileContent);
  if (parsed === null) {
    return fail('missing leading --- frontmatter block');
  }
  const recovered = recoverResearchFrontmatter(parsed);
  const reject = (reason: string): FmResult => ({ ...fail(reason), recovered });

  // 1. Required keys present (source_urls presence is tracked separately).
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (key === 'source_urls') {
      if (parsed.sourceUrls === null) return reject(`missing frontmatter key: source_urls`);
      continue;
    }
    if (!(key in parsed.scalars) || parsed.scalars[key] === '') {
      return reject(`missing frontmatter key: ${key}`);
    }
  }

  // 2. source_urls — non-empty list of http(s) URLs.
  const urls = parsed.sourceUrls ?? [];
  if (urls.length === 0 || !urls.every((u) => /^https?:\/\/\S+/i.test(u))) {
    return reject('source_urls must be a non-empty list of http(s) URLs');
  }

  // 3. created — parseable ISO-8601.
  const created = parsed.scalars['created'];
  if (!ISO_8601_RE.test(created) || Number.isNaN(Date.parse(created))) {
    return reject('created must be an ISO-8601 timestamp (e.g. 2026-06-14T12:00:00Z)');
  }

  // 4. trust — must equal the expected tier for this store location.
  const trust = parsed.scalars['trust'];
  if (trust !== opts.expectTrust) {
    if (opts.expectTrust === 'untrusted' && trust === 'cleared') {
      return reject(
        'only the review gate (WP-F) may set trust: cleared; use trust: untrusted in inbox/',
      );
    }
    return reject(`trust must be "${opts.expectTrust}" (got "${trust}")`);
  }

  const provider = parsed.scalars.provider;
  if (provider !== undefined && provider !== 'claude' && provider !== 'codex' && provider !== 'agy') {
    return reject('provider must be one of "claude", "codex", or "agy"');
  }

  return {
    ok: true,
    frontmatter: {
      id: parsed.scalars.id,
      topic: parsed.scalars.topic,
      created,
      source_urls: urls,
      trust: trust as ResearchFrontmatter['trust'],
      summary: parsed.scalars.summary,
      ...(provider ? { provider: provider as NonNullable<ResearchFrontmatter['provider']> } : {}),
      ...(parsed.scalars.agent_id ? { agent_id: parsed.scalars.agent_id } : {}),
      ...(parsed.scalars.updated ? { updated: parsed.scalars.updated } : {}),
      ...(parsed.scalars.confidence ? { confidence: parsed.scalars.confidence } : {}),
    },
  };
}
