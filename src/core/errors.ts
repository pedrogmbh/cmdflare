/** Error types and exit codes. */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  RATE_LIMIT: 5,
  CANCELLED: 130,
} as const;

export class CliError extends Error {
  exitCode: number;
  hint?: string;
  details?: unknown;
  constructor(message: string, opts: { exitCode?: number; hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? EXIT.ERROR;
    this.hint = opts.hint;
    this.details = opts.details;
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, { exitCode: EXIT.USAGE, hint });
    this.name = 'UsageError';
  }
}

export interface FormattedError {
  message: string;
  hint?: string;
  exitCode: number;
  status?: number;
  errors?: Array<{ code?: number; message: string }>;
  requestId?: string;
}

function isApiErrorLike(e: any): boolean {
  if (!e || typeof e !== 'object') return false;
  if (e.name === 'APIError' || (typeof e.constructor?.name === 'string' && e.constructor.name.endsWith('Error') && 'status' in e)) return true;
  return Array.isArray(e.errors) && 'status' in e;
}

/** Normalizes any thrown value (SDK APIError, CliError, fetch failures) into something printable. */
export function formatError(err: unknown): FormattedError {
  if (err instanceof CliError) {
    return { message: err.message, hint: err.hint, exitCode: err.exitCode };
  }
  const e = err as any;
  if (e && typeof e === 'object' && (e.name === 'ExitPromptError' || /User force closed/i.test(String(e.message)))) {
    return { message: 'Cancelled.', exitCode: EXIT.CANCELLED };
  }
  if (isApiErrorLike(e)) {
    const status: number | undefined = typeof e.status === 'number' ? e.status : undefined;
    const apiErrors: Array<{ code?: number; message: string }> =
      Array.isArray(e.errors) ? e.errors.map((x: any) => ({ code: x?.code, message: String(x?.message ?? x) })) : [];
    let message = '';
    if (apiErrors.length) {
      message = apiErrors.map((x) => (x.code ? `[${x.code}] ${x.message}` : x.message)).join('; ');
    } else if (typeof e.message === 'string') {
      message = e.message;
    } else {
      message = 'Request failed';
    }
    let exitCode: number = EXIT.ERROR;
    let hint: string | undefined;
    if (status === 401 || status === 403) {
      exitCode = EXIT.AUTH;
      hint =
        status === 401 ?
          'Check your credentials: run `cmdflare auth status`, or set CLOUDFLARE_API_TOKEN.'
        : 'Your token is valid but lacks permission for this resource. Adjust the token permissions in the Cloudflare dashboard.';
    } else if (status === 404) {
      exitCode = EXIT.NOT_FOUND;
    } else if (status === 429) {
      exitCode = EXIT.RATE_LIMIT;
      hint = 'Rate limited by the API. Retry later or reduce request frequency.';
    } else if (status === undefined && /fetch failed|ECONN|ENOTFOUND|network|Connection error/i.test(String(e.message))) {
      hint = 'Network error: check connectivity, proxies, or --base-url.';
    }
    const requestId = e.headers?.get?.('cf-ray') ?? e.headers?.['cf-ray'];
    return {
      message: status ? `HTTP ${status}: ${message}` : message,
      hint,
      exitCode,
      status,
      errors: apiErrors.length ? apiErrors : undefined,
      requestId,
    };
  }
  return { message: e?.message ? String(e.message) : String(e), exitCode: EXIT.ERROR };
}
