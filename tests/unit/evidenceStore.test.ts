import { describe, expect, it } from 'vitest';
import { DEFAULT_EVIDENCE_LIMITS, EvidenceStore, type Clock } from '../../src/evidence/evidenceStore.js';
import { EvidenceItemSchema } from '../../src/types/evidence.js';

function manualClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let mono = 0;
  return {
    now: () => start + mono,
    monotonic: () => mono,
    advance(ms: number) {
      mono += ms;
    },
  };
}

const nav = { event: 'load' as const };

describe('EvidenceStore', () => {
  it('assigns increasing ids, sequence numbers and timestamps', () => {
    const clock = manualClock();
    const store = new EvidenceStore('inv_x', clock);
    const a = store.add('navigation', nav, { source: 'browser-page' });
    clock.advance(25);
    const b = store.add(
      'console',
      { level: 'error', text: 'x', repeatCount: 1, possiblePromptInjection: false },
      {
        source: 'browser-console',
        untrusted: true,
        url: 'http://a.test/',
      },
    );
    expect(a).toMatchObject({ id: 'ev_1', seq: 1, elapsedMs: 0, investigationId: 'inv_x', untrusted: false });
    expect(b).toMatchObject({ id: 'ev_2', seq: 2, elapsedMs: 25, untrusted: true, url: 'http://a.test/' });
    expect(new Date(b!.timestamp).getTime() - new Date(a!.timestamp).getTime()).toBe(25);
  });

  it('produces items that satisfy the public evidence schema', () => {
    const store = new EvidenceStore('inv_x', manualClock());
    store.add(
      'security',
      { kind: 'egress_http', hostname: '10.0.0.1', port: 80, reason: 'blocked_address', message: 'm' },
      {
        source: 'egress-proxy',
      },
    );
    for (const item of store.list()) expect(() => EvidenceItemSchema.parse(item)).not.toThrow();
  });

  it('caps each category independently and counts dropped items', () => {
    const limits = { ...DEFAULT_EVIDENCE_LIMITS, console: 2 };
    const store = new EvidenceStore('inv_x', manualClock(), limits);
    for (let i = 0; i < 5; i++) {
      store.add(
        'console',
        { level: 'warning', text: `w${i}`, repeatCount: 1, possiblePromptInjection: false },
        { source: 'browser-console' },
      );
    }
    store.add('navigation', nav, { source: 'browser-page' });
    expect(store.ofType('console').map((c) => c.details.text)).toEqual(['w0', 'w1']); // first occurrences kept
    expect(store.dropped()).toEqual({ console: 3 });
    expect(store.counts().navigation).toBe(1);
    expect(store.size).toBe(3);
  });

  it('filters by type, sequence and limit', () => {
    const store = new EvidenceStore('inv_x', manualClock());
    store.add('navigation', nav, { source: 'browser-page' });
    store.add('instrumentation', { message: 'a' }, { source: 'investigator' });
    store.add('navigation', nav, { source: 'browser-page' });
    expect(store.list({ types: ['navigation'] }).map((i) => i.id)).toEqual(['ev_1', 'ev_3']);
    expect(store.list({ sinceSeq: 1 }).map((i) => i.id)).toEqual(['ev_2', 'ev_3']);
    expect(store.list({ limit: 1 }).map((i) => i.id)).toEqual(['ev_1']);
  });

  it('orders the timeline by observation time with stable ties', () => {
    const clock = manualClock();
    const store = new EvidenceStore('inv_x', clock);
    clock.advance(10);
    store.add('navigation', nav, { source: 'browser-page' });
    store.add('instrumentation', { message: 'same time' }, { source: 'investigator' });
    clock.advance(5);
    store.add('navigation', nav, { source: 'browser-page' });
    const timeline = store.timeline();
    expect(timeline.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(timeline.every((item, i) => i === 0 || item.elapsedMs >= timeline[i - 1]!.elapsedMs)).toBe(true);
  });
});
