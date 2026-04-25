/**
 * Control signal raised by the boot/recovery flow when shutdown is requested
 * mid-startup. Lives at the coordinator package root (not nested in
 * `services/` or `shutdown.ts`) so both the throw site (`control.ts`) and the
 * catch sites (`bootstrap.ts`, `services/recovery-coordinator.ts`) can import
 * it without forming an import cycle through `control.ts`.
 */
export class StartupInterruptedError extends Error {
  constructor() {
    super('Startup interrupted by shutdown');
    this.name = 'StartupInterruptedError';
  }
}
