import { isAbsolute, normalize } from 'node:path';

import { z } from 'zod';

import { nonEmptyStringSchema } from '../infra/identifiers.js';
import { jsonValueSchema } from '../infra/json-value.js';
import { providerBindingEnvelopeSchema } from '../infra/provider-binding-envelope.js';
import {
  providerArtifactHandleEventBodySchema,
  providerContinuityEventBodySchema,
  providerRequestSchema,
  providerSuspendedEventBodySchema,
  providerTerminalEventBodySchema,
} from '../providers/contract.js';

export const MAX_PROXY_CONTROL_FRAME_BYTES = 17 * 1024 * 1024;
export const PROXY_CONTROL_RPC_TIMEOUT_MS = 5_000;
export const PROXY_EVENT_COMMIT_TIMEOUT_MS = 30_000;
export const PROXY_STATUS_RPC_TIMEOUT_MS = 500;

export const PROXY_CONTROL_PROTOCOL_ERROR_CODES = [
  'invalid_request',
  'unauthorized_control',
  'identity_mismatch',
  'invalid_state',
  'frame_too_large',
  'grant_invalid',
  'grant_replayed',
  'reservation_expired',
  'operation_not_found',
  'protocol_violation',
] as const;

export type ProxyControlProtocolErrorCode = (typeof PROXY_CONTROL_PROTOCOL_ERROR_CODES)[number];

export class ProxyControlProtocolError extends Error {
  readonly code: ProxyControlProtocolErrorCode;

  constructor(code: ProxyControlProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ProxyControlProtocolError';
    this.code = code;
    Object.setPrototypeOf(this, ProxyControlProtocolError.prototype);
  }
}

export const canonicalUuidSchema = z
  .string()
  .length(36)
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const hostFingerprintSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
export const generationSchema = z.literal('gen2');
export const flavorSchema = z.enum(['prod', 'dev']);
export const canonicalEndpointSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && normalize(value) === value, 'endpoint must be an absolute canonical path');

export const coordinatorIdentitySchema = z
  .object({
    instanceId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
    generation: generationSchema,
    flavor: flavorSchema,
    buildSetId: canonicalUuidSchema,
  })
  .strict();

export type CoordinatorIdentity = z.infer<typeof coordinatorIdentitySchema>;

export const guardianIdentitySchema = z
  .object({
    guardianInstanceId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
    generation: generationSchema,
    flavor: flavorSchema,
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    canonicalControlEndpoint: canonicalEndpointSchema,
  })
  .strict();

export type GuardianIdentity = z.infer<typeof guardianIdentitySchema>;

export const reaperIdentitySchema = z
  .object({
    reaperInstanceId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
    guardianInstanceId: canonicalUuidSchema,
    generation: generationSchema,
    flavor: flavorSchema,
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    canonicalControlEndpoint: canonicalEndpointSchema,
    containmentKind: z.string().min(1).max(64),
  })
  .strict();

export type ReaperIdentity = z.infer<typeof reaperIdentitySchema>;

export const proxyIdentitySchema = z
  .object({
    proxyInstanceId: canonicalUuidSchema,
    pid: nonNegativeSafeIntegerSchema,
    processStartedAtSeconds: nonNegativeSafeIntegerSchema,
    processGroupId: nonNegativeSafeIntegerSchema,
    guardianInstanceId: canonicalUuidSchema,
    reaperInstanceId: canonicalUuidSchema,
    generation: generationSchema,
    flavor: flavorSchema,
    buildSetId: canonicalUuidSchema,
    hostFingerprint: hostFingerprintSchema,
    canonicalEndpoint: canonicalEndpointSchema,
  })
  .strict();

export type ProxyIdentity = z.infer<typeof proxyIdentitySchema>;

export const operationIdentitySchema = z
  .object({
    jobId: canonicalUuidSchema,
    operationId: canonicalUuidSchema,
    proxyInstanceId: canonicalUuidSchema,
    buildSetId: canonicalUuidSchema,
  })
  .strict();

export type OperationIdentity = z.infer<typeof operationIdentitySchema>;

/** One provider-root identity: the pid and start time the guardian/reaper stage, confirm, and enforce
 *  containment against. Shared because both roles carry this exact 2-field shape wherever a request or
 *  response names a provider root — a single staged/confirmed root or a member of the teardown-time
 *  recorded set — rather than each role declaring its own copy of the same two fields. */
export const providerRootSchema = z
  .object({ pid: nonNegativeSafeIntegerSchema, processStartedAtSeconds: nonNegativeSafeIntegerSchema })
  .strict();

