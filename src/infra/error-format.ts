import { isRecord } from './json.js';

/**
 * The `.code` a thrown value carries, wherever it was put — a Node system errno such as `ECONNREFUSED`, or a
 * string code from a non-Node layer in the same throw chain such as undici's `UND_ERR_SOCKET`.
 *
 * `fetch` rejects with a `TypeError('fetch failed')` and hangs the code off `.cause`, so a reader that looks
 * only at the top level sees nothing. An `AbortSignal.timeout` instead rejects with a `DOMException` whose
 * `.code` is the *number* `23`, so the string check is not decoration: without it that number reaches an
 * operator as the detail of a sentence about their coordinator.
 */
export function thrownErrnoCode(error: unknown): string | undefined {
  return errnoCode(error instanceof Error ? error.cause : undefined) ?? errnoCode(error);
}

function errnoCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
