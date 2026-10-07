import { createHash } from 'node:crypto';
import { epochIdentity } from '../../store/epoch/identity.js';
import type { WaitCursor } from './contract.js';

/** Every requested active-epoch job of the tagged epoch had each of its rows at or below `seq` delivered. */
export type WaitWatermark = Readonly<{ epochTag: number; seq: number }>;

export type WaitCursorRejection = Readonly<{ code: 'wait_cursor_malformed'; message: string }>;

export type WaitCursorDecoded =
  | Readonly<{ kind: 'decoded'; watermark: WaitWatermark }>
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

const SEQ_BYTES = 5;
const MAX_WATERMARK_SEQ = 2 ** (SEQ_BYTES * 8) - 1;
const EPOCHLESS_STORE_KEY = ':memory:';

/** Tokens label an accepted epoch in messages; they cannot reconstruct filesystem paths. */
export function waitEpochToken(epochKey: string): string {
  return createHash('sha256').update(epochIdentity(epochKey)).digest().subarray(0, 16).toString('hex');
}

/** Two keys `sameEpoch` treats as one epoch always share a tag; distinct epochs collide one time in 256. */
export function waitEpochTag(epochKey: string): number {
  return epochKey === EPOCHLESS_STORE_KEY ? 0 : createHash('sha256').update(epochIdentity(epochKey)).digest()[0];
}

/** Layout: the epoch tag byte, then the seq as a 40-bit big-endian integer. A seq past 40 bits has no cursor. */
export function encodeWaitCursor(watermark: WaitWatermark): WaitCursor | null {
  if (!Number.isSafeInteger(watermark.seq) || watermark.seq < 0 || watermark.seq > MAX_WATERMARK_SEQ) return null;
  const bytes = Buffer.alloc(1 + SEQ_BYTES);
  bytes[0] = watermark.epochTag;
  bytes.writeUIntBE(watermark.seq, 1, SEQ_BYTES);
  return bytes.toString('base64url');
}

/** Six bytes are exactly eight base64url characters, so any other string is not a cursor this build reads. */
export function decodeWaitCursor(raw: unknown): WaitCursorDecoded {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8}$/.test(raw)) return REJECTED;
  const bytes = Buffer.from(raw, 'base64url');
  return { kind: 'decoded', watermark: { epochTag: bytes[0], seq: bytes.readUIntBE(1, SEQ_BYTES) } };
}
