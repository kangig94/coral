import { isAbsolute, join, normalize } from 'node:path';

import { z } from 'zod';

import { MAX_PROCESS_INCARNATION_LENGTH } from '../../../infra/node-process.js';
import type { StoragePort } from '../../../infra/port-types.js';
import type {
  ProviderProxySetDurableDispositionSkipStatus,
  ProviderProxySetOperatorDisposition,
} from '../../../provider-proxy/operator-disposition-vocabulary.js';
import { decodeProviderProxySetAddress, encodeProviderProxySetAddress } from '../../../provider-proxy/set-address.js';
import type { ProviderProxySetContainmentEvidence } from '../../../provider-proxy/containment-proof-contract.js';
import type { ProviderProxySetIdentity } from './identity.js';

export const PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION = 1;
const RECORD_KEY_PREFIX = `provider-proxy-set-operator-disposition.v${PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION}`;
const ACQUISITION_RECORD_KEY_PREFIX = `provider-proxy-set-acquisition-disposition.v${PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION}`;
const STATUS_FILENAME = `provider-proxy-set-operator-dispositions.v${PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION}.json`;
const MAX_RECORD_KEY_LENGTH = 16 * 1024;

const durableUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const durableFingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/u);
const durableProcessIncarnationSchema = z.string().min(1).max(MAX_PROCESS_INCARNATION_LENGTH);
const durableWriterIncarnationSchema = z.string().min(1).max(4096);
const durableNonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const durablePositiveSafeIntegerSchema = z.number().int().positive().safe();
const durableEndpointSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && normalize(value) === value);
const durableEnforcerObservationsSchema = z
  .tuple([
    z.object({ role: z.literal('guardian'), observation: z.enum(['alive', 'absent', 'unknown']) }).strict(),
    z.object({ role: z.literal('reaper'), observation: z.enum(['alive', 'absent', 'unknown']) }).strict(),
  ])
  .readonly();
const durableRecordedProcessSchema = z
  .object({ pid: durablePositiveSafeIntegerSchema, incarnation: durableProcessIncarnationSchema })
  .strict();
const durableContainmentEvidenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reap-required'),
      containment: z
        .object({
          pid: durablePositiveSafeIntegerSchema,
          incarnation: durableProcessIncarnationSchema,
          processGroupId: durablePositiveSafeIntegerSchema,
        })
        .strict(),
      recordedRoots: z.array(durableRecordedProcessSchema),
    })
    .strict(),
  z.object({ kind: z.literal('enforcers-observed'), observations: durableEnforcerObservationsSchema }).strict(),
  z.object({ kind: z.literal('store-unreadable') }).strict(),
]);
const durableProviderProxySetIdentitySchema = z
  .object({
    buildSetId: durableUuidSchema,
    hostFingerprint: durableFingerprintSchema,
    guardianInstanceId: durableUuidSchema,
    guardianPid: durableNonNegativeSafeIntegerSchema,
    guardianIncarnation: durableProcessIncarnationSchema,
    guardianControlEndpoint: durableEndpointSchema,
    proxyInstanceId: durableUuidSchema,
    proxyPid: durableNonNegativeSafeIntegerSchema,
    reaperInstanceId: durableUuidSchema,
    reaperPid: durableNonNegativeSafeIntegerSchema,
    reaperIncarnation: durableProcessIncarnationSchema,
    reaperControlEndpoint: durableEndpointSchema,
    containmentKind: z.string().min(1).max(64),
    proxyIncarnation: durableProcessIncarnationSchema,
    proxyProcessGroupId: durableNonNegativeSafeIntegerSchema,
    canonicalEndpoint: durableEndpointSchema,
  })
  .strict();
const durableProviderProxySetAddressSchema = z
  .object({
    buildSetId: durableUuidSchema,
    hostFingerprint: durableFingerprintSchema,
    proxyInstanceId: durableUuidSchema,
  })
  .strict();
