import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { InvestigatorConfig } from '../../src/config/config.js';

export function testConfig(overrides: Partial<InvestigatorConfig> = {}): InvestigatorConfig {
  return {
    allowedHosts: [],
    allowedLocalOrigins: [],
    allowMutatingRequests: false,
    maxConcurrentInvestigations: 2,
    maxRetainedInvestigations: 5,
    defaultDurationSeconds: 120,
    maxDurationSeconds: 600,
    retentionSeconds: 3600,
    defaultActionTimeoutMs: 5000,
    maxActionTimeoutMs: 20_000,
    maxScreenshotsPerInvestigation: 10,
    artifactsDir: path.join(os.tmpdir(), 'fbi-tests', crypto.randomBytes(6).toString('hex')),
    headless: true,
    logLevel: 'error',
    ...overrides,
  };
}
