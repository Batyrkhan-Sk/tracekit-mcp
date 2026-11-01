import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, type InvestigationState } from '../../src/types/investigation.js';

const ALL: InvestigationState[] = ['starting', 'ready', 'running', 'closed', 'failed', 'expired'];

describe('investigation state transitions', () => {
  it('allows the normal lifecycle', () => {
    expect(canTransition('starting', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'ready')).toBe(true);
    expect(canTransition('ready', 'closed')).toBe(true);
    expect(canTransition('running', 'expired')).toBe(true);
    expect(canTransition('starting', 'failed')).toBe(true);
  });

  it('forbids leaving terminal states', () => {
    for (const terminal of ['closed', 'failed', 'expired'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ALL) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it('forbids skipping or reversing states', () => {
    expect(canTransition('starting', 'running')).toBe(false);
    expect(canTransition('ready', 'starting')).toBe(false);
    expect(canTransition('running', 'running')).toBe(false);
  });
});
