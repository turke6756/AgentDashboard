// localStorage-backed drafts for ChatInputBar, keyed by agent id.
//
// Drafts survive component unmount so the user can leave an agent / workspace
// and return to a half-typed message. To stop indefinite accumulation we time-
// stamp every write and sweep stale entries at app boot. Explicit agent
// deletion clears the draft synchronously via clearDraft().

const KEY_PREFIX = 'chat-draft:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface DraftRecord {
  v: 1;
  value: string;
  updatedAt: number;
}

const draftKey = (id: string) => `${KEY_PREFIX}${id}`;

export function loadDraft(id: string): string {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (!raw) return '';
    // Legacy plain-string entries from the first version of this feature.
    if (!raw.startsWith('{')) return raw;
    const parsed = JSON.parse(raw) as DraftRecord;
    return typeof parsed.value === 'string' ? parsed.value : '';
  } catch {
    return '';
  }
}

export function saveDraft(id: string, value: string): void {
  try {
    if (value) {
      const rec: DraftRecord = { v: 1, value, updatedAt: Date.now() };
      localStorage.setItem(draftKey(id), JSON.stringify(rec));
    } else {
      localStorage.removeItem(draftKey(id));
    }
  } catch { /* ignore */ }
}

export function clearDraft(id: string): void {
  try { localStorage.removeItem(draftKey(id)); } catch { /* ignore */ }
}

// Drop any draft whose updatedAt is older than ttlMs. Legacy entries (plain
// strings, no timestamp) are treated as fresh and rewritten with a current
// timestamp so the next sweep can age them out.
export function sweepStaleDrafts(ttlMs: number = TTL_MS): void {
  try {
    const cutoff = Date.now() - ttlMs;
    const toDelete: string[] = [];
    const toRewrite: Array<[string, string]> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      if (!raw.startsWith('{')) {
        toRewrite.push([key, raw]);
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as DraftRecord;
        if (typeof parsed.updatedAt !== 'number' || parsed.updatedAt < cutoff) {
          toDelete.push(key);
        }
      } catch {
        toDelete.push(key);
      }
    }
    for (const k of toDelete) localStorage.removeItem(k);
    const now = Date.now();
    for (const [k, value] of toRewrite) {
      localStorage.setItem(k, JSON.stringify({ v: 1, value, updatedAt: now } satisfies DraftRecord));
    }
  } catch { /* ignore */ }
}
