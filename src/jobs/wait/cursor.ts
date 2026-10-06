import type { WaitAdmission } from './session.js';
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

export const ACKNOWLEDGED_FLAG = 1;
export const ARTIFACT_PENDING_FLAG = 2;
export const UNPOSITIONED_FLAG = 4;

const MAX_JOBS = 128;
const MAX_CURSOR_BYTES = 8192;
const UNRESOLVED_EPOCH = 0xff;

/** Tokens identify accepted locations; they cannot reconstruct filesystem paths. */
export function waitEpochToken(epochKey: string): string {
  return createHash('sha256').update(epochIdentity(epochKey)).digest().subarray(0, 16).toString('hex');
}

export function waitJobHash(jobId: string): string {
  return createHash('sha256').update(jobId).digest().subarray(0, 8).toString('hex');
}

function validEntry(value: unknown): value is WaitCursorEntry {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false;
  const { hash, epoch, seq, lineOffset, flags } = value;
  return (
    typeof hash === 'string' &&
    /^[a-f0-9]{16}$/.test(hash) &&
    (epoch === null || (typeof epoch === 'string' && /^[a-f0-9]{32}$/.test(epoch))) &&
    Number.isSafeInteger(seq) &&
    (seq as number) >= 0 &&
    Number.isInteger(lineOffset) &&
    (lineOffset as number) >= 0 &&
    (lineOffset as number) <= 0xffffffff &&
    Number.isInteger(flags) &&
    (flags as number) >= 0 &&
    (flags as number) <= 7 &&
    (epoch !== null || flags === UNPOSITIONED_FLAG) &&
    (((flags as number) & UNPOSITIONED_FLAG) === 0 || (seq === 0 && lineOffset === 0)) &&
    (((flags as number) & ARTIFACT_PENDING_FLAG) === 0 || ((flags as number) & ACKNOWLEDGED_FLAG) !== 0)
  );
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

/** Layout: job count, epoch count, 16-byte epoch tokens, then per job hash, epoch ordinal, flags, seq u64, offset u32. */
export function serializeWaitCursor(cursor: WaitCursor): string {
  if (decodeWaitCursor(cursor).kind !== 'decoded') throw new Error('wait_cursor_malformed');
  const epochs = [...new Set(cursor.jobs.flatMap((job) => (job.epoch === null ? [] : [job.epoch])))];
  const bytes = Buffer.alloc(2 + epochs.length * 16 + cursor.jobs.length * 22);
  bytes.set([cursor.jobs.length, epochs.length]);
  let offset = 2;
  for (const epoch of epochs) {
    bytes.set(Buffer.from(epoch, 'hex'), offset);
    offset += 16;
  }
  for (const job of cursor.jobs) {
    bytes.set(Buffer.from(job.hash, 'hex'), offset);
    bytes[offset + 8] = job.epoch === null ? UNRESOLVED_EPOCH : epochs.indexOf(job.epoch);
    bytes[offset + 9] = job.flags;
    bytes.writeBigUInt64BE(BigInt(job.seq), offset + 10);
    bytes.writeUInt32BE(job.lineOffset, offset + 18);
    offset += 22;
  }
  return bytes.toString('base64url');
}

export function decodeSerializedWaitCursor(raw: string): WaitCursorDecoded {
  if (Buffer.byteLength(raw) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(raw)) return REJECTED;
  const bytes = Buffer.from(raw, 'base64url');
  if (
    bytes.toString('base64url') !== raw ||
    bytes.length < 2 ||
    bytes[0] > MAX_JOBS ||
    bytes[1] > MAX_JOBS ||
    bytes.length !== 2 + bytes[1] * 16 + bytes[0] * 22
  )
    return REJECTED;
  const epochs: string[] = [];
  let offset = 2;
  for (let i = 0; i < bytes[1]; i++, offset += 16) epochs.push(bytes.subarray(offset, offset + 16).toString('hex'));
  if (new Set(epochs).size !== epochs.length) return REJECTED;
  const jobs: WaitCursorEntry[] = [];
  for (let i = 0; i < bytes[0]; i++, offset += 22) {
    const ordinal = bytes[offset + 8];
    if (ordinal !== UNRESOLVED_EPOCH && ordinal >= epochs.length) return REJECTED;
    jobs.push({
      hash: bytes.subarray(offset, offset + 8).toString('hex'),
      epoch: ordinal === UNRESOLVED_EPOCH ? null : epochs[ordinal],
      flags: bytes[offset + 9],
      seq: Number(bytes.readBigUInt64BE(offset + 10)),
      lineOffset: bytes.readUInt32BE(offset + 18),
    });
  }
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

/** A job the cursor does not name starts unpositioned, so it receives its own tail on its first readable visit. */
export function waitCursorEntry(cursor: WaitCursor | undefined, job: WaitAdmission): WaitCursorEntry {
  const hash = waitJobHash(job.jobId);
  return (
    cursor?.jobs.find((entry) => entry.hash === hash) ?? {
      hash,
      epoch: job.epochKey ? waitEpochToken(job.epochKey) : null,
      seq: 0,
      lineOffset: 0,
      flags: UNPOSITIONED_FLAG,
    }
  );
}
