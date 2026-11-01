import type {
  EvidenceDetailsMap,
  EvidenceItem,
  EvidenceOf,
  EvidenceSource,
  EvidenceType,
} from '../types/evidence.js';
import { EVIDENCE_TYPES } from '../types/evidence.js';

export interface Clock {
  /** Wall-clock epoch milliseconds. */
  now(): number;
  /** Monotonic milliseconds (only differences are meaningful). */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};

export type EvidenceLimits = Record<EvidenceType, number>;

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  console: 200,
  page_error: 100,
  network_request: 500,
  network_response: 500,
  network_failure: 200,
  navigation: 100,
  dom_visibility: 400,
  layout_shift: 100,
  screenshot: 50,
  action: 200,
  security: 200,
  instrumentation: 50,
};

export interface AddOptions {
  source: EvidenceSource;
  url?: string;
  untrusted?: boolean;
}

export interface ListFilter {
  types?: readonly EvidenceType[];
  sinceSeq?: number;
  limit?: number;
}

/**
 * Append-only, bounded evidence log for a single investigation.
 *
 * Each category has its own cap. When a category is full, *new* items in that
 * category are counted and dropped: for bug investigation the first
 * occurrences (around the onset of the bug) are usually the most informative,
 * and a noisy category can never evict evidence from another category.
 */
export class EvidenceStore {
  private readonly items: EvidenceItem[] = [];
  private readonly countsByType = new Map<EvidenceType, number>();
  private readonly droppedByType = new Map<EvidenceType, number>();
  private seq = 0;
  private readonly startMonotonic: number;
  private readonly startWall: number;

  constructor(
    readonly investigationId: string,
    private readonly clock: Clock = systemClock,
    private readonly limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  ) {
    this.startMonotonic = clock.monotonic();
    this.startWall = clock.now();
  }

  get startedAt(): string {
    return new Date(this.startWall).toISOString();
  }

  elapsedMs(): number {
    return Math.round((this.clock.monotonic() - this.startMonotonic) * 10) / 10;
  }

  add<T extends EvidenceType>(
    type: T,
    details: EvidenceDetailsMap[T],
    options: AddOptions,
  ): EvidenceOf<T> | null {
    const count = this.countsByType.get(type) ?? 0;
    if (count >= this.limits[type]) {
      this.droppedByType.set(type, (this.droppedByType.get(type) ?? 0) + 1);
      return null;
    }
    this.countsByType.set(type, count + 1);
    this.seq += 1;
    const elapsedMs = this.elapsedMs();
    const item = {
      id: `ev_${this.seq}`,
      investigationId: this.investigationId,
      seq: this.seq,
      type,
      timestamp: new Date(this.startWall + elapsedMs).toISOString(),
      elapsedMs,
      ...(options.url !== undefined ? { url: options.url } : {}),
      source: options.source,
      untrusted: options.untrusted ?? false,
      details,
    } as EvidenceOf<T>;
    this.items.push(item);
    return item;
  }

  /** The most recent item of a type, used for de-duplicating repeated console output. */
  last<T extends EvidenceType>(type: T): EvidenceOf<T> | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.type === type) return item as EvidenceOf<T>;
    }
    return undefined;
  }

  get(id: string): EvidenceItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  ofType<T extends EvidenceType>(type: T): EvidenceOf<T>[] {
    return this.items.filter((item): item is EvidenceOf<T> => item.type === type);
  }

  list(filter: ListFilter = {}): EvidenceItem[] {
    const types = filter.types ? new Set(filter.types) : null;
    const since = filter.sinceSeq ?? 0;
    const out = this.items.filter((item) => item.seq > since && (!types || types.has(item.type)));
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }

  /** All items ordered by observation time; ties keep insertion order. */
  timeline(): EvidenceItem[] {
    return [...this.items].sort((a, b) => a.elapsedMs - b.elapsedMs || a.seq - b.seq);
  }

  get size(): number {
    return this.items.length;
  }

  get lastSeq(): number {
    return this.seq;
  }

  counts(): Record<EvidenceType, number> {
    return Object.fromEntries(EVIDENCE_TYPES.map((t) => [t, this.countsByType.get(t) ?? 0])) as Record<
      EvidenceType,
      number
    >;
  }

  dropped(): Partial<Record<EvidenceType, number>> {
    return Object.fromEntries(this.droppedByType.entries());
  }
}
