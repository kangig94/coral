import { dirname, join } from 'node:path';

import type { StoragePort } from './port-types.js';
import { isNoEntryError } from './fs-errors.js';

export type AbandonedRequestStatus = Readonly<{
  recordId: string;
  method: string;
  requestId: string;
  startedAt: string;
  outcome: 'continuing' | 'completed' | 'failed' | 'cancelled';
  identity?: Readonly<{ jobId?: string; operationId?: string }>;
}>;

export type AbandonedRequestStatusRead =
  | Readonly<{ kind: 'found'; status: AbandonedRequestStatus }>
  | Readonly<{ kind: 'missing' | 'unreadable' | 'invalid-id' }>;

const RETAINED_TERMINAL_RECORDS = 256;

function statusPath(runDir: string, recordId: string): string {
  return join(runDir, 'abandoned-requests.v1', `${recordId}.json`);
}

export function validAbandonedRequestRecordId(recordId: string): boolean {
  return /^[a-zA-Z0-9-]{1,100}$/.test(recordId);
}

export function readAbandonedRequestStatus(
  storage: StoragePort,
  runDir: string,
  recordId: string,
): AbandonedRequestStatusRead {
  if (!validAbandonedRequestRecordId(recordId)) return { kind: 'invalid-id' };
  let raw: string;
  try {
    raw = storage.readFileSync(statusPath(runDir, recordId), 'utf-8');
  } catch (error: unknown) {
    return { kind: isNoEntryError(error) ? 'missing' : 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('recordId' in parsed) ||
      parsed.recordId !== recordId ||
      !('method' in parsed) ||
      typeof parsed.method !== 'string' ||
      !('requestId' in parsed) ||
      typeof parsed.requestId !== 'string' ||
      !('startedAt' in parsed) ||
      typeof parsed.startedAt !== 'string' ||
      !('outcome' in parsed) ||
      !['continuing', 'completed', 'failed', 'cancelled'].includes(String(parsed.outcome))
    )
      return { kind: 'unreadable' };
    return { kind: 'found', status: parsed as AbandonedRequestStatus };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function writeAbandonedRequestStatus(
  storage: StoragePort,
  runDir: string,
  request: AbandonedRequestStatus,
): void {
  if (!validAbandonedRequestRecordId(request.recordId)) throw new Error('Invalid abandoned request record ID');
  const path = statusPath(runDir, request.recordId);
  storage.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!storage.writeAtomicDurableSync(path, `${JSON.stringify({ version: 1, ...request })}\n`, { mode: 0o600 }))
    throw new Error('Abandoned request status could not be recorded');
  if (request.outcome === 'continuing') return;
  const directory = dirname(path);
  const terminal = storage
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const id = name.slice(0, -'.json'.length);
      const result = readAbandonedRequestStatus(storage, runDir, id);
      if (result.kind !== 'found' || result.status.outcome === 'continuing') return [];
      return [{ name, modifiedAt: storage.statSync(join(directory, name)).mtimeMs }];
    })
    .sort((left, right) => left.modifiedAt - right.modifiedAt || left.name.localeCompare(right.name));
  for (const record of terminal.slice(0, Math.max(0, terminal.length - RETAINED_TERMINAL_RECORDS)))
    storage.unlinkSync(join(directory, record.name));
}
