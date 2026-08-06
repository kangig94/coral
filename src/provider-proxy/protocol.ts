import { isAbsolute, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

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
  'deadline_exceeded',
  'grant_invalid',
  'grant_expired',
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
const carrierStateSchema = z.enum(['pending-activation', 'executing', 'released']);

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

export const proxyHandoffOperationSchema = z
  .object({
    operation: operationIdentitySchema,
    carrierState: carrierStateSchema,
    committedThroughProviderSeq: nonNegativeSafeIntegerSchema,
  })
  .strict();

export type ProxyHandoffOperation = z.infer<typeof proxyHandoffOperationSchema>;

export function identityAgreementSchema<Identity>(
  schema: z.ZodType<Identity>,
  expected: Identity,
): z.ZodType<Identity> {
  const canonicalExpected = schema.parse(expected);
  return schema.superRefine((received, context) => {
    if (!isDeepStrictEqual(received, canonicalExpected)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'identity_mismatch' });
    }
  });
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