/** The permission bits of a `stat.mode`, isolated from the leading file-type bits so a mode can be compared
 *  against an expected value like `0o600`. Shared by every capsule file this domain reads or writes under a
 *  private mode, so the mask itself cannot drift between them. */
export const PERMISSION_BITS_MASK = 0o777n;

/**
 * `ProviderEventBody`'s one variant with no zod schema of its own in `providers/contract.ts` — every other
 * variant already has one there (imported above) and is reused rather than redefined, matching this file's
 * own "don't duplicate a schema that already exists elsewhere" rule.
 */
const providerProgressEventBodySchema = z.object({ kind: z.literal('progress'), message: z.string() }).strict();

/**
 * `ProviderEventBody`'s wire schema, composed from `providers/contract.ts`'s own per-variant schemas plus
 * the one variant (`progress`) that file has none for. `z.discriminatedUnion` cannot be used here:
 * `providerTerminalEventBodySchema` carries a `.superRefine` invariant (a failed terminal must carry
 * `failureCause`; no other terminal may), which makes it a `ZodEffects` rather than the plain `ZodObject`
 * `discriminatedUnion` needs to read `.shape.kind` from at construction time. `z.union` still validates every
 * member fully — each one is independently `.strict()` — it only loses the single-pass discriminant lookup.
 */
export const providerEventBodySchema = z.union([
  providerProgressEventBodySchema,
  providerContinuityEventBodySchema,
  providerArtifactHandleEventBodySchema,
  providerSuspendedEventBodySchema,
  providerTerminalEventBodySchema,
]);

const providerEventSeqSchema = z.number().int().positive().safe();

/**
 * The prepared operation, exactly as it crosses into the proxy process.
 *
 * Data only, and strictly so. The plan's rule is that "executable closures, sessions, signals, and coordinator
 * callbacks do not" cross — and none of them can, because every field here is a value the proxy re-derives
 * execution from rather than a handle it borrows. The proxy rebuilds the bound provider from `binding`, opens
 * its own app-server host, and runs the kernel itself; nothing in this envelope reaches back into the
 * coordinator.
 *
 * `protectedEnv` carries minted child-principal secrets. It travels no further than the same authenticated
 * unix-domain control socket every other method uses, to a role process this coordinator spawned, and it is
 * exactly the environment that process would otherwise receive at spawn — so this widens no trust boundary.
 * It is kept separate from `baseEnv` so a future audit surface can redact one without the other.
 */
export const proxyPreparedAppServerOperationSchema = z
  .object({
    version: z.literal(1),
    provider: nonEmptyStringSchema,
    binding: providerBindingEnvelopeSchema,
    request: providerRequestSchema,
    /** Provider-opaque continuity, `null` when the session has none rather than absent, so "no snapshot" is
     *  a value the proxy can act on rather than a field it has to guess the meaning of. */
    persistedContinuity: jsonValueSchema.nullable(),
    baseEnv: z.record(z.string()),
    protectedEnv: z.record(z.string()),
    platform: nonEmptyStringSchema,
  })
  .strict();

export type ProxyPreparedAppServerOperation = z.infer<typeof proxyPreparedAppServerOperationSchema>;

/**
 * `provider.event.v1`'s request: the proxy, over the live control connection it otherwise only answers on,
 * hands the active control one buffered event for one operation. The one method in this whole protocol that
 * travels proxy-to-control rather than control-to-proxy.
 */
export const providerEventRequestSchema = z
  .object({
    operation: operationIdentitySchema,
    providerSeq: providerEventSeqSchema,
    event: providerEventBodySchema,
  })
  .strict();

export type ProviderEventRequest = z.infer<typeof providerEventRequestSchema>;

/** `provider.event.v1`'s result: a durable commit watermark, or a request to resend from an earlier point. */
export const providerEventResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ack'), committedThroughProviderSeq: nonNegativeSafeIntegerSchema }).strict(),
  z
    .object({
      kind: z.literal('replay'),
      replayFromProviderSeq: providerEventSeqSchema,
      reason: z.string().min(1).max(200),
    })
    .strict(),
]);

export type ProviderEventResult = z.infer<typeof providerEventResultSchema>;

/**
 * The one method this protocol ever sends in the proxy-to-control direction. Named once here so
 * `control-client.ts` (which must recognise it to decide whether to serve it) and `proxy.ts` (which sends it)
 * cannot drift into two spellings of the same wire method.
 */
export const PROVIDER_EVENT_METHOD = 'provider.event.v1' as const;

/** A grant or tenancy is build-bound: only a coordinator of the exact build a role's own capsule names may
 *  install, redeem, or open one. Shared by every role that holds a bootstrap capsule, so the same check and
 *  message are not hand-retyped per role. */