const durableRecordedContainmentIdentitySchema = z
  .object({
    pid: durablePositiveSafeIntegerSchema,
    incarnation: durableProcessIncarnationSchema,
    processGroupId: durablePositiveSafeIntegerSchema,
  })
  .strict();
const durableGuardianAcquisitionRecoverySubjectSchema = z
  .object({
    guardianIdentity: durableRecordedContainmentIdentitySchema,
    reaper: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('not-created') }).strict(),
      z
        .object({
          kind: z.literal('recorded'),
          pid: durablePositiveSafeIntegerSchema,
          incarnation: durableProcessIncarnationSchema,
        })
        .strict(),
      z.object({ kind: z.literal('possible-unidentified') }).strict(),
    ]),
    constructionContainmentSettled: z.boolean(),
    proxy: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('not-created') }).strict(),
      z.object({ kind: z.literal('recorded'), identity: durableRecordedContainmentIdentitySchema }).strict(),
      z.object({ kind: z.literal('possible-unidentified') }).strict(),
    ]),
  })
  .strict();
const durableAcquisitionRecoverySubjectSchema = z.union([
  durableGuardianAcquisitionRecoverySubjectSchema,
  z.object({ kind: z.literal('spawned-process-group'), processGroupId: durablePositiveSafeIntegerSchema }).strict(),
  z.object({ kind: z.literal('unattributable-process-group') }).strict(),
]);
const durableOperatorDispositionSchema = z
  .object({
    disposition: z.enum(['held', 'awaiting-containment-absence', 'operator-exit-refused']),
    role: z.string().min(1).max(128).optional(),
    method: z.string().min(1).max(256).optional(),
    cause: z.enum(['closed', 'invalid-unattributable-frame']).optional(),
    attempts: z.number().int().nonnegative().safe().optional(),
    elapsedMs: z.number().nonnegative().finite().optional(),
    boundMs: z.number().nonnegative().finite().optional(),
    enforcerObservations: durableEnforcerObservationsSchema.optional(),
    incidentReason: z.string(),
    waitingFor: z.enum([
      'heartbeat-evidence-window',
      'control-reattachment',
      'independent-containment-absence',
      'ordinary-drain',
      'set-adoption-deadline',
      'operator-abandonment',
      'store-repair',
      'publication-confirmation-or-control-release',
      'containment-authorization',
      'containment-outcome-unknown',
      'heartbeat-bound-live-claims',
      'control-reattachment-bound-live-claims',
      'heartbeat-protocol-live-claims',
      'operation-control-outcome-unknown',
    ]),
  })
  .strict();
const durableCurrentWriterStatusSchema = z
  .object({ kind: z.literal('current-writer'), recordedAtMs: z.number().int().safe() })
  .strict();
const durableStaleDispositionStatusSchema = z
  .object({
    kind: z.literal('stale'),
    markedByIncarnation: durableWriterIncarnationSchema,
    markedAtMs: z.number().int().safe(),
  })
  .strict();
const durableSetDispositionStatusSchema = z.discriminatedUnion('kind', [
  durableCurrentWriterStatusSchema,
  durableStaleDispositionStatusSchema,
  z
    .object({
      kind: z.literal('successor-observed'),
      observedByIncarnation: durableWriterIncarnationSchema,
      observedAtMs: z.number().int().safe(),
      evidence: z.union([
        durableContainmentEvidenceSchema,
        z.object({ kind: z.literal('canonical-hold-observation') }).strict(),
      ]),
      reapOutcome: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('recorded-group-unattributable') }).strict(),
          z.object({ kind: z.literal('signal-authorization-refused') }).strict(),
          z.object({ kind: z.literal('identity-unobservable'), signalDelivered: z.boolean() }).strict(),
          z.object({ kind: z.literal('authorization-missing') }).strict(),
          z.object({ kind: z.literal('authorization-stale') }).strict(),
          z.object({ kind: z.literal('store-unreadable') }).strict(),
        ])
        .optional(),
    })
    .strict(),
]);
const durableAcquisitionDispositionStatusSchema = z.discriminatedUnion('kind', [
  durableCurrentWriterStatusSchema,
  durableStaleDispositionStatusSchema,
  z
    .object({
      kind: z.literal('successor-acquisition-observed'),
      observedByIncarnation: durableWriterIncarnationSchema,
      observedAtMs: z.number().int().safe(),
      observation: z.enum(['alive', 'unknown']),
    })
    .strict(),
]);
export const durableProviderProxySetOperatorDispositionRecordSchema = z
  .object({
    generation: z.literal(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION),
    scope: z.literal('set'),
    key: z.string().min(1).max(MAX_RECORD_KEY_LENGTH),
    writerIncarnation: durableWriterIncarnationSchema,
    setIdentity: durableProviderProxySetIdentitySchema,
    subjectKey: z.string().min(1).max(4096),
    disposition: durableOperatorDispositionSchema,
    status: durableSetDispositionStatusSchema,
  })
  .strict();
