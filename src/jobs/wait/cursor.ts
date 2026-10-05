import type { WaitAdmission } from './session.js';
import { createHash } from 'node:crypto';
import { epochIdentity, sameEpoch } from '../../store/epoch/identity.js';
import { isRecord } from '../../infra/json.js';
import type { WaitCursor, WaitCursorV3, WaitCursorEntry } from './contract.js';

export function serializeWaitCursor(cursor: WaitCursor): string {
  if (cursor.version === 'jobs.wait.v3') return encodeWaitCursorV3(cursor);
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function waitCursorForJobs(cursor: WaitCursor, jobIds: readonly string[]): WaitCursor;
export function waitCursorForJobs(cursor: WaitCursor | undefined, jobIds: readonly string[]): WaitCursor | undefined;
export function waitCursorForJobs(cursor: WaitCursor | undefined, jobIds: readonly string[]): WaitCursor | undefined {
  if (!cursor) return undefined;
  if (cursor.version === 'jobs.wait.v3') return filterWaitCursorV3(cursor, jobIds);
  const deliveredJobIds = cursor.deliveredJobIds?.filter((id) => jobIds.includes(id));
  if (cursor.version === undefined)
    return {
      ...cursor,
      ...(deliveredJobIds === undefined ? {} : { deliveredJobIds }),
      ...(cursor.admittedJobIds === undefined
        ? {}
        : { admittedJobIds: cursor.admittedJobIds.filter((id) => jobIds.includes(id)) }),
    };
  const locations = Object.fromEntries(
    jobIds.flatMap((jobId) => {
      const epochKey = cursor.locations[jobId];
      return epochKey === undefined ? [] : [[jobId, epochKey]];
    }),
  );
  const requestedEpochs = new Set(Object.values(locations));
  const positions = Object.fromEntries(
    Object.entries(cursor.positions).filter(([epochKey]) =>
      [...requestedEpochs].some((key) => sameEpoch(key, epochKey)),
    ),
  );
  return {
    version: 'jobs.wait.v2',
    locations,
    positions,
    ...(cursor.deliveredJobIds === undefined ? {} : { deliveredJobIds }),
  };
}

export type WaitCursorRejection = Readonly<{
  code: 'wait_cursor_unsupported' | 'wait_cursor_malformed';
  message: string;
}>;

export type WaitCursorDecoded =
  | Readonly<{ kind: 'decoded'; cursor: WaitCursor }>
  | Readonly<{ kind: 'rejected'; error: WaitCursorRejection }>;

function rejected(code: WaitCursorRejection['code']): WaitCursorDecoded {
  return {
    kind: 'rejected',
    error: {
      code,
      message: code === 'wait_cursor_unsupported' ? 'Unsupported wait cursor generation' : 'Malformed wait cursor',
    },
  };
}

/** Unknown generations must never be interpreted as a legacy frontier. */
export function decodeWaitCursor(value: unknown): WaitCursorDecoded {
  if (!isRecord(value)) return rejected('wait_cursor_malformed');
  if (value.version === 'jobs.wait.v3') {
    return validV3(value) ? { kind: 'decoded', cursor: value as WaitCursorV3 } : rejected('wait_cursor_malformed');
  }
  if (value.version !== undefined && value.version !== 'jobs.wait.v2') return rejected('wait_cursor_unsupported');
  const delivered = value.deliveredJobIds;
  const admitted = value.admittedJobIds;
  if (
    admitted !== undefined &&
    (!Array.isArray(admitted) ||
      admitted.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(admitted).size !== admitted.length)
  )
    return rejected('wait_cursor_malformed');
  if (
    delivered !== undefined &&
    (!Array.isArray(delivered) ||
      delivered.some((id) => typeof id !== 'string' || id.length === 0) ||
      new Set(delivered).size !== delivered.length)
  )
    return rejected('wait_cursor_malformed');
  if (value.version === undefined) {
    if (
      !Number.isSafeInteger(value.afterSeq) ||
      (value.afterSeq as number) < 0 ||
      Object.keys(value).some((key) => key !== 'afterSeq' && key !== 'deliveredJobIds' && key !== 'admittedJobIds')
    )
      return rejected('wait_cursor_malformed');
  } else {
    if (
      !isRecord(value.positions) ||
      !isRecord(value.locations) ||
      Object.entries(value.positions).some(
        ([key, seq]) => key.length === 0 || !Number.isSafeInteger(seq) || (seq as number) < 0,
      ) ||
      Object.entries(value.locations).some(
        ([id, key]) =>
          id.length === 0 ||
          typeof key !== 'string' ||
          key.length === 0 ||
          !Object.keys(value.positions as object).some((positionKey) => sameEpoch(positionKey, key)),
      ) ||
      Object.keys(value).some((key) => !['version', 'positions', 'locations', 'deliveredJobIds'].includes(key))
    )
      return rejected('wait_cursor_malformed');
  }
  return { kind: 'decoded', cursor: value as WaitCursor };
}

export function decodeSerializedWaitCursor(raw: string): WaitCursorDecoded {
  try {
    if (raw.startsWith('jobs.wait.v3:')) return decodeBinaryV3(raw);
    if (raw.startsWith('jobs.wait.')) return rejected('wait_cursor_unsupported');
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return rejected('wait_cursor_malformed');
    return decodeWaitCursor(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'base64url'))),
    );
  } catch {
    return rejected('wait_cursor_malformed');
  }
}

export const WAIT_CURSOR_REPLAY_NOTICE =
  'saved cursor not accepted by this coordinator; the current progress tail and retained results are collected again, so earlier results may repeat';

