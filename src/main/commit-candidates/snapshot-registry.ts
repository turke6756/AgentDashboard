// WP-G — Canonical per-repository snapshot single-flight registry.
//
// The two production Save surfaces run behind TWO SEPARATE `CommitCandidateService`
// instances (`createSaveCardRoutes` and `createPreviewRoutes`), so per-service
// coalescing is provably insufficient — a concurrent save-card + preview would run
// the causal OOM work (dirty inventory + checkpoint-membership protection) twice.
// This registry is the ONE object both route constructors share (composed once in
// `src/main/index.ts`); it coalesces inventory + protection as a single consistency
// unit so exactly one canonical computation runs per `repositoryKey`.
//
// Ruling (deliberation §7), enforced here:
//   • Exactly one active computation per `repositoryKey`.
//   • Canonical input identity is `repositoryKey + policyGeneration`; workspace-scope
//     prefixes are NOT flight keys — consumers PROJECT their scopes from the one
//     canonical repository result.
//   • A request at a differing `policyGeneration` waits for the current flight to
//     settle, then starts fresh — NEVER concurrent.
//   • Scoped recovery rescans use the same per-`repositoryKey` admission queue, so
//     they cannot overlap the canonical scan.
//   • In-flight promise cleared in `finally`; failed/cancelled results are NEVER
//     cached; one waiter cancelling does not cancel shared work unless no waiters
//     remain; the settled cache is an 8-repository LRU + 500 ms TTL, invalidated on
//     checkpoint / finalization / policy writes.
//   • Mint/finalize keep their existing freshness verification and NEVER trust
//     cached presentation state — they bypass this registry entirely (only the
//     read/preview surfaces route through it).

/** Canonical flight identity. Workspace scope is deliberately absent: it is a
 *  projection of the one canonical result, never part of the flight key. */
export interface SnapshotFlightKey {
  readonly repositoryKey: string;
  readonly policyGeneration: number;
}

/** The expensive canonical computation (inventory + protection). Receives the
 *  shared flight's `AbortSignal`, which aborts only when EVERY waiter has left. */
export type SnapshotComputation<T> = (signal: AbortSignal) => Promise<T>;

export interface SnapshotAcquireOptions {
  /** A per-waiter cancellation signal. Aborting it rejects THIS caller's acquire
   *  and drops it from the shared flight's waiter set; the shared computation keeps
   *  running for the remaining waiters and is aborted only once none remain. */
  readonly signal?: AbortSignal;
}

export interface SnapshotRegistryOptions {
  /** Injectable clock (epoch ms) so TTL behavior is deterministic under test. */
  now?: () => number;
  /** Settled-cache freshness window. Default 500 ms per the ruling. */
  ttlMs?: number;
  /** Settled-cache repository cap (LRU). Default 8 per the ruling. */
  maxRepositories?: number;
}

interface Flight<T> {
  readonly policyGeneration: number;
  readonly controller: AbortController;
  /** The shared computation result every same-generation waiter observes.
   *  Assigned immediately after construction (it must close over this flight). */
  shared: Promise<T>;
  /** The INTERNAL settle promise — resolves only AFTER the `finally` that clears
   *  this flight from the active map, so a differing-generation waiter that awaits
   *  it always observes a freed slot before it re-acquires. Never rejects. */
  readonly settle: Promise<void>;
  waiterCount: number;
  /** Set when `invalidate` fires mid-flight, so a stale result never repopulates
   *  the settled cache after an authoritative write. */
  stale: boolean;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly policyGeneration: number;
  readonly storedAt: number;
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Snapshot acquisition was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Per-`repositoryKey` single-flight coordinator with a bounded settled cache.
 * Generic over the canonical snapshot type `T`; a registry instance must be
 * composed with ONE snapshot shape (production uses `CandidateInventoryRead`).
 */
export class CommitCandidateSnapshotRegistry<T> {
  private readonly flights = new Map<string, Flight<T>>();
  /** Insertion-ordered LRU: least-recently-used first, most-recent last. */
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRepositories: number;

  constructor(options: SnapshotRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 500;
    this.maxRepositories = options.maxRepositories ?? 8;
  }

