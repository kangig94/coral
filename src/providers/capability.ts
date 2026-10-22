import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { recordedProcessIdentitySchema, type RecordedProcessIdentity } from '../infra/process-containment.js';

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

const activeIssuers = new Map<string, Promise<DiscardOutcome>>();
const stoppedIssuers = new Set<string>();

export function managed<Access extends ProviderAccess>(
  impl: Pick<ProviderManagedArtifactCapability<Access>, 'discardArtifacts' | 'locateArtifact'> &
    Partial<Pick<ProviderManagedArtifactCapability<Access>, 'reconcileDiscard' | 'discardResidue'>>,
): ProviderManagedArtifactCapability<Access> {
  return {
    kind: 'managed',
    protocol: PROVIDER_ARTIFACT_DISCARD_PROTOCOL,
    discardArtifacts: async options => {
      const key = actionRecordPath(options);
      const active = activeIssuers.get(key);
      if (active !== undefined) return active;
      const recorded = readActionRecord(options);
      if (recorded !== null) {
        assertActionPayload(recorded, options.actionId, options.payloadHash);
        const result = await reconcileProviderArtifactDiscard(options);
        if (result.kind === 'applied') return result.outcome;
        throw new ProviderArtifactDefinitiveFailure(result.kind === 'definitive-failure'
          ? result.reason : 'Discard action already issued; removal evidence is unknown.');
      }
      const pid = options.runtime.env.pid();
      const incarnation = options.runtime.process.readProcessIncarnation(pid, options.runtime.env.platform() as NodeJS.Platform);
      if (incarnation === null) throw new ProviderArtifactDefinitiveFailure('Discard issuer identity is unavailable; native artifacts kept.');
      writeActionRecord(options, { kind: 'pending' }, undefined, { issuer: { pid, incarnation }, issuerStopped: false });
      const task = (async () => {
        let providerFailure: unknown;
        if (options.handles.length > 0) {
          try { await impl.discardArtifacts(options); } catch (error: unknown) { providerFailure = error; }
        }
        stoppedIssuers.add(key);
        writeActionRecord(options, { kind: 'pending' }, undefined, { issuer: { pid, incarnation }, issuerStopped: true });
        const result = reconcileAction(options, readActionRecord(options));
        if (result.kind === 'applied') return result.outcome;
        if (result.kind === 'definitive-failure') throw new ProviderArtifactDefinitiveFailure(result.reason);
        throw providerFailure ?? new Error('Discard removal evidence is unknown.');
      })();
      activeIssuers.set(key, task);
      try { return await task; } finally { activeIssuers.delete(key); }
    },
    reconcileDiscard: async options => {
      return reconcileProviderArtifactDiscard(options);
    },
    ...(impl.locateArtifact !== undefined ? { locateArtifact: impl.locateArtifact } : {}),
    ...(impl.discardResidue !== undefined ? { discardResidue: impl.discardResidue } : {}),
  };
}

type ArtifactActionOptions = Pick<Parameters<ProviderManagedArtifactCapability['discardArtifacts']>[0],
  'handles' | 'actionId' | 'payloadHash' | 'runtime'>;

const observationsSchema = z.object({
  present: z.array(z.string()), absent: z.array(z.string()), unknown: z.array(z.string()),
}).strict();
const discardOutcomeSchema = z.object({
  kind: z.enum(['discarded', 'skipped_no_handles', 'provider_declares_none']),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();
const actionRecordSchema = z.object({
  v: z.literal(1), actionId: z.string().min(1), payloadHash: z.string().min(1),
  issuer: recordedProcessIdentitySchema.nullable(), issuerStopped: z.boolean(),
  observations: observationsSchema.optional(),
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pending') }).strict(),
    z.object({ kind: z.literal('applied'), outcome: discardOutcomeSchema }).strict(),
    z.object({ kind: z.literal('definitive-failure'), reason: z.string() }).strict(),
  ]),
}).strict();
type ArtifactActionRecord = z.infer<typeof actionRecordSchema>;
type ArtifactObservations = z.infer<typeof observationsSchema>;

export function providerArtifactDiscardWasIssued(options: ArtifactActionOptions): boolean {
  const record = readActionRecord(options);
  if (record !== null) assertActionPayload(record, options.actionId, options.payloadHash);
  return record !== null;
}

async function issuerHasStopped(options: ArtifactActionOptions, record: ArtifactActionRecord): Promise<boolean> {
  if (record.issuerStopped || record.issuer === null || stoppedIssuers.has(actionRecordPath(options))) return true;
  const observations = await options.runtime.process.observeProcessIdentities([record.issuer], 2_000);
  const observed = observations.find(item => item.owner.pid === record.issuer!.pid && item.owner.incarnation === record.issuer!.incarnation);
  return observed?.evidence.kind === 'pid-absent' ||
    (observed?.evidence.kind === 'incarnation' && observed.evidence.incarnation !== record.issuer.incarnation);
}

export async function reconcileProviderArtifactDiscard(options: ArtifactActionOptions): Promise<ProviderArtifactDiscardReconciliation> {
  const recorded = readActionRecord(options);
  if (recorded !== null) assertActionPayload(recorded, options.actionId, options.payloadHash);
  if (activeIssuers.has(actionRecordPath(options))) return { kind: 'unknown' };
  if (recorded !== null && !(await issuerHasStopped(options, recorded))) return { kind: 'unknown' };
  return reconcileAction(options, recorded);
}

