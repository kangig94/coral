export class CoordinatorHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'CoordinatorHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
