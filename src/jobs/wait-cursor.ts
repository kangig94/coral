import { isRecord } from '../infra/json.js';
import type { WaitCursor } from './wait.js';

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
  if (value.version !== undefined && value.version !== 'jobs.wait.v2') return rejected('wait_cursor_unsupported');
  const delivered = value.deliveredJobIds;
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
      Object.keys(value).some((key) => key !== 'afterSeq' && key !== 'deliveredJobIds')
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
          !Object.hasOwn(value.positions as object, key),
      ) ||
      Object.keys(value).some((key) => !['version', 'positions', 'locations', 'deliveredJobIds'].includes(key))
    )
      return rejected('wait_cursor_malformed');
  }
  return { kind: 'decoded', cursor: value as WaitCursor };
}

export function decodeSerializedWaitCursor(raw: string): WaitCursorDecoded {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return rejected('wait_cursor_malformed');
    return decodeWaitCursor(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw, 'base64url'))),
    );
  } catch {
    return rejected('wait_cursor_malformed');
  }
}

export const WAIT_CURSOR_REPLAY_NOTICE =
  'saved cursor not accepted by this coordinator; progress and results are replayed from the start, so earlier results may repeat';
