import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      allowedHosts: [],
      allowedLocalOrigins: [],
      allowMutatingRequests: false,
      maxConcurrentInvestigations: 2,
      headless: true,
      logLevel: 'info',
    });
    expect(config.artifactsDir).toContain('frontend-bug-investigator-artifacts');
  });

  it('parses lists, booleans and numbers', () => {
    const config = loadConfig({
      INVESTIGATOR_ALLOWED_HOSTS: 'Example.com, *.example.org',
      INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: 'http://127.0.0.1:4173/',
      INVESTIGATOR_ALLOW_MUTATING_REQUESTS: 'true',
      INVESTIGATOR_MAX_CONCURRENT: '3',
    });
    expect(config.allowedHosts).toEqual(['example.com', '*.example.org']);
    expect(config.allowedLocalOrigins).toEqual(['http://127.0.0.1:4173']);
    expect(config.allowMutatingRequests).toBe(true);
    expect(config.maxConcurrentInvestigations).toBe(3);
  });

  it.each([
    [{ INVESTIGATOR_MAX_CONCURRENT: '0' }],
    [{ INVESTIGATOR_MAX_CONCURRENT: 'many' }],
    [{ INVESTIGATOR_HEADLESS: 'maybe' }],
    [{ INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: 'ftp://127.0.0.1' }],
    [{ INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: 'http://127.0.0.1:4173/path' }],
    [{ INVESTIGATOR_ALLOWED_HOSTS: 'exa mple.com' }],
    [{ INVESTIGATOR_DEFAULT_DURATION_SECONDS: '900', INVESTIGATOR_MAX_DURATION_SECONDS: '60' }],
    [{ INVESTIGATOR_MAX_RETAINED: '1', INVESTIGATOR_MAX_CONCURRENT: '3' }],
  ])('rejects invalid configuration %j', (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
