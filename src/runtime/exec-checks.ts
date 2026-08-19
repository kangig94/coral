import type { Runtime } from './ports.js';
import type { ExecResult } from '../infra/port-types.js';

/** Locate an executable on PATH using the platform's `which`/`where` shim. */
export async function findCommand(runtime: Runtime, command: string): Promise<string | null> {
  const locator = runtime.env.platform() === 'win32' ? 'where' : 'which';
  const result = await runtime.process.exec(locator, [command], {
    encoding: 'utf-8',
    inheritEnv: true,
    timeout: 10_000,
  });

  if (result.status !== 0 || result.error || result.stdout.trim().length === 0) {
    return null;
  }

  return result.stdout.trim().split(/\r?\n/, 1)[0] ?? null;
}

/** Throw a descriptive error if the exec result indicates failure. */
export function ensureExecSucceeded(command: string, result: ExecResult): void {
  if (result.status === 0 && !result.error) {
    return;
  }

  const parts = [`${command} failed`];
  if (result.stderr.trim().length > 0) {
    parts.push(result.stderr.trim());
  } else if (result.error instanceof Error) {
    parts.push(result.error.message);
  }
  throw new Error(parts.join(': '));
}