export function assertNamedCoordinatorBuild(
  coordinator: CoordinatorIdentity,
  build: Readonly<{ generation: string; flavor: string; buildSetId: string }>,
): void {
  if (
    coordinator.generation !== build.generation ||
    coordinator.flavor !== build.flavor ||
    coordinator.buildSetId !== build.buildSetId
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', 'The named coordinator belongs to a different build.');
  }
}

/** The caller names the roots it believes are recorded. A disagreement means one side is reasoning about a
 *  different containment, which teardown must surface rather than silently reap its own view of — the same
 *  check both the guardian and the reaper perform on their own half of the same stop-and-reap request. */
export function assertRecordedSetAgreement(
  role: 'guardian' | 'reaper',
  claimed: readonly { pid: number; processStartedAtSeconds: number }[],
  recorded: readonly { pid: number; processStartedAtSeconds: number }[],
): void {
  const key = (root: { pid: number; processStartedAtSeconds: number }): string =>
    `${root.pid}@${root.processStartedAtSeconds}`;
  const recordedKeys = new Set(recorded.map(key));
  const claimedKeys = new Set(claimed.map(key));
  if (recordedKeys.size !== claimedKeys.size || [...claimedKeys].some((entry) => !recordedKeys.has(entry))) {
    throw new ProxyControlProtocolError(
      'identity_mismatch',
      `Teardown named a different provider-root set than this ${role} recorded.`,
    );
  }
}

/** The proxy-identity fields every bootstrap capsule that names a proxy shares — enough for
 *  `assertNamedProxyIdentity` to check without depending on which role's own capsule shape it came from
 *  (avoids a `bootstrap-capsule.ts` import here, which would cycle back to this file). */
type ProxyNamingCapsule = Readonly<{
  proxyInstanceId: string;
  guardianInstanceId: string;
  reaperInstanceId: string;
  generation: string;
  flavor: string;
  buildSetId: string;
  hostFingerprint: string;
  proxyEndpoint: string;
}>;

/** The caller names the proxy it believes this guardian/reaper is staging or tearing down for. A disagreement
 *  means it is reasoning about a different proxy than the one this role's own bootstrap capsule names —
 *  checked against the stable identity the capsule holds, never against anything the caller supplied.
 *  Deliberately not checked against the recorded containment's pid/start-time/group: those name *this
 *  containment's* leader, a fact `providerRoots`/`record-containment.v1` already carry and verify on their
 *  own terms, not a second channel for the same proxy-instance check this function exists to make. */
export function assertNamedProxyIdentity(
  role: 'guardian' | 'reaper',
  claimed: ProxyIdentity,
  capsule: ProxyNamingCapsule,
): void {
  if (
    claimed.proxyInstanceId !== capsule.proxyInstanceId ||
    claimed.guardianInstanceId !== capsule.guardianInstanceId ||
    claimed.reaperInstanceId !== capsule.reaperInstanceId ||
    claimed.generation !== capsule.generation ||
    claimed.flavor !== capsule.flavor ||
    claimed.buildSetId !== capsule.buildSetId ||
    claimed.hostFingerprint !== capsule.hostFingerprint ||
    claimed.canonicalEndpoint !== capsule.proxyEndpoint
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', `The named proxy does not match this ${role}.`);
  }
}

/** The caller names the reaper it believes it is addressing. A disagreement means it is reasoning about a
 *  different instance, which teardown must surface rather than silently act against this one — checked by
 *  both the reaper's own handler (against what it knows about itself) and the guardian's (against the reaper
 *  it itself spawned and paired with). */
export function assertNamedReaperIdentity(claimed: ReaperIdentity, actual: ReaperIdentity): void {
  if (
    claimed.reaperInstanceId !== actual.reaperInstanceId ||
    claimed.pid !== actual.pid ||
    claimed.processStartedAtSeconds !== actual.processStartedAtSeconds ||
    claimed.guardianInstanceId !== actual.guardianInstanceId ||
    claimed.generation !== actual.generation ||
    claimed.flavor !== actual.flavor ||
    claimed.buildSetId !== actual.buildSetId ||
    claimed.hostFingerprint !== actual.hostFingerprint ||
    claimed.canonicalControlEndpoint !== actual.canonicalControlEndpoint ||
    claimed.containmentKind !== actual.containmentKind
  ) {
    throw new ProxyControlProtocolError('identity_mismatch', 'Teardown named a different reaper than this one.');
  }
}

/** The 4-field identity a recorded process-group containment carries: the leader's pid and start time, the
 *  group id that names the containment itself, and the containment-kind vocabulary word. Both the guardian
 *  (recording what it watched spawned) and the reaper (recording what the guardian forwarded, and later
 *  checking what a coordinator's `reaper.open.v1` claims against it) compare an incoming containment against
 *  one already held by this same shape, so a mismatch is always this same 4-field disagreement. */
