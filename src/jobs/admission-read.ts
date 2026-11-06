import type { TimePort } from '../infra/port-types.js';

export const ADMISSION_READ_TIMEOUT_MS = 1_000;
export const ADMISSION_READ_MAX_ATTEMPTS = 3;
export const ADMISSION_READ_RETRY_MS = 100;

export class AdmissionProjectionReadUnavailableError extends Error {
  readonly attempts: number;

  constructor(attempts: number, cause?: unknown) {
    super(`Admission projection evidence remains undetermined after ${attempts} read attempts.`, { cause });
    this.name = 'AdmissionProjectionReadUnavailableError';
    this.attempts = attempts;
  }
}

function isTransientProjectionRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : null;
  const errcode = 'errcode' in error ? error.errcode : null;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    (typeof errcode === 'number' && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6))
  );
}

/** Only observation is retried; an expired inherited deadline cannot authorize another read. */
export async function readAdmissionProjection<T>(
  read: () => T,
  time: Pick<TimePort, 'now' | 'sleep'>,
  deadline: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    if (time.now() >= deadline) throw new AdmissionProjectionReadUnavailableError(attempt, lastError);
    try {
      return read();
    } catch (error) {
      if (!isTransientProjectionRead(error)) throw error;
      lastError = error;
      if (attempt >= ADMISSION_READ_MAX_ATTEMPTS - 1 || time.now() >= deadline)
        throw new AdmissionProjectionReadUnavailableError(attempt + 1, error);
      await time.sleep(ADMISSION_READ_RETRY_MS);
    }
  }
}
