/**
 * Redaction and sanitization of data that originates from the target page or
 * its network traffic. All of it is untrusted: it may contain secrets that
 * must not be persisted, and text crafted to manipulate an AI client.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_PARAM =
  /(token|secret|passw|pwd|auth|api[-_]?key|apikey|access[-_]?key|private|session|sid$|^sig$|signature|credential|jwt|^code$|^state$|cookie|otp|nonce)/i;

export function isSensitiveParamName(name: string): boolean {
  return SENSITIVE_PARAM.test(name);
}

/**
 * Removes credentials, sensitive query values and fragments from a URL.
 * Returns a placeholder for unparsable input instead of echoing it.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[unparsable-url]';
  }
  if (url.protocol === 'data:') return 'data:[omitted]';
  if (url.protocol === 'blob:') return 'blob:[omitted]';
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  const params = [...url.searchParams.keys()];
  for (const key of new Set(params)) {
    if (isSensitiveParamName(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }
  // Fragments often carry OAuth implicit-flow tokens; keep only that one existed.
  if (url.hash) url.hash = 'redacted';
  let text = url.toString();
  // URLSearchParams percent-encodes the placeholder; keep it readable.
  text = text.replaceAll(encodeURIComponent(REDACTED), REDACTED);
  return redactText(text, { maxLength: 2048 });
}

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/]{8,}=*/g, `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g, '[REDACTED_API_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_TOKEN]'],
  [
    /\b(access_token|refresh_token|id_token|api[_-]?key|apikey|secret|password|passwd|token|session[_-]?id|authorization)(["']?\s*[:=]\s*["']?)([^\s"'&,;]+)/gi,
    `$1$2${REDACTED}`,
  ],
  [/\b(cookie|set-cookie)(\s*:\s*)[^\n]+/gi, `$1$2${REDACTED}`],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED_EMAIL]'],
];

// C0/C1 controls (except tab/newline), bidi overrides and zero-width chars can
// hide content from human reviewers or confuse terminals and parsers.
const UNSAFE_CHARS = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]',
  'g',
);
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface RedactOptions {
  maxLength?: number;
}

export function sanitizeText(input: string, maxLength = 2000): string {
  let text = input.replace(ANSI_ESCAPES, '').replace(UNSAFE_CHARS, '');
  if (text.length > maxLength)
    text = `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
  return text;
}

export function redactText(input: string, options: RedactOptions = {}): string {
  let text = input;
  for (const [pattern, replacement] of TEXT_PATTERNS) text = text.replace(pattern, replacement);
  // Redact URLs embedded in free text (stack traces, console messages).
  text = text.replace(/\bhttps?:\/\/[^\s"'<>)]+/g, (match) => {
    if (match.includes(REDACTED)) return match;
    const redacted = redactUrlLoose(match);
    return redacted;
  });
  return sanitizeText(text, options.maxLength ?? 2000);
}

function redactUrlLoose(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
      changed = true;
    }
    for (const key of new Set(url.searchParams.keys())) {
      if (isSensitiveParamName(key)) {
        url.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (url.hash) {
      url.hash = 'redacted';
      changed = true;
    }
    return changed ? url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED) : raw;
  } catch {
    return raw;
  }
}

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'server',
  'cf-mitigated',
  'content-length',
  'cache-control',
  'age',
  'server-timing',
  'location',
  'retry-after',
]);

/** Keeps only an allowlist of response headers; never cookies or auth. */
export function pickSafeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(lower)) continue;
    out[lower] = lower === 'location' ? redactUrlRelative(value) : redactText(value, { maxLength: 300 });
  }
  return out;
}

function redactUrlRelative(value: string): string {
  try {
    return redactUrl(new URL(value, 'http://relative.invalid').toString()).replace(
      'http://relative.invalid',
      '',
    );
  } catch {
    return '[unparsable-url]';
  }
}

const INJECTION_MARKERS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (all |any )?(previous|prior|above)/i,
  /\byou are (now )?(an? )?(ai|assistant|language model|chatgpt|claude)\b/i,
  /\bsystem prompt\b/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\b(call|invoke|use) the [\w-]+ tool\b/i,
  /\bnew instructions?\b/i,
];

/** Flags page-originated text that looks like an attempt to instruct an AI agent. */
export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_MARKERS.some((pattern) => pattern.test(text));
}