export const durableProviderProxySetAcquisitionDispositionRecordSchema = z
  .object({
    generation: z.literal(PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION),
    scope: z.literal('acquisition'),
    key: z.string().min(1).max(MAX_RECORD_KEY_LENGTH),
    writerIncarnation: durableWriterIncarnationSchema,
    setAddress: durableProviderProxySetAddressSchema,
    recoverySubject: durableAcquisitionRecoverySubjectSchema,
    routeKey: z.string(),
    disposition: durableOperatorDispositionSchema,
    status: durableAcquisitionDispositionStatusSchema,
  })
  .strict();
export const durableProviderProxySetOperatorDispositionFileSchema = z
  .object({ entries: z.record(z.string(), z.unknown()) })
  .passthrough();

export type DurableProviderProxySetOperatorDispositionRecord = Readonly<{
  generation: typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION;
  scope: 'set';
  key: string;
  writerIncarnation: string;
  setIdentity: ProviderProxySetIdentity;
  subjectKey: string;
  disposition: ProviderProxySetOperatorDisposition;
  status:
    | Readonly<{ kind: 'current-writer'; recordedAtMs: number }>
    | Readonly<{ kind: 'stale'; markedByIncarnation: string; markedAtMs: number }>
    | Readonly<{
        kind: 'successor-observed';
        observedByIncarnation: string;
        observedAtMs: number;
        evidence: ProviderProxySetContainmentEvidence | Readonly<{ kind: 'canonical-hold-observation' }>;
        reapOutcome?: DurableProviderProxySetContainmentHoldOutcome;
      }>;
}>;

export type DurableProviderProxySetContainmentHoldOutcome =
  | Readonly<{ kind: 'recorded-group-unattributable' }>
  | Readonly<{ kind: 'signal-authorization-refused' }>
  | Readonly<{ kind: 'identity-unobservable'; signalDelivered: boolean }>
  | Readonly<{ kind: 'authorization-missing' }>
  | Readonly<{ kind: 'authorization-stale' }>
  | Readonly<{ kind: 'store-unreadable' }>;

export type DurableProviderProxySetAcquisitionDispositionRecord = Readonly<{
  generation: typeof PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION;
  scope: 'acquisition';
  key: string;
  writerIncarnation: string;
  setAddress: ReturnType<typeof decodeProviderProxySetAddress>;
  recoverySubject: z.output<typeof durableAcquisitionRecoverySubjectSchema>;
  routeKey: string;
  disposition: ProviderProxySetOperatorDisposition;
  status:
    | Readonly<{ kind: 'current-writer'; recordedAtMs: number }>
    | Readonly<{ kind: 'stale'; markedByIncarnation: string; markedAtMs: number }>
    | Readonly<{
        kind: 'successor-acquisition-observed';
        observedByIncarnation: string;
        observedAtMs: number;
        observation: 'alive' | 'unknown';
      }>;
}>;

export type DurableProviderProxySetOperatorDispositionSkip = ProviderProxySetDurableDispositionSkipStatus;

