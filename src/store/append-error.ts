export type CoralAppendErrorDetail = Record<string, unknown>;

export class CoralAppendError extends Error {
  readonly code: string;
  readonly detail: CoralAppendErrorDetail;

  constructor(code: string, detail: CoralAppendErrorDetail = {}) {
    super(`${code}: ${JSON.stringify(detail)}`);
    this.name = 'CoralAppendError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, CoralAppendError.prototype);
  }
}
