import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

/**
 * W2.3's committed locator: the coordinator's durable proof that guardian, reaper, and proxy agreed on one
 * provider root before any semantic kernel started. This is ordinary key/value `meta` (`src/store/schema.sql`),
 * never DDL, never an event-body codec, and never registered in `PersistedCodecRegistry` — the value is a
 * runtime fact about a live process set, not domain history.
 *
 * The identifier-shape primitives below (canonical UUID, host fingerprint, canonical endpoint path) duplicate
 * the ones `src/provider-proxy/protocol.ts` defines for the W2 control protocol. They are re-derived rather
 * than imported: `src/jobs/` is a domain root and `src/provider-proxy/` is a sibling domain root spawned into
 * its own process, so a jobs module reaching into it for generic identifier shape would make the jobs domain
 * depend on a process it must stay meaningful without. Duplicating three regexes is cheaper than that edge.
 */

const MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES = 4096;

const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hostFingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
// Capped well under MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES: a per-field max at (or near) the whole-record
// cap would let one over-long endpoint alone exceed the record and surface as the record-level `meta_too_large`
// instead of a schema failure attributable to the field that actually caused it.
const canonicalEndpointSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => isAbsolute(value) && normalize(value) === value, 'endpoint must be an absolute canonical path');
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const containmentKindSchema = z.string().min(1).max(64);
const receiptSchema = z.string().min(1);

/**
 * `provider_operation.v1:<jobId>:<operationId>` — the exact committed tuple from W2.3's closed publication
 * order: prepare's reservation/root/containment receipt, then this meta commit, then guardian/proxy
 * activation. Field order mirrors the plan's normative listing so encoded bytes read the same way twice.
 */
