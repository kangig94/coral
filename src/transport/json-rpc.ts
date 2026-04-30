import { z } from 'zod';

export type JsonRpcId = string | number;

export interface JsonRpcRequest<TParams = unknown> {
  readonly kind: 'request';
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcResponse<TResult = unknown> {
  readonly kind: 'response';
  readonly id: JsonRpcId;
  readonly result: TResult;
}

export interface JsonRpcNotification<TParams = unknown> {
  readonly kind: 'notification';
  readonly method: string;
  readonly params?: TParams;
}

interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcError {
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
  })
  .strict();

const jsonRpcResponseSchema = z
  .object({
    kind: z.literal('response'),
    id: jsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict();

const jsonRpcNotificationSchema = z
  .object({
    kind: z.literal('notification'),
    method: z.string().min(1),
    params: z.unknown().optional(),
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
  })
  .strict();

const jsonRpcEnvelopeSchema = z.discriminatedUnion('kind', [
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  jsonRpcNotificationSchema,
  jsonRpcErrorSchema,
]);

function parseEnvelope(value: unknown): JsonRpcEnvelope {
  return jsonRpcEnvelopeSchema.parse(value) as JsonRpcEnvelope;
}

export function encode(env: JsonRpcEnvelope): string {
  return JSON.stringify(parseEnvelope(env));
}

export function decode(wire: string): JsonRpcEnvelope {
  return parseEnvelope(JSON.parse(wire));
}