export type DurableProviderProxySetOperatorDispositionRead = Readonly<{
  records: readonly DurableProviderProxySetOperatorDispositionRecord[];
  acquisitionRecords: readonly DurableProviderProxySetAcquisitionDispositionRecord[];
  skipped: readonly DurableProviderProxySetOperatorDispositionSkip[];
}>;

export type DurableProviderProxySetOperatorDispositionWriteResult =
  | Readonly<{ kind: 'recorded'; disposition: 'recorded' }>
  | Readonly<{
      kind: 'refused';
      disposition: 'held';
      reason: string;
      waitingFor: 'store-repair';
      exit: 'provider-proxy-set-operator-disposition-store-retry';
    }>
  | Readonly<{
      kind: 'unconfirmed';
      disposition: 'held';
      reason: string;
      waitingFor: 'store-repair';
      exit: 'provider-proxy-set-operator-disposition-store-retry';
    }>;

type DurableDispositionStorage = Pick<
  StoragePort,
  'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeAtomicDurableSync'
>;

function statusPath(runDir: string): string {
  return join(runDir, STATUS_FILENAME);
}

function setTokenFromRecordKey(key: string): string | null {
  const separator = key.indexOf(':');
  if (separator < 0) return null;
  const nextSeparator = key.indexOf(':', separator + 1);
  if (nextSeparator < 0) return null;
  const token = key.slice(separator + 1, nextSeparator);
  try {
    decodeProviderProxySetAddress(token);
    return token;
  } catch {
    return null;
  }
}

export function durableProviderProxySetOperatorDispositionKey(
  setIdentity: ProviderProxySetIdentity,
  writerIncarnation: string,
  subjectKey: string,
): string {
  const setAddress = {
    buildSetId: setIdentity.buildSetId,
    hostFingerprint: setIdentity.hostFingerprint,
    proxyInstanceId: setIdentity.proxyInstanceId,
  };
  return `${RECORD_KEY_PREFIX}:${encodeProviderProxySetAddress(setAddress)}:${writerIncarnation}:${Buffer.from(subjectKey).toString('base64url')}`;
}

export function durableProviderProxySetOperatorDispositionRecord(
  input: Readonly<{
    writerIncarnation: string;
    setIdentity: ProviderProxySetIdentity;
    subjectKey: string;
    disposition: ProviderProxySetOperatorDisposition;
    status: DurableProviderProxySetOperatorDispositionRecord['status'];
  }>,
): DurableProviderProxySetOperatorDispositionRecord {
  const record: DurableProviderProxySetOperatorDispositionRecord = {
    generation: PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION,
    scope: 'set',
    key: durableProviderProxySetOperatorDispositionKey(input.setIdentity, input.writerIncarnation, input.subjectKey),
    ...input,
  };
  durableProviderProxySetOperatorDispositionRecordSchema.parse(record);
  return record;
}

export function durableProviderProxySetAcquisitionDispositionKey(
  setAddress: ReturnType<typeof decodeProviderProxySetAddress>,
  writerIncarnation: string,
): string {
  return `${ACQUISITION_RECORD_KEY_PREFIX}:${encodeProviderProxySetAddress(setAddress)}:${writerIncarnation}`;
}

export class ProviderProxySetOperatorDispositionStore {
  readonly #storage: DurableDispositionStorage;
  readonly #runDir: string;

  constructor(storage: DurableDispositionStorage, runDir: string) {
    this.#storage = storage;
    this.#runDir = runDir;
  }

