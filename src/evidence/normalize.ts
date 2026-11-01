import { looksLikePromptInjection, redactText, redactUrl } from '../security/redact.js';
import type { EvidenceDetailsMap } from '../types/evidence.js';

/**
 * Pure conversions from raw browser observations to sanitized evidence
 * details. Kept free of Playwright types so they can be unit tested directly.
 */

export interface RawConsoleMessage {
  type: string;
  text: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
}

export function normalizeConsoleMessage(msg: RawConsoleMessage): EvidenceDetailsMap['console'] | null {
  const level = msg.type === 'error' ? 'error' : msg.type === 'warning' ? 'warning' : null;
  if (!level) return null;
  const text = redactText(msg.text, { maxLength: 2000 });
  const loc = msg.location?.url
    ? `${redactUrl(msg.location.url)}:${msg.location.lineNumber ?? 0}:${msg.location.columnNumber ?? 0}`
    : undefined;
  return {
    level,
    text,
    ...(loc ? { location: loc } : {}),
    repeatCount: 1,
    possiblePromptInjection: looksLikePromptInjection(msg.text),
  };
}

export interface RawPageError {
  name?: string;
  message: string;
  stack?: string;
}

export function normalizePageError(error: RawPageError): EvidenceDetailsMap['page_error'] {
  const stack = error.stack ? redactText(error.stack, { maxLength: 4000 }) : undefined;
  return {
    name: redactText(error.name || 'Error', { maxLength: 100 }),
    message: redactText(error.message, { maxLength: 2000 }),
    ...(stack ? { stack } : {}),
    possiblePromptInjection: looksLikePromptInjection(`${error.message}\n${error.stack ?? ''}`),
  };
}

/** Resource types that are always recorded; others are recorded only when they fail. */
const ALWAYS_RECORDED = new Set(['document', 'xhr', 'fetch', 'eventsource', 'websocket']);

export function shouldRecordRequest(resourceType: string, isNavigation: boolean): boolean {
  return isNavigation || ALWAYS_RECORDED.has(resourceType);
}

export function isApiResourceType(resourceType: string): boolean {
  return resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'eventsource';
}

export function isBlockedFailure(errorText: string): boolean {
  return /ERR_BLOCKED_BY_CLIENT/i.test(errorText);
}

export function sanitizeErrorText(errorText: string): string {
  return redactText(errorText, { maxLength: 300 });
}

/**
 * Strips Playwright's verbose call logs from an error message and redacts it.
 * Only the first meaningful lines are kept.
 */
export function summarizeBrowserError(message: string): string {
  const firstBlock = message.split(/\n\s*Call log:|\n={5,}/)[0] ?? message;
  const lines = firstBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  return redactText(lines.join(' | '), { maxLength: 600 });
}

/** URL path used to group requests to the same endpoint (query ignored). */
export function endpointKey(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}
