import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Server configuration. Everything comes from environment variables so that
 * MCP clients can configure the server in their `env` block. Values are parsed
 * once at startup; the resulting object is passed down explicitly (no global
 * config singleton).
 */
export interface InvestigatorConfig {
  /** Hostname patterns (exact or `*.example.com`) the browser may contact. Empty = any public host. */
  allowedHosts: string[];
  /** Exact origins that may resolve to private/loopback addresses (e.g. a local dev server). */
  allowedLocalOrigins: string[];
  /** Allow POST/PUT/PATCH/DELETE from the page. Off by default to avoid side effects. */
  allowMutatingRequests: boolean;
  maxConcurrentInvestigations: number;
  maxRetainedInvestigations: number;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  retentionSeconds: number;
  defaultActionTimeoutMs: number;
  maxActionTimeoutMs: number;
  maxScreenshotsPerInvestigation: number;
  artifactsDir: string;
  headless: boolean;
  logLevel: LogLevel;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((value) => (value === undefined ? fallback : ['true', '1', 'yes'].includes(value)));

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional().default(fallback);

const envSchema = z.object({
  INVESTIGATOR_ALLOWED_HOSTS: csv,
  INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: csv,
  INVESTIGATOR_ALLOW_MUTATING_REQUESTS: bool(false),
  INVESTIGATOR_MAX_CONCURRENT: int(2, 1, 10),
  INVESTIGATOR_MAX_RETAINED: int(20, 1, 200),
  INVESTIGATOR_DEFAULT_DURATION_SECONDS: int(300, 10, 3600),
  INVESTIGATOR_MAX_DURATION_SECONDS: int(900, 10, 3600),
  INVESTIGATOR_RETENTION_SECONDS: int(3600, 0, 7 * 24 * 3600),
  INVESTIGATOR_ACTION_TIMEOUT_MS: int(10_000, 100, 120_000),
  INVESTIGATOR_MAX_ACTION_TIMEOUT_MS: int(60_000, 100, 300_000),
  INVESTIGATOR_MAX_SCREENSHOTS: int(20, 0, 200),
  INVESTIGATOR_ARTIFACTS_DIR: z.string().min(1).optional(),
  INVESTIGATOR_HEADLESS: bool(true),
  INVESTIGATOR_LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).optional().default('info'),
});

export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid origin in INVESTIGATOR_ALLOWED_LOCAL_ORIGINS: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Local origin must use http or https: "${raw}"`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`Local origin must be a bare origin such as http://127.0.0.1:4173 (got "${raw}")`);
  }
  return url.origin;
}

export function normalizeHostPattern(raw: string): string {
  const pattern = raw.toLowerCase();
  if (!/^(\*\.)?[a-z0-9.-]+$/.test(pattern) && !/^\[[0-9a-f:.]+\]$/.test(pattern)) {
    throw new Error(`Invalid host pattern in INVESTIGATOR_ALLOWED_HOSTS: "${raw}"`);
  }
  return pattern;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): InvestigatorConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  if (e.INVESTIGATOR_DEFAULT_DURATION_SECONDS > e.INVESTIGATOR_MAX_DURATION_SECONDS) {
    throw new Error(
      'INVESTIGATOR_DEFAULT_DURATION_SECONDS must not exceed INVESTIGATOR_MAX_DURATION_SECONDS',
    );
  }
  if (e.INVESTIGATOR_ACTION_TIMEOUT_MS > e.INVESTIGATOR_MAX_ACTION_TIMEOUT_MS) {
    throw new Error('INVESTIGATOR_ACTION_TIMEOUT_MS must not exceed INVESTIGATOR_MAX_ACTION_TIMEOUT_MS');
  }
  if (e.INVESTIGATOR_MAX_RETAINED < e.INVESTIGATOR_MAX_CONCURRENT) {
    throw new Error('INVESTIGATOR_MAX_RETAINED must be at least INVESTIGATOR_MAX_CONCURRENT');
  }
  return {
    allowedHosts: e.INVESTIGATOR_ALLOWED_HOSTS.map(normalizeHostPattern),
    allowedLocalOrigins: e.INVESTIGATOR_ALLOWED_LOCAL_ORIGINS.map(normalizeOrigin),
    allowMutatingRequests: e.INVESTIGATOR_ALLOW_MUTATING_REQUESTS,
    maxConcurrentInvestigations: e.INVESTIGATOR_MAX_CONCURRENT,
    maxRetainedInvestigations: e.INVESTIGATOR_MAX_RETAINED,
    defaultDurationSeconds: e.INVESTIGATOR_DEFAULT_DURATION_SECONDS,
    maxDurationSeconds: e.INVESTIGATOR_MAX_DURATION_SECONDS,
    retentionSeconds: e.INVESTIGATOR_RETENTION_SECONDS,
    defaultActionTimeoutMs: e.INVESTIGATOR_ACTION_TIMEOUT_MS,
    maxActionTimeoutMs: e.INVESTIGATOR_MAX_ACTION_TIMEOUT_MS,
    maxScreenshotsPerInvestigation: e.INVESTIGATOR_MAX_SCREENSHOTS,
    artifactsDir: path.resolve(
      e.INVESTIGATOR_ARTIFACTS_DIR ?? path.join(os.tmpdir(), 'frontend-bug-investigator-artifacts'),
    ),
    headless: e.INVESTIGATOR_HEADLESS,
    logLevel: e.INVESTIGATOR_LOG_LEVEL,
  };
}
