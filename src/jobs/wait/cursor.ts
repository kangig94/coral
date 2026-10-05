import { createHash } from 'node:crypto';
import { epochIdentity, sameEpoch } from '../../store/epoch/identity.js';
import { isRecord } from '../../infra/json.js';
import type { WaitCursor, WaitCursorV3 } from './contract.js';

export function serializeWaitCursor(cursor: WaitCursor): string {
  if (cursor.version === 'jobs.wait.v3') return encodeWaitCursorV3(cursor);
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function waitCursorForJobs(cursor: WaitCursor, jobIds: readonly string[]): WaitCursor {
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
export const TAIL_PENDING_FLAG = 4;

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

function validV3(value: Record<string, unknown>): boolean {
  if (Object.keys(value).some((key) => !['version', 'epochs', 'jobs'].includes(key))) return false;
  if (
    !Array.isArray(value.epochs) ||
    !Array.isArray(value.jobs) ||
    value.epochs.length > 128 ||
    value.jobs.length > 128
  )
    return false;
  const tokens = new Set<string>();
  for (const epoch of value.epochs) {
    if (
      !isRecord(epoch) ||
      Object.keys(epoch).length !== 3 ||
      typeof epoch.token !== 'string' ||
      !/^[a-f0-9]{32}$/.test(epoch.token) ||
      tokens.has(epoch.token) ||
      !Number.isSafeInteger(epoch.watermark) ||
      (epoch.watermark as number) < 0 ||
      !Number.isInteger(epoch.lineOffset) ||
      (epoch.lineOffset as number) < 0 ||
      (epoch.lineOffset as number) > 0xffffffff
    )
      return false;
    tokens.add(epoch.token);
  }
  const hashes = new Set<string>();
  for (const job of value.jobs) {
    if (
      !isRecord(job) ||
      Object.keys(job).length !== 3 ||
      typeof job.hash !== 'string' ||
      !/^[a-f0-9]{16}$/.test(job.hash) ||
      hashes.has(job.hash) ||
      !Number.isInteger(job.epoch) ||
      (job.epoch !== UNRESOLVED_EPOCH && ((job.epoch as number) < 0 || (job.epoch as number) >= value.epochs.length)) ||
      !Number.isInteger(job.flags) ||
      (job.flags as number) < 0 ||
      (job.flags as number) > (ACKNOWLEDGED_FLAG | ARTIFACT_PENDING_FLAG | TAIL_PENDING_FLAG) ||
      (job.epoch === UNRESOLVED_EPOCH && job.flags !== 0 && job.flags !== TAIL_PENDING_FLAG) ||
      (((job.flags as number) & ARTIFACT_PENDING_FLAG) !== 0 && ((job.flags as number) & ACKNOWLEDGED_FLAG) === 0)
    )
      return false;
    hashes.add(job.hash);
  }
  return true;
}

export function encodeWaitCursorV3(cursor: WaitCursorV3): string {
  if (!validV3(cursor)) throw new Error('wait_cursor_malformed');
  const bytes = Buffer.alloc(4 + cursor.epochs.length * 28 + cursor.jobs.length * 10);
  bytes.set([3, 0, cursor.jobs.length, cursor.epochs.length]);
  let offset = 4;
  for (const epoch of cursor.epochs) {
    bytes.set(Buffer.from(epoch.token, 'hex'), offset);
    bytes.writeBigUInt64BE(BigInt(epoch.watermark), offset + 16);
    bytes.writeUInt32BE(epoch.lineOffset, offset + 24);
    offset += 28;
  }
  for (const job of cursor.jobs) {
    bytes.set(Buffer.from(job.hash, 'hex'), offset);
    bytes[offset + 8] = job.epoch;
    bytes[offset + 9] = job.flags;
    offset += 10;
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
    bytes[1] !== 0 ||
    bytes.length !== 4 + bytes[3] * 28 + bytes[2] * 10
  )
    return rejected('wait_cursor_malformed');
  const cursor: WaitCursorV3 = { version: 'jobs.wait.v3', epochs: [], jobs: [] };
  let offset = 4;
  for (let i = 0; i < bytes[3]; i++, offset += 28) {
    cursor.epochs.push({
      token: bytes.subarray(offset, offset + 16).toString('hex'),
      watermark: Number(bytes.readBigUInt64BE(offset + 16)),
      lineOffset: bytes.readUInt32BE(offset + 24),
    });
  }
  for (let i = 0; i < bytes[2]; i++, offset += 10) {
    cursor.jobs.push({
      hash: bytes.subarray(offset, offset + 8).toString('hex'),
      epoch: bytes[offset + 8],
      flags: bytes[offset + 9],
    });
  }
  return decodeWaitCursor(cursor);
}

export function filterWaitCursorV3(cursor: WaitCursorV3, jobIds: readonly string[]): WaitCursorV3 {
  const hashes = new Set(jobIds.map(waitJobHash));
  const jobs = cursor.jobs.filter((job) => hashes.has(job.hash));
  const ordinals = [...new Set(jobs.map((job) => job.epoch).filter((epoch) => epoch !== UNRESOLVED_EPOCH))];
  return {
    version: 'jobs.wait.v3',
    epochs: ordinals.map((ordinal) => ({ ...cursor.epochs[ordinal] })),
    jobs: jobs.map((job) => ({
      ...job,
      epoch: job.epoch === UNRESOLVED_EPOCH ? UNRESOLVED_EPOCH : ordinals.indexOf(job.epoch),
    })),
  };
}

/** A request's frontier belongs to the recorded member, never to a newly discovered sibling. */
export function waitReadPosition(
  request: { cursor?: WaitCursor; supportsWaitV3?: boolean; drainProgress?: boolean; lines?: number },
  jobId: string,
  epochKey: string,
): { afterSeq: number; tail?: number; limit?: number } {
  const cursor = request.cursor;
  if (cursor?.version === 'jobs.wait.v3') {
    const member = cursor.jobs.find((job) => job.hash === waitJobHash(jobId));
    if (member && (member.flags & TAIL_PENDING_FLAG) !== 0) return { afterSeq: 0, tail: request.lines ?? 20 };
    const epoch = member && member.epoch !== UNRESOLVED_EPOCH ? cursor.epochs[member.epoch] : undefined;
    return {
      afterSeq:
        epoch && epoch.token === waitEpochToken(epochKey)
          ? Math.max(0, epoch.watermark - Number(epoch.lineOffset > 0))
          : 0,
      ...(request.drainProgress ? {} : { limit: 501 }),
    };
  }
  if (cursor?.version === 'jobs.wait.v2')
    return {
      afterSeq: sameEpoch(cursor.locations[jobId], epochKey) ? (waitEpochPosition(cursor.positions, epochKey) ?? 0) : 0,
    };
  if (cursor) return { afterSeq: cursor.afterSeq };
  return request.supportsWaitV3 && !request.drainProgress
    ? { afterSeq: 0, tail: request.lines ?? 20 }
    : { afterSeq: 0 };
}
