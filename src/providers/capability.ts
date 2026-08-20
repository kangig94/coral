import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type {
  ArtifactCleanupRuntime,
  DiscardOutcome,
  ProviderArtifactHandle,
  ProviderManagedArtifactCapability,
  ProviderNoArtifactCapability,
  ProviderAccess,
} from './contract.js';
import {
  PROVIDER_ARTIFACT_DISCARD_PROTOCOL,
  ProviderArtifactDefinitiveFailure,
  ProviderArtifactProtocolInvariantError,
  type ProviderArtifactDiscardReconciliation,
} from './contract.js';

const FINAL_UNLINK_ATTEMPTS = 6;
const FINAL_UNLINK_SETTLE_MS = 500;

export function managed<Access extends ProviderAccess>(
  impl: Pick<ProviderManagedArtifactCapability<Access>, 'discardArtifacts' | 'locateArtifact'> &
    Partial<Pick<ProviderManagedArtifactCapability<Access>, 'reconcileDiscard'>>,
): ProviderManagedArtifactCapability<Access> {
  return {
    kind: 'managed',
    protocol: PROVIDER_ARTIFACT_DISCARD_PROTOCOL,
    discardArtifacts: async (options) => {
      const recorded = readActionRecord(options);
      if (recorded !== null) {
        assertActionPayload(recorded, options.actionId, options.payloadHash);
        if (recorded.kind === 'applied') return recorded.outcome;
        if (recorded.kind === 'definitive-failure') {
          throw new ProviderArtifactDefinitiveFailure(recorded.reason);
        }
      } else {
        writeActionRecord(options, { kind: 'pending' });
      }
      try {
        const outcome = await impl.discardArtifacts(options);
        writeActionRecord(options, { kind: 'applied', outcome });
        return outcome;
      } catch (error: unknown) {
        if (error instanceof ProviderArtifactDefinitiveFailure) {
          writeActionRecord(options, { kind: 'definitive-failure', reason: error.message });
        }
        throw error;
      }
    },
    reconcileDiscard: async (options) => {
      const recorded = readActionRecord(options);
      if (recorded !== null) {
        assertActionPayload(recorded, options.actionId, options.payloadHash);
        if (recorded.kind === 'applied') return { kind: 'applied', outcome: recorded.outcome };
        if (recorded.kind === 'definitive-failure') {
          return { kind: 'definitive-failure', reason: recorded.reason };
        }
        if (impl.reconcileDiscard !== undefined) {
          const reconciled = await impl.reconcileDiscard(options);
          if (reconciled.kind === 'applied') {
            writeActionRecord(options, { kind: 'applied', outcome: reconciled.outcome });
          } else if (reconciled.kind === 'definitive-failure') {
            writeActionRecord(options, { kind: 'definitive-failure', reason: reconciled.reason });
          }
          return reconciled;
        }
        if (options.handles.length === 0 || options.handles.some((handle) => safeExists(handle, options.runtime))) {
          return { kind: 'not-applied' };
        }
        const outcome: DiscardOutcome = { kind: 'discarded' };
        writeActionRecord(options, { kind: 'applied', outcome });
        return { kind: 'applied', outcome };
      }
      return { kind: 'not-applied' };
    },
    ...(impl.locateArtifact !== undefined ? { locateArtifact: impl.locateArtifact } : {}),
  };
}

type ArtifactActionOptions = Parameters<ProviderManagedArtifactCapability['discardArtifacts']>[0];

type ArtifactActionRecord = {
  readonly v: 1;
  readonly actionId: string;
  readonly payloadHash: string;
} & (
  | { readonly kind: 'pending' }
  | { readonly kind: 'applied'; readonly outcome: DiscardOutcome }
  | { readonly kind: 'definitive-failure'; readonly reason: string }
);

function actionRecordPath(options: ArtifactActionOptions): string {
  const file = createHash('sha256').update(options.actionId, 'utf8').digest('hex');
  return join(options.runtime.paths.coral.exports.jobsRoot, '.provider-artifact-discard', `${file}.json`);
}

