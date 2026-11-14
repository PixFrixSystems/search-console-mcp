/** An error whose message is safe and useful to show to the person or model calling a tool. */
export class UserError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UserError';
    this.hint = hint;
  }
}

/** Credentials are missing, unreadable or rejected. */
export class AuthSetupError extends UserError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'AuthSetupError';
  }
}

/** The Search Console API answered with an error status. */
export class GscApiError extends UserError {
  readonly status: number;
  readonly reason?: string;

  constructor(status: number, message: string, options: { reason?: string; hint?: string } = {}) {
    super(message, options.hint);
    this.name = 'GscApiError';
    this.status = status;
    this.reason = options.reason;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof UserError) {
    return error.hint ? `${error.message}\n\nHow to fix: ${error.hint}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
