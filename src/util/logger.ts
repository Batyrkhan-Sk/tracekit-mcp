import type { LogLevel } from '../config/config.js';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX_LOG_LINE = 2000;

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Writes bounded, single-line JSON logs to stderr. stdout is reserved for the
 * MCP stdio transport and must never be written to.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (l) => process.stderr.write(l),
): Logger {
  const threshold = LEVELS[level];
  const log = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] > threshold) return;
    let line = JSON.stringify({ t: new Date().toISOString(), level: lvl, message, ...fields });
    if (line.length > MAX_LOG_LINE) line = `${line.slice(0, MAX_LOG_LINE)}…[truncated]`;
    write(`${line}\n`);
  };
  return {
    error: (m, f) => log('error', m, f),
    warn: (m, f) => log('warn', m, f),
    info: (m, f) => log('info', m, f),
    debug: (m, f) => log('debug', m, f),
  };
}

export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