function readActionRecord(options: ArtifactActionOptions): ArtifactActionRecord | null {
  const path = actionRecordPath(options);
  try {
    const parsed = JSON.parse(options.runtime.storage.readFileSync(path, 'utf-8')) as Partial<ArtifactActionRecord>;
    if (
      parsed.v !== 1 ||
      typeof parsed.actionId !== 'string' ||
      typeof parsed.payloadHash !== 'string' ||
      (parsed.kind !== 'pending' && parsed.kind !== 'applied' && parsed.kind !== 'definitive-failure')
    ) {
      throw new ProviderArtifactProtocolInvariantError(`Malformed provider artifact action record '${path}'.`);
    }
    if (parsed.kind === 'applied') {
      if (typeof parsed.outcome !== 'object' || parsed.outcome === null || typeof parsed.outcome.kind !== 'string') {
        throw new ProviderArtifactProtocolInvariantError(`Malformed applied provider artifact action '${path}'.`);
      }
      return parsed as ArtifactActionRecord;
    }
    if (parsed.kind === 'pending') return parsed as ArtifactActionRecord;
    const failed = parsed as Partial<Extract<ArtifactActionRecord, { kind: 'definitive-failure' }>>;
    if (typeof failed.reason !== 'string') {
      throw new ProviderArtifactProtocolInvariantError(`Malformed failed provider artifact action '${path}'.`);
    }
    return failed as ArtifactActionRecord;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertActionPayload(record: ArtifactActionRecord, actionId: string, payloadHash: string): void {
  if (record.actionId !== actionId || record.payloadHash !== payloadHash) {
    throw new ProviderArtifactProtocolInvariantError(
      `Provider artifact action '${actionId}' was reused with a conflicting payload.`,
    );
  }
}

function writeActionRecord(
  options: ArtifactActionOptions,
  outcome:
    | { readonly kind: 'pending' }
    | { readonly kind: 'applied'; readonly outcome: DiscardOutcome }
    | { readonly kind: 'definitive-failure'; readonly reason: string },
): void {
  const path = actionRecordPath(options);
  options.runtime.storage.mkdirSync(join(path, '..'), { recursive: true });
  const record: ArtifactActionRecord = {
    v: 1,
    actionId: options.actionId,
    payloadHash: options.payloadHash,
    ...outcome,
  };
  if (
    !options.runtime.storage.writeAtomicSync(path, `${JSON.stringify(record)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  ) {
    throw new Error(`Failed to persist provider artifact action '${options.actionId}'.`);
  }
}

export function none(reason: string): ProviderNoArtifactCapability {
  return {
    kind: 'none',
    reason,
  };
}

export async function discardRecordedArtifacts(
  handles: readonly ProviderArtifactHandle[],
  runtime: ArtifactCleanupRuntime,
): Promise<DiscardOutcome> {
  if (handles.length === 0) {
    return { kind: 'skipped_no_handles' };
  }
  for (let attempt = 1; attempt <= FINAL_UNLINK_ATTEMPTS; attempt += 1) {
    unlinkAll(handles, runtime);
    if (attempt === FINAL_UNLINK_ATTEMPTS) {
      break;
    }
    await runtime.time.sleep(FINAL_UNLINK_SETTLE_MS);
    if (!handles.some((handle) => safeExists(handle, runtime))) {
      break;
    }
  }
  return { kind: 'discarded' };
}

export function reconcileRecordedArtifactDiscard(
  handles: readonly ProviderArtifactHandle[],
  runtime: ArtifactCleanupRuntime,
): ProviderArtifactDiscardReconciliation {
  if (handles.length === 0) {
    return { kind: 'applied', outcome: { kind: 'skipped_no_handles' } };
  }
  return handles.some((handle) => safeExists(handle, runtime))
    ? { kind: 'not-applied' }
    : { kind: 'applied', outcome: { kind: 'discarded' } };
}

function unlinkAll(handles: readonly ProviderArtifactHandle[], runtime: ArtifactCleanupRuntime): void {
  for (const handle of handles) {
    try {
      runtime.storage.unlinkSync(handle);
    } catch {
      /* best-effort */
    }
  }
}

function safeExists(handle: ProviderArtifactHandle, runtime: ArtifactCleanupRuntime): boolean {
  try {
    return runtime.storage.existsSync(handle);
  } catch {
    return false;
  }
}