function observeHandles(handles: readonly string[], runtime: ArtifactCleanupRuntime): ArtifactObservations {
  const observations: ArtifactObservations = { present: [], absent: [], unknown: [] };
  for (const handle of handles) {
    try { runtime.storage.lstatSync(handle); observations.present.push(handle); } catch (error: unknown) {
      observations[(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'].push(handle);
    }
  }
  return observations;
}

function reconcileAction(options: ArtifactActionOptions, record: ArtifactActionRecord | null): ProviderArtifactDiscardReconciliation {
  if (record === null) return { kind: 'not-applied' };
  if (record.state.kind === 'definitive-failure') return record.state;
  const observations = observeHandles(options.handles, options.runtime);
  if (observations.unknown.length > 0) {
    writeActionRecord(options, { kind: 'pending' }, observations);
    return { kind: 'unknown' };
  }
  if (observations.present.length > 0) {
    const reason = `Native removal failed: ${JSON.stringify(observations)}`;
    writeActionRecord(options, { kind: 'definitive-failure', reason }, observations);
    return { kind: 'definitive-failure', reason };
  }
  const outcome: DiscardOutcome = { kind: options.handles.length === 0 ? 'skipped_no_handles' : 'discarded', details: observations };
  writeActionRecord(options, { kind: 'applied', outcome }, observations);
  return { kind: 'applied', outcome };
}

export async function sealProviderArtifactDiscard(options: ArtifactActionOptions, reason: string): Promise<void> {
  if (activeIssuers.has(actionRecordPath(options))) throw new Error('Cannot seal a live discard issuer.');
  const recorded = readActionRecord(options);
  if (recorded !== null) {
    assertActionPayload(recorded, options.actionId, options.payloadHash);
    if (!(await issuerHasStopped(options, recorded))) throw new Error('Discard issuer has not been proven stopped.');
    if (recorded.state.kind === 'definitive-failure') {
      writeActionRecord(options, recorded.state, recorded.observations);
      return;
    }
  }
  writeActionRecord(options, { kind: 'definitive-failure', reason }, recorded?.observations ?? {
    present: [], absent: [], unknown: [...options.handles],
  });
}

function actionRecordPath(options: ArtifactActionOptions): string {
  const file = createHash('sha256').update(options.actionId, 'utf8').digest('hex');
  return join(options.runtime.paths.coral.exports.jobsRoot, '.provider-artifact-discard', `${file}.json`);
}

function readActionRecord(options: ArtifactActionOptions): ArtifactActionRecord | null {
  const path = actionRecordPath(options);
  try {
    return actionRecordSchema.parse(JSON.parse(options.runtime.storage.readFileSync(path, 'utf-8')) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProviderArtifactProtocolInvariantError(`Unreadable provider artifact action '${path}': ${String(error)}`);
  }
}

function assertActionPayload(record: ArtifactActionRecord, actionId: string, payloadHash: string): void {
  if (record.actionId !== actionId || record.payloadHash !== payloadHash) {
    throw new ProviderArtifactProtocolInvariantError(`Provider artifact action '${actionId}' was reused with a conflicting payload.`);
  }
}

function writeActionRecord(
  options: ArtifactActionOptions,
  state: ArtifactActionRecord['state'],
  observations?: ArtifactObservations,
  ownership?: { readonly issuer: RecordedProcessIdentity | null; readonly issuerStopped: boolean },
): void {
  const path = actionRecordPath(options);
  const previous = readActionRecord(options);
  options.runtime.storage.mkdirSync(join(path, '..'), { recursive: true });
  if (!options.runtime.storage.syncDirectoryDurableSync(join(path, '../..'))) {
    throw new Error(`Provider artifact ledger directory durability is unknown for '${options.actionId}'.`);
  }
  const record = actionRecordSchema.parse({ v: 1, actionId: options.actionId, payloadHash: options.payloadHash, state,
    issuer: ownership?.issuer ?? previous?.issuer ?? null,
    issuerStopped: ownership?.issuerStopped ?? (state.kind !== 'pending' || stoppedIssuers.has(path) || previous?.issuerStopped === true),
    ...(observations === undefined ? {} : { observations }) });
  if (!options.runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })) {
    throw new Error(`Failed to persist provider artifact action '${options.actionId}'.`);
  }
  if (record.issuerStopped) stoppedIssuers.delete(path);
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
  if (handles.length === 0) return { kind: 'skipped_no_handles' };
  let observations: ArtifactObservations = { present: [], absent: [], unknown: [] };
  for (let attempt = 1; attempt <= FINAL_UNLINK_ATTEMPTS; attempt++) {
    for (const handle of handles) {
      try { runtime.storage.unlinkSync(handle); } catch { /* Removal is decided by observation. */ }
    }
    observations = observeHandles(handles, runtime);
    if (observations.present.length === 0 && observations.unknown.length === 0) return { kind: 'discarded', details: observations };
    if (attempt < FINAL_UNLINK_ATTEMPTS) await runtime.time.sleep(FINAL_UNLINK_SETTLE_MS);
  }
  if (observations.unknown.length > 0) throw new Error(`Native removal is unknown: ${JSON.stringify(observations)}`);
  throw new ProviderArtifactDefinitiveFailure(`Native removal failed: ${JSON.stringify(observations)}`);
}

export function reconcileRecordedArtifactDiscard(
  handles: readonly ProviderArtifactHandle[],
  runtime: ArtifactCleanupRuntime,
): ProviderArtifactDiscardReconciliation {
  const observations = observeHandles(handles, runtime);
  if (observations.unknown.length > 0) return { kind: 'unknown' };
  if (observations.present.length > 0) return { kind: 'not-applied' };
  return { kind: 'applied', outcome: { kind: handles.length === 0 ? 'skipped_no_handles' : 'discarded', details: observations } };
}