export function sameRecordedContainment(
  left: Readonly<{ pid: number; processStartedAtSeconds: number; processGroupId: number; containmentKind: string }>,
  right: Readonly<{ pid: number; processStartedAtSeconds: number; processGroupId: number; containmentKind: string }>,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartedAtSeconds === right.processStartedAtSeconds &&
    left.processGroupId === right.processGroupId &&
    left.containmentKind === right.containmentKind
  );
}

/** The teardown reserve is derived from this build's own process constants, not chosen per grant — a caller
 *  naming a different one disagrees about arithmetic both sides compute, which every `*.handoff-install.v1`
 *  handler on this build reports the same way. */
export function assertNamedTeardownReserve(claimedMs: number, expectedMs: number): void {
  if (claimedMs !== expectedMs) {
    throw new ProxyControlProtocolError(
      'identity_mismatch',
      `The named teardown reserve is not this build's ${expectedMs}ms.`,
    );
  }
}

const jsonRpcIdSchema = z.union([z.string().min(1), z.number().safe()]);

const proxyControlJsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const proxyControlJsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict()
  .superRefine((message, context) => {
    if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'result is required' });
    }
  });

const proxyControlJsonRpcFailureSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: jsonRpcIdSchema.nullable(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

export const proxyControlJsonRpcMessageSchema = z.union([
  proxyControlJsonRpcRequestSchema,
  proxyControlJsonRpcSuccessSchema,
  proxyControlJsonRpcFailureSchema,
]);

export type ProxyControlJsonRpcMessage = z.infer<typeof proxyControlJsonRpcMessageSchema>;

export const proxyControlFrameSchema = z.string().superRefine((frame, context) => {
  const frameBytes = Buffer.byteLength(frame, 'utf8');
  if (frameBytes > MAX_PROXY_CONTROL_FRAME_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'frame_too_large' });
  }
  if (!frame.endsWith('\n') || frame.indexOf('\n') !== frame.length - 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'frame must contain exactly one trailing newline' });
  }
});

function assertFrameSize(observedBytes: number): void {
  if (observedBytes > MAX_PROXY_CONTROL_FRAME_BYTES) {
    throw new ProxyControlProtocolError(
      'frame_too_large',
      `Proxy control frame exceeded ${MAX_PROXY_CONTROL_FRAME_BYTES} bytes (observed ${observedBytes}).`,
    );
  }
}

export function encodeProxyControlFrame(message: ProxyControlJsonRpcMessage): string {
  let validated: ProxyControlJsonRpcMessage;
  try {
    validated = proxyControlJsonRpcMessageSchema.parse(message);
  } catch {
    throw new ProxyControlProtocolError('invalid_request', 'Proxy control message failed strict JSON-RPC validation.');
  }

  const frame = `${JSON.stringify(validated)}\n`;
  assertFrameSize(Buffer.byteLength(frame, 'utf8'));
  return frame;
}

export function decodeProxyControlFrame(frame: string | Buffer): ProxyControlJsonRpcMessage {
  assertFrameSize(typeof frame === 'string' ? Buffer.byteLength(frame, 'utf8') : frame.byteLength);
  const text = typeof frame === 'string' ? frame : frame.toString('utf8');

  try {
    proxyControlFrameSchema.parse(text);
    return proxyControlJsonRpcMessageSchema.parse(JSON.parse(text.slice(0, -1)));
  } catch (error: unknown) {
    if (error instanceof ProxyControlProtocolError) throw error;
    throw new ProxyControlProtocolError('invalid_request', 'Proxy control frame failed strict JSON-RPC validation.');
  }
}

/**
 * Reads newline-delimited frames from raw socket bytes, shared by every control endpoint and client in this
 * domain. Chunks are accumulated as bytes and each complete frame is decoded exactly once: decoding a chunk
 * on its own would replace any multi-byte character split across the boundary with U+FFFD, and that damage
 * lands inside a JSON string where both `JSON.parse` and strict validation still succeed. A newline byte
 * cannot occur inside a multi-byte sequence, so splitting on the byte is safe. The cap is applied to the
 * accumulating buffer, not only to complete frames, so a peer that never sends a newline cannot grow it
 * without bound.
 */
export function createFrameReader(onFrame: (frame: string) => void, onOversize: () => void): (chunk: Buffer) => void {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
    if (pending.byteLength > MAX_PROXY_CONTROL_FRAME_BYTES) {
      pending = Buffer.alloc(0);
      onOversize();
      return;
    }
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      onFrame(pending.subarray(0, newline + 1).toString('utf8'));
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
  };
}
