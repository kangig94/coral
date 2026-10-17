import { CLI_HANDOFF_GUARD_ENV } from './wait-invocation.js';

export const waitCommandPaths = {
  current: 'jobs wait',
  legacyWaitJobs: 'wait jobs',
} as const;

/** Delegated continuations must remain runnable under an older session's Bash timeout hook. */
export function waitCommandPrefix(): string {
  const legacyWaitJobsDelegatedChild = process.env[CLI_HANDOFF_GUARD_ENV] === '1';
  return `coral-cli ${legacyWaitJobsDelegatedChild ? waitCommandPaths.legacyWaitJobs : waitCommandPaths.current}`;
}