  /**
   * Acquire the canonical repository snapshot, coalescing concurrent callers.
   * A same-generation request joins the active flight; a differing-generation
   * request waits for it to settle then starts fresh; a cache hit inside the TTL
   * returns immediately without recomputation.
   */
  acquire(
    key: SnapshotFlightKey,
    compute: SnapshotComputation<T>,
    options: SnapshotAcquireOptions = {},
  ): Promise<T> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const cached = this.readFreshCache(key);
    if (cached !== null) return Promise.resolve(cached);

    const active = this.flights.get(key.repositoryKey);
    if (active) {
      if (active.policyGeneration === key.policyGeneration) {
        return this.join(active, signal);
      }
      // Differing generation: never concurrent. Wait for the active flight to fully
      // settle (its `finally` frees the slot before `settle` resolves), then retry.
      return active.settle.then(() => this.acquire(key, compute, options));
    }

    return this.startFlight(key, compute, signal);
  }

  /** Drop the settled cache for a repository and prevent any in-flight result from
   *  repopulating it. Called on checkpoint / finalization / policy writes. */
  invalidate(repositoryKey: string): void {
    this.cache.delete(repositoryKey);
    const active = this.flights.get(repositoryKey);
    if (active) active.stale = true;
  }

  /** Test/introspection: whether a fresh settled entry exists for a repository. */
  hasCached(key: SnapshotFlightKey): boolean {
    return this.readFreshCache(key) !== null;
  }

  private startFlight(
    key: SnapshotFlightKey,
    compute: SnapshotComputation<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const controller = new AbortController();
    let resolveSettle!: () => void;
    const settle = new Promise<void>((resolve) => { resolveSettle = resolve; });
    const flight: Flight<T> = {
      policyGeneration: key.policyGeneration,
      controller,
      shared: Promise.resolve() as Promise<T>, // real value assigned immediately below
      settle,
      waiterCount: 0,
      stale: false,
    };

    // The shared work. Cache ONLY on clean success of a still-relevant flight;
    // a throw, an abort (no waiters remained), or an intervening invalidate all
    // leave the settled cache untouched. The active-map slot is always freed in
    // `finally`, and `settle` resolves only after that runs.
    flight.shared = (async (): Promise<T> => {
      try {
        const value = await compute(controller.signal);
        if (!controller.signal.aborted && !flight.stale) this.storeCache(key, value);
        return value;
      } finally {
        if (this.flights.get(key.repositoryKey) === flight) {
          this.flights.delete(key.repositoryKey);
        }
        resolveSettle();
      }
    })();
    // A differing-generation waiter awaits `settle`, never `shared`, so it is never
    // rejected by the prior flight's error. Swallow `shared`'s own rejection here so
    // an unobserved-rejection warning cannot fire before a waiter attaches.
    flight.shared.catch(() => undefined);

    this.flights.set(key.repositoryKey, flight);
    return this.join(flight, signal);
  }

  private join(flight: Flight<T>, signal: AbortSignal | undefined): Promise<T> {
    const shared = flight.shared;
    flight.waiterCount += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (done) return;
        done = true;
        flight.waiterCount -= 1;
        // Cancel the shared work only when this was the last interested waiter.
        if (flight.waiterCount <= 0) flight.controller.abort(abortError(signal));
        cleanup();
        reject(abortError(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort);
      shared.then(
        (value) => {
          if (done) return;
          done = true;
          flight.waiterCount -= 1;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (done) return;
          done = true;
          flight.waiterCount -= 1;
          cleanup();
          reject(error);
        },
      );
    });
  }

  private readFreshCache(key: SnapshotFlightKey): T | null {
    const entry = this.cache.get(key.repositoryKey);
    if (!entry) return null;
    if (entry.policyGeneration !== key.policyGeneration) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.cache.delete(key.repositoryKey);
      return null;
    }
    // Refresh recency (LRU): re-insert at the tail.
    this.cache.delete(key.repositoryKey);
    this.cache.set(key.repositoryKey, entry);
    return entry.value;
  }

  private storeCache(key: SnapshotFlightKey, value: T): void {
    this.cache.delete(key.repositoryKey);
    this.cache.set(key.repositoryKey, {
      value,
      policyGeneration: key.policyGeneration,
      storedAt: this.now(),
    });
    while (this.cache.size > this.maxRepositories) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
