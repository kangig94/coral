import type { WaitCursor } from './contract.js';

export type WaitCursorRejection = Readonly<{ code: 'wait_cursor_malformed'; message: string }>;

/** `watermark`: every requested active-epoch job had each of its rows at or below this seq delivered. */
export type WaitCursorDecoded =
  | Readonly<{ kind: 'decoded'; watermark: number }>
  | Readonly<{ kind: 'rejected'; error: WaitCursorRejection }>;

const REJECTED: WaitCursorDecoded = {
  kind: 'rejected',
  error: {
    code: 'wait_cursor_malformed',
    message: 'This wait cursor cannot be decoded by this build; collection restarts from the current tail.',
  },
};

export const WAIT_CURSOR_REPLAY_NOTICE =
  'saved cursor not accepted by this coordinator; the current progress tail and retained results are collected again, so earlier results may repeat';

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The cursor is the bare watermark seq: it carries no epoch, so an epoch change cannot be detected from it. */
export function encodeWaitCursor(watermark: number): WaitCursor {
  return String(watermark);
}

/** Every other string, a cursor an older build printed included, is malformed; no shape is translated. */
export function decodeWaitCursor(raw: unknown): WaitCursorDecoded {
  if (typeof raw !== 'string' || !CANONICAL_DECIMAL.test(raw)) return REJECTED;
  const watermark = Number(raw);
  return Number.isSafeInteger(watermark) ? { kind: 'decoded', watermark } : REJECTED;
}