export const ACKNOWLEDGED_FLAG = 1;
export const ARTIFACT_PENDING_FLAG = 2;
export const UNPOSITIONED_FLAG = 4;

const V3_PREFIX = 'jobs.wait.v3:';
const MAX_CURSOR_BYTES = 8192;
export const UNRESOLVED_EPOCH = 0xff;

/** Tokens identify accepted locations; they cannot reconstruct filesystem paths. */
export function waitEpochPosition(positions: Record<string, number>, epochKey: string): number | undefined {
  const matches = Object.entries(positions).filter(([key]) => sameEpoch(key, epochKey));
  return matches.length ? Math.max(...matches.map(([, seq]) => seq)) : undefined;
}

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

function validV3(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === 2 &&
    Array.isArray(value.jobs) &&
    value.jobs.length <= 128 &&
    value.jobs.every(validEntry) &&
    new Set(value.jobs.map((job) => job.hash)).size === value.jobs.length
  );
}

export function encodeWaitCursorV3(cursor: WaitCursorV3): string {
  if (!validV3(cursor)) throw new Error('wait_cursor_malformed');
  const epochs = [...new Set(cursor.jobs.flatMap((job) => (job.epoch === null ? [] : [job.epoch])))];
  const bytes = Buffer.alloc(4 + epochs.length * 16 + cursor.jobs.length * 22);
  bytes.set([3, 1, cursor.jobs.length, epochs.length]);
  let offset = 4;
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
  const encoded = V3_PREFIX + bytes.toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_CURSOR_BYTES) throw new Error('wait_cursor_malformed');
  return encoded;
}

function decodeBinaryV3(raw: string): WaitCursorDecoded {
  const encoded = raw.slice(V3_PREFIX.length);
  if (Buffer.byteLength(raw) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(encoded))
    return rejected('wait_cursor_malformed');
  const bytes = Buffer.from(encoded, 'base64url');
  if (
    bytes.toString('base64url') !== encoded ||
    bytes.length < 4 ||
    bytes[0] !== 3 ||
    bytes[1] !== 1 ||
    bytes[2] > 128 ||
    bytes[3] > 128 ||
    bytes.length !== 4 + bytes[3] * 16 + bytes[2] * 22
  )
    return rejected('wait_cursor_malformed');
  const epochs: string[] = [];
  let offset = 4;
  for (let i = 0; i < bytes[3]; i++, offset += 16) epochs.push(bytes.subarray(offset, offset + 16).toString('hex'));
  if (new Set(epochs).size !== epochs.length) return rejected('wait_cursor_malformed');
  const jobs: WaitCursorEntry[] = [];
  for (let i = 0; i < bytes[2]; i++, offset += 22) {
    const ordinal = bytes[offset + 8];
    if (ordinal !== UNRESOLVED_EPOCH && ordinal >= epochs.length) return rejected('wait_cursor_malformed');
    jobs.push({
      hash: bytes.subarray(offset, offset + 8).toString('hex'),
      epoch: ordinal === UNRESOLVED_EPOCH ? null : epochs[ordinal],
      flags: bytes[offset + 9],
      seq: Number(bytes.readBigUInt64BE(offset + 10)),
      lineOffset: bytes.readUInt32BE(offset + 18),
    });
  }
  return decodeWaitCursor({ version: 'jobs.wait.v3', jobs });
}

export function filterWaitCursorV3(cursor: WaitCursorV3, jobIds: readonly string[]): WaitCursorV3 {
  const hashes = new Set(jobIds.map(waitJobHash));
  return { version: 'jobs.wait.v3', jobs: cursor.jobs.filter((job) => hashes.has(job.hash)) };
}

export function upsertWaitCursorEntry(cursor: WaitCursor | undefined, entry: WaitCursorEntry): WaitCursorV3 {
  const jobs = cursor?.version === 'jobs.wait.v3' ? [...cursor.jobs] : [];
  const index = jobs.findIndex((job) => job.hash === entry.hash);
  if (index === -1) jobs.push(entry);
  else jobs[index] = entry;
  return { version: 'jobs.wait.v3', jobs };
}

export function legacyWaitEntries(
  cursor: WaitCursor | undefined,
  admissions: readonly WaitAdmission[],
  activeEpochKey?: string,
): WaitCursorEntry[] {
  return admissions.map((job) => {
    const hash = waitJobHash(job.jobId);
    const epoch = job.epochKey ? waitEpochToken(job.epochKey) : null;
    if (cursor?.version === 'jobs.wait.v3') {
      const saved = cursor.jobs.find((entry) => entry.hash === hash);
      if (saved) return saved;
    } else if (epoch !== null && cursor) {
      const known =
        cursor.version === 'jobs.wait.v2'
          ? sameEpoch(cursor.locations[job.jobId], job.epochKey)
          : sameEpoch(job.epochKey, activeEpochKey) &&
            (cursor.admittedJobIds === undefined || cursor.admittedJobIds.includes(job.jobId));
      if (known)
        return {
          hash,
          epoch,
          seq:
            cursor.version === 'jobs.wait.v2'
              ? (waitEpochPosition(cursor.positions, job.epochKey as string) ?? 0)
              : cursor.afterSeq,
          lineOffset: 0,
          flags: cursor.deliveredJobIds?.includes(job.jobId)
            ? ACKNOWLEDGED_FLAG | (job.availability?.kind === 'repair-pending' ? ARTIFACT_PENDING_FLAG : 0)
            : 0,
        };
    }
    return { hash, epoch, seq: 0, lineOffset: 0, flags: UNPOSITIONED_FLAG };
  });
}
