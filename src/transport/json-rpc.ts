import { z } from 'zod';

export type JsonRpcId = string | number;

interface JsonRpcEnvelopeBase {
  readonly subscriptionId?: string;
}

export interface JsonRpcRequest<TParams = unknown> extends JsonRpcEnvelopeBase {
  readonly kind: 'request';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> extends JsonRpcEnvelopeBase {
  readonly kind: 'response';
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcNotification<TParams = unknown> extends JsonRpcEnvelopeBase {
  readonly kind: 'notification';
  readonly method: string;
  readonly params?: TParams;
}

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcError extends JsonRpcEnvelopeBase {
  readonly kind: 'error';
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcEnvelope<
  TRequestParams = unknown,
  TResponseResult = unknown,
  TNotificationParams = unknown,
> =
  | JsonRpcRequest<TRequestParams>
  | JsonRpcResponse<TResponseResult>
  | JsonRpcNotification<TNotificationParams>
  | JsonRpcError;

const jsonRpcIdSchema = z.union([z.string().min(1), z.number()]);

const jsonRpcRequestSchema = z
  .object({
    kind: z.literal('request'),
    id: jsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    subscriptionId: z.string().min(1).optional(),
  })
  .strict();

const jsonRpcResponseSchema = z
  .object({
    kind: z.literal('response'),
    id: jsonRpcIdSchema,
    result: z.unknown(),
    subscriptionId: z.string().min(1).optional(),
  })
  .strict();

const jsonRpcNotificationSchema = z
  .object({
    kind: z.literal('notification'),
    method: z.string().min(1),
    params: z.unknown().optional(),
    subscriptionId: z.string().min(1).optional(),
  })
  .strict();

const jsonRpcErrorSchema = z
  .object({
    kind: z.literal('error'),
    id: jsonRpcIdSchema.nullable(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
        data: z.unknown().optional(),
      })
      .strict(),
    subscriptionId: z.string().min(1).optional(),
  })
  .strict();

const jsonRpcEnvelopeSchema = z
  .discriminatedUnion('kind', [
    jsonRpcRequestSchema,
    jsonRpcResponseSchema,
    jsonRpcNotificationSchema,
    jsonRpcErrorSchema,
  ])
  .superRefine((value, ctx) => {
    // subscriptionId is reserved for future multiplexing. Keep the field in the
    // envelope shape, but reject it on the wire until multiplexed mode exists.
    if (value.subscriptionId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subscriptionId'],
        message: 'subscriptionId is reserved for future multiplexing and must be omitted until multiplexed mode exists',
      });
    }
  });

function parseEnvelope(value: unknown): JsonRpcEnvelope {
  return jsonRpcEnvelopeSchema.parse(value) as JsonRpcEnvelope;
}

export function encode(env: JsonRpcEnvelope): string {
  return JSON.stringify(parseEnvelope(env));
}

export function decode(wire: string): JsonRpcEnvelope {
  return parseEnvelope(JSON.parse(wire));
}