export const providerOperationRuntimeMetaSchema = z
  .object({
    version: z.literal(1),
    jobId: canonicalUuidSchema,
    operationId: canonicalUuidSchema,
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    guardianInstanceId: canonicalUuidSchema,
    guardianPid: nonNegativeSafeIntegerSchema,
    guardianProcessStartedAtSeconds: nonNegativeSafeIntegerSchema,
    guardianControlEndpoint: canonicalEndpointSchema,
    proxyInstanceId: canonicalUuidSchema,
    proxyPid: nonNegativeSafeIntegerSchema,
    reaperInstanceId: canonicalUuidSchema,
    reaperPid: nonNegativeSafeIntegerSchema,
    reaperProcessStartedAtSeconds: nonNegativeSafeIntegerSchema,
    reaperControlEndpoint: canonicalEndpointSchema,
    containmentKind: containmentKindSchema,
    proxyProcessStartedAtSeconds: nonNegativeSafeIntegerSchema,
    proxyProcessGroupId: nonNegativeSafeIntegerSchema,
    canonicalEndpoint: canonicalEndpointSchema,
    reservation: canonicalUuidSchema,
    providerRootPid: nonNegativeSafeIntegerSchema,
    providerRootProcessStartedAtSeconds: nonNegativeSafeIntegerSchema,
    jointContainmentReceipt: receiptSchema,
    committedThroughProviderSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();

export type ProviderOperationRuntimeMeta = z.infer<typeof providerOperationRuntimeMetaSchema>;

export type ProviderOperationRuntimeMetaCodecErrorCode = 'meta_too_large' | 'meta_invalid';

export class ProviderOperationRuntimeMetaCodecError extends Error {
  readonly code: ProviderOperationRuntimeMetaCodecErrorCode;

  constructor(code: ProviderOperationRuntimeMetaCodecErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderOperationRuntimeMetaCodecError';
    this.code = code;
    Object.setPrototypeOf(this, ProviderOperationRuntimeMetaCodecError.prototype);
  }
}

/**
 * The meta table key for one operation's runtime locator. Only the coordinator writes this key.
 *
 * Naming a row, not validating one. The identifiers are checked where checking them means something — the
 * strict schema every write goes through — so a malformed id is refused at the write and simply names a row
 * that cannot exist at a read or a delete. Validating here instead would make the *reader* and the *pruner*
 * throw on an id neither of them chose and neither of them can correct.
 */
export function providerOperationRuntimeMetaKey(jobId: string, operationId: string): string {
  return `provider_operation.v1:${jobId}:${operationId}`;
}

/**
 * The `LIKE` prefix naming every `provider_operation.v1` row for one job, regardless of operation id.
 * `jobId` is always a canonical UUID by the time anything calls this (recovery reads it from a committed
 * launch record), so it never contains a `LIKE` metacharacter for this to escape.
 */
export function providerOperationRuntimeMetaKeyPrefix(jobId: string): string {
  return `provider_operation.v1:${jobId}:`;
}

/**
 * Validates `meta` against the strict schema, then serializes it compactly and enforces the 4096-byte cap on
 * the encoded bytes (not the object) — the cap is on what actually goes in the `meta` row. Schema failures
 * surface through the same typed `ProviderOperationRuntimeMetaCodecError` `decode` uses, rather than letting a
 * raw `ZodError` escape one direction of a round trip that is symmetric everywhere else.
 */
export function encodeProviderOperationRuntimeMeta(meta: ProviderOperationRuntimeMeta): string {
  const result = providerOperationRuntimeMetaSchema.safeParse(meta);
  if (!result.success) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_invalid',
      `Provider operation runtime meta failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  const encoded = JSON.stringify(result.data);
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_too_large',
      `Encoded provider operation runtime meta is ${byteLength} bytes, exceeding the ${MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES}-byte cap.`,
    );
  }
  return encoded;
}

/**
 * Rejects an over-limit value before parsing it — a tampered or corrupt `meta` row must not be handed to
 * `JSON.parse` unbounded — then requires strict JSON matching the schema exactly.
 */
export function decodeProviderOperationRuntimeMeta(raw: string): ProviderOperationRuntimeMeta {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_too_large',
      `Provider operation runtime meta value is ${byteLength} bytes, exceeding the ${MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES}-byte cap.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_invalid',
      'Provider operation runtime meta is not valid JSON.',
      { cause: error },
    );
  }

  const result = providerOperationRuntimeMetaSchema.safeParse(parsed);
  if (!result.success) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_invalid',
      `Provider operation runtime meta failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }

  return result.data;
}

/**
 * `durable_cli_process.v1:<jobId>` — the recorded identity of one durable CLI child.
 *
 * Small on purpose. A durable CLI has no operation tuple and no control channel, so the only thing that can
 * later be checked against it is which process was launched — and a pid alone cannot answer that, because
 * the OS recycles it. Pairing the pid with the kernel-supplied start second is what makes "the process we
 * launched is still running" distinguishable from "some unrelated process now holds that number".
 *
 * Like the operation locator above, this is ordinary key/value `meta`: a runtime fact about a live process,
 * never domain history, never a persisted codec, and never a substitute for `job.runtime.started`.
 */
export const durableCliProcessRuntimeMetaSchema = z
  .object({
    version: z.literal(1),
    jobId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
  })
  .strict();

export type DurableCliProcessRuntimeMeta = z.infer<typeof durableCliProcessRuntimeMetaSchema>;

/** The meta table key for one durable CLI child's recorded identity. Only the coordinator writes this key.
 *  Total for the same reason `providerOperationRuntimeMetaKey` is. */
export function durableCliProcessRuntimeMetaKey(jobId: string): string {
  return `durable_cli_process.v1:${jobId}`;
}

export function encodeDurableCliProcessRuntimeMeta(meta: DurableCliProcessRuntimeMeta): string {
  const result = durableCliProcessRuntimeMetaSchema.safeParse(meta);
  if (!result.success) {
    throw new ProviderOperationRuntimeMetaCodecError(
      'meta_invalid',
      `Durable CLI process runtime meta failed schema validation: ${result.error.message}`,
      { cause: result.error },
    );
  }
  return JSON.stringify(result.data);
}

/**
 * Decodes a recorded durable CLI identity, or reports that there is nothing usable to check against.
 *
 * `null` rather than a throw, and deliberately so: every failure here — absent row, corrupt bytes, a shape
 * from some other writer — means the same thing to the only caller that asks, which is that observation has
 * no recorded identity and must answer `unknown`. Making that an exception would push a decision the
 * classifier already models into a `catch` at every call site.
 */
export function decodeDurableCliProcessRuntimeMeta(
  raw: string | null | undefined,
): DurableCliProcessRuntimeMeta | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_PROVIDER_OPERATION_RUNTIME_META_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = durableCliProcessRuntimeMetaSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
