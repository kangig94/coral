export class BackendToolHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'BackendToolHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
