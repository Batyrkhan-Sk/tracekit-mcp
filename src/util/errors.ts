export type InvestigatorErrorCode =
  | 'INVALID_INPUT'
  | 'URL_REJECTED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'BUSY'
  | 'LIMIT_REACHED'
  | 'NAVIGATION_FAILED'
  | 'BROWSER_ERROR'
  | 'INTERNAL';

/** An error whose message is safe to show to the MCP client. */
export class InvestigatorError extends Error {
  constructor(
    readonly code: InvestigatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvestigatorError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