  read(): DurableProviderProxySetOperatorDispositionRead {
    const reading = this.#readEntries();
    const entries = reading.entries;
    const records: DurableProviderProxySetOperatorDispositionRecord[] = [];
    const acquisitionRecords: DurableProviderProxySetAcquisitionDispositionRecord[] = [];
    const skipped: DurableProviderProxySetOperatorDispositionSkip[] = [];
    if (!reading.writable) {
      skipped.push({
        key: `artifact:${statusPath(this.#runDir)}`,
        setToken: null,
        unavailableAction: 'reconciliation-and-retirement',
      });
    }
    for (const [key, value] of Object.entries(entries)) {
      const parsedSet = durableProviderProxySetOperatorDispositionRecordSchema.safeParse(value);
      const parsedAcquisition = durableProviderProxySetAcquisitionDispositionRecordSchema.safeParse(value);
      const parsed = parsedSet.success ? parsedSet.data : parsedAcquisition.success ? parsedAcquisition.data : null;
      const canonicalKey =
        parsed === null
          ? null
          : parsed.scope === 'set'
            ? durableProviderProxySetOperatorDispositionKey(
                parsed.setIdentity as ProviderProxySetIdentity,
                parsed.writerIncarnation,
                parsed.subjectKey,
              )
            : durableProviderProxySetAcquisitionDispositionKey(parsed.setAddress, parsed.writerIncarnation);
      if (parsed === null || parsed.key !== key || canonicalKey !== key) {
        skipped.push({ key, setToken: setTokenFromRecordKey(key), unavailableAction: 'reconciliation-and-retirement' });
        continue;
      }
      if (parsed.scope === 'set') records.push(parsed as DurableProviderProxySetOperatorDispositionRecord);
      else acquisitionRecords.push(parsed as DurableProviderProxySetAcquisitionDispositionRecord);
    }
    return { records, acquisitionRecords, skipped };
  }

  replace(
    records: readonly (
      | DurableProviderProxySetOperatorDispositionRecord
      | DurableProviderProxySetAcquisitionDispositionRecord
    )[],
    retiredKeys: readonly string[] = [],
  ): DurableProviderProxySetOperatorDispositionWriteResult {
    const reading = this.#readEntries();
    if (!reading.writable) {
      return {
        kind: 'refused',
        disposition: 'held',
        reason: 'provider_proxy_set_operator_disposition_artifact_unreadable',
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    const entries = reading.entries;
    for (const key of retiredKeys) delete entries[key];
    try {
      for (const record of records) {
        const parsed =
          record.scope === 'set'
            ? durableProviderProxySetOperatorDispositionRecordSchema.parse(record)
            : durableProviderProxySetAcquisitionDispositionRecordSchema.parse(record);
        entries[parsed.key] = parsed;
      }
    } catch (error) {
      return {
        kind: 'refused',
        disposition: 'held',
        reason: error instanceof Error ? error.message : String(error),
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    try {
      this.#storage.mkdirSync(this.#runDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return {
        kind: 'refused',
        disposition: 'held',
        reason: error instanceof Error ? error.message : String(error),
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    try {
      if (
        !this.#storage.writeAtomicDurableSync(statusPath(this.#runDir), `${JSON.stringify({ entries }, null, 2)}\n`, {
          encoding: 'utf-8',
          mode: 0o600,
        })
      ) {
        return {
          kind: 'unconfirmed',
          disposition: 'held',
          reason: 'provider_proxy_set_operator_disposition_durable_write_unconfirmed',
          waitingFor: 'store-repair',
          exit: 'provider-proxy-set-operator-disposition-store-retry',
        };
      }
    } catch (error) {
      return {
        kind: 'unconfirmed',
        disposition: 'held',
        reason: error instanceof Error ? error.message : String(error),
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    return { kind: 'recorded', disposition: 'recorded' };
  }

  #readEntries(): Readonly<{ entries: Record<string, unknown>; writable: boolean }> {
    const path = statusPath(this.#runDir);
    try {
      if (!this.#storage.existsSync(path)) return { entries: {}, writable: true };
      const parsed = durableProviderProxySetOperatorDispositionFileSchema.safeParse(
        JSON.parse(this.#storage.readFileSync(path, 'utf-8')),
      );
      return parsed.success
        ? { entries: { ...parsed.data.entries }, writable: true }
        : { entries: {}, writable: false };
    } catch {
      return { entries: {}, writable: false };
    }
  }
}
