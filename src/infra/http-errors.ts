export class TransientHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TransientHttpError';
    this.status = status;
  }

  static isTransientStatus(status: number): boolean {
    return status === 502 || status === 503 || status === 504;
  }
}

export class CoordinatorUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorUnreachableError';
  }
}

export function isTransientStreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message === 'terminated') {
    return true;
  }
  if (error instanceof TransientHttpError || error instanceof CoordinatorUnreachableError) {
    return true;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ECONNABORTED';
}
