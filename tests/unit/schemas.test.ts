import { describe, expect, it } from 'vitest';
import {
  CollectEvidenceInput,
  GenerateRegressionTestInput,
  ReproduceIssueInput,
  StartInvestigationInput,
} from '../../src/tools/schemas.js';
import { ActionSchema } from '../../src/types/actions.js';

const ID = 'inv_123e4567-e89b-42d3-a456-426614174000';

describe('ActionSchema', () => {
  it.each([
    { action: 'navigate', url: 'https://example.com/' },
    { action: 'click', target: { by: 'role', role: 'button', name: 'Save' } },
    { action: 'fill', target: { by: 'label', label: 'Email' }, value: 'a@b.c' },
    { action: 'select', target: { by: 'testId', testId: 'color' }, option: { label: 'Red' } },
    { action: 'reload', waitUntil: 'networkidle' },
    {
      action: 'waitFor',
      target: { by: 'css', selector: '.grid > li:first-child' },
      state: 'visible',
      timeoutMs: 500,
    },
    { action: 'screenshot', label: 'after', returnImage: true },
  ])('accepts %j', (action) => {
    expect(ActionSchema.safeParse(action).success).toBe(true);
  });

  it.each([
    [{ action: 'evaluate', script: 'alert(1)' }, 'unknown action'],
    [{ action: 'click', target: { by: 'role', role: 'button' }, script: 'x' }, 'extra property'],
    [{ action: 'click', target: { by: 'role', role: 'not-a-role' } }, 'invalid role'],
    [{ action: 'click', target: { by: 'css', selector: 'xpath=//button' } }, 'selector engine'],
    [{ action: 'click', target: { by: 'css', selector: '//button' } }, 'implicit xpath'],
    [{ action: 'click', target: { by: 'css', selector: 'div >> text=Delete' } }, 'selector chaining'],
    [{ action: 'click', target: { by: 'css', selector: 'internal:role=button' } }, 'internal engine'],
    [{ action: 'fill', target: { by: 'label', label: 'x' }, value: 'a'.repeat(1001) }, 'value too long'],
    [{ action: 'waitFor', target: { by: 'testId', testId: 'x' }, timeoutMs: 10 }, 'timeout too small'],
    [{ action: 'reload', waitUntil: 'forever' }, 'invalid waitUntil'],
  ])('rejects %j (%s)', (action, _reason) => {
    expect(ActionSchema.safeParse(action).success).toBe(false);
  });
});

describe('tool input schemas', () => {
  it('validates start_investigation input', () => {
    expect(
      StartInvestigationInput.safeParse({ targetUrl: 'https://example.com', issueDescription: 'x' }).success,
    ).toBe(true);
    expect(StartInvestigationInput.safeParse({ targetUrl: 'https://example.com' }).success).toBe(false);
    expect(
      StartInvestigationInput.safeParse({
        targetUrl: 'https://example.com',
        issueDescription: 'x',
        viewport: { width: 10, height: 10 },
      }).success,
    ).toBe(false);
    expect(
      StartInvestigationInput.safeParse({
        targetUrl: 'https://example.com',
        issueDescription: 'x',
        maxDurationSeconds: 99999,
      }).success,
    ).toBe(false);
    expect(
      StartInvestigationInput.safeParse({
        targetUrl: 'https://example.com',
        issueDescription: 'x',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('requires a well-formed investigation id', () => {
    expect(CollectEvidenceInput.safeParse({ investigationId: ID }).success).toBe(true);
    for (const bad of ['', 'inv_1', '../../etc/passwd', `${ID}x`, ID.toUpperCase()]) {
      expect(CollectEvidenceInput.safeParse({ investigationId: bad }).success).toBe(false);
    }
  });

  it('bounds reproduction steps', () => {
    expect(ReproduceIssueInput.safeParse({ investigationId: ID, steps: [] }).success).toBe(false);
    const many = Array.from({ length: 51 }, () => ({ action: 'reload' }));
    expect(ReproduceIssueInput.safeParse({ investigationId: ID, steps: many }).success).toBe(false);
  });

  it('restricts regression test names', () => {
    expect(
      GenerateRegressionTestInput.safeParse({ investigationId: ID, testName: 'catalog: no flicker' }).success,
    ).toBe(true);
    expect(
      GenerateRegressionTestInput.safeParse({ investigationId: ID, testName: "x'); process.exit(1); ('" })
        .success,
    ).toBe(false);
  });
});
