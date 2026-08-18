import { isRecord } from './json.js';

/**
 * The Node system errno a thrown value carries, wherever Node put it.
 *
 * `fetch` rejects with a `TypeError('fetch failed')` and hangs the errno off `.cause`, so a reader that looks
 * only at the top level sees nothing — which is how `backend shutdown`'s `socket_refused` sat unreachable
 * while the test that covered it built the error by hand and agreed with the bug. An `AbortSignal.timeout`
 * instead rejects with a `DOMException` whose `.code` is the *number* `23`, so the string check is not
 * decoration: without it that number reaches an operator as the detail of a sentence about their coordinator.
 *
 * One home rather than a copy per caller, because the copy already cost once. The unwrap was written into
 * `transport/http/backend/shutdown.ts` and not into its sibling `status.ts`, and a review round caught the
 * twin rather than the compiler. Two byte-identical readers in one directory are the shape that produces
 * that, whatever the argument for keeping them apart says.
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
