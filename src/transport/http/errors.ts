export class BackendToolHttpError extends Error {
  public readonly statusCode: number;
  public readonly body: unknown;
  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.body = body;
    this.name = 'BackendToolHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
