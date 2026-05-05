import { errorMessage } from '../../../infra/error-format.js';
import { BackendUnreachableError } from '../../../infra/http-errors.js';

function isBackendUnreachableCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const code = (current as { code?: unknown }).code;
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return true;
      }
    }
    if (typeof current === 'object' && current !== null && 'cause' in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      current = undefined;
    }
  }
  return false;
}

export function throwBackendCommunicationError(error: unknown): never {
  if (isBackendUnreachableCause(error)) {
    throw new BackendUnreachableError(errorMessage(error));
  }
  if (error instanceof Error) throw error;
  throw new Error(`Backend communication error: ${String(error)}`, { cause: error });
}
