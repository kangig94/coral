import { createHash } from 'node:crypto';
import { epochIdentity } from '../../store/epoch/identity.js';
import { isRecord } from '../../infra/json.js';
import type { WaitCursor, WaitCursorEntry } from './contract.js';

export type WaitCursorRejection = Readonly<{ code: 'wait_cursor_malformed'; message: string }>;

export type WaitCursorDecoded =
  | Readonly<{ kind: 'decoded'; cursor: WaitCursor }>
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

const MAX_JOBS = 128;
const MAX_CURSOR_BYTES = 4096;
const ENTRY_BYTES = 16;

/** Tokens label an accepted epoch in messages; they cannot reconstruct filesystem paths. */
export function waitEpochToken(epochKey: string): string {
  return createHash('sha256').update(epochIdentity(epochKey)).digest().subarray(0, 16).toString('hex');
}

export function waitJobHash(jobId: string): string {
  return createHash('sha256').update(jobId).digest().subarray(0, 8).toString('hex');
}

function validEntry(value: unknown): value is WaitCursorEntry {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const { hash, seq } = value;
  return typeof hash === 'string' && /^[a-f0-9]{16}$/.test(hash) && Number.isSafeInteger(seq) && (seq as number) >= 0;
}

/** A cursor is exactly `{ jobs }`; an object in any other shape is not a cursor this build reads. */
export function decodeWaitCursor(value: unknown): WaitCursorDecoded {
  if (!isRecord(value) || Object.keys(value).length !== 1) return REJECTED;
  const { jobs } = value;
  if (
    !Array.isArray(jobs) ||
    jobs.length > MAX_JOBS ||
    !jobs.every(validEntry) ||
    new Set(jobs.map((job) => job.hash)).size !== jobs.length
  )
    return REJECTED;
  return { kind: 'decoded', cursor: { jobs } };
}

/** Layout: job count, then per job its 8-byte hash and its seq as a u64. */
export function serializeWaitCursor(cursor: WaitCursor): string {
  if (decodeWaitCursor(cursor).kind !== 'decoded') throw new Error('wait_cursor_malformed');
  const bytes = Buffer.alloc(1 + cursor.jobs.length * ENTRY_BYTES);
  bytes[0] = cursor.jobs.length;
  cursor.jobs.forEach((job, index) => {
    const offset = 1 + index * ENTRY_BYTES;
    bytes.set(Buffer.from(job.hash, 'hex'), offset);
    bytes.writeBigUInt64BE(BigInt(job.seq), offset + 8);
  });
  return bytes.toString('base64url');
}

export function decodeSerializedWaitCursor(raw: string): WaitCursorDecoded {
  if (Buffer.byteLength(raw) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw)) return REJECTED;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw || bytes.length < 1 || bytes.length !== 1 + bytes[0] * ENTRY_BYTES)
    return REJECTED;
  const jobs: WaitCursorEntry[] = [];
  for (let offset = 1; offset < bytes.length; offset += ENTRY_BYTES)
    jobs.push({
      hash: bytes.subarray(offset, offset + 8).toString('hex'),
      seq: Number(bytes.readBigUInt64BE(offset + 8)),
    });
  return decodeWaitCursor({ jobs });
}

export function waitCursorForJobs(cursor: WaitCursor, jobIds: readonly string[]): WaitCursor;
export function waitCursorForJobs(cursor: WaitCursor | undefined, jobIds: readonly string[]): WaitCursor | undefined;
export function waitCursorForJobs(cursor: WaitCursor | undefined, jobIds: readonly string[]): WaitCursor | undefined {
  if (!cursor) return undefined;
  const hashes = new Set(jobIds.map(waitJobHash));
  return { jobs: cursor.jobs.filter((job) => hashes.has(job.hash)) };
}

export function upsertWaitCursorEntry(cursor: WaitCursor, entry: WaitCursorEntry): WaitCursor {
  const jobs = [...cursor.jobs];
  const index = jobs.findIndex((job) => job.hash === entry.hash);
  if (index === -1) jobs.push(entry);
  else jobs[index] = entry;
  return { jobs };
}
