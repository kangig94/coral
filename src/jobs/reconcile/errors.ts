export class StartupInterruptedError extends Error {
  constructor() {
    super('Startup interrupted by shutdown');
    this.name = 'StartupInterruptedError';
  }
}
