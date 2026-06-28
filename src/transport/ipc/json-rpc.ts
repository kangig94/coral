import { z } from 'zod';

import type { JsonRpcErrorObject } from '../../infra/json-rpc.js';

// Coral's internal IPC speaks a *tagged* dialect of JSON-RPC: every envelope
// carries an explicit `kind` discriminator so the inbound parser can route
// without relying on field-presence heuristics. The error body shape comes
// from `infra/json-rpc.ts`; the tagging is coral-specific. Non-error
// envelopes narrow `id` to `string | number` — only the error variant
// carries the spec-mandated nullable id (for parse failures where the id
// couldn't be recovered).
//
// Envelope-suffixed names disambiguate from `infra/json-rpc.ts`'s standard
// vocabulary: a caller importing both knows which dialect each name refers
// to without aliasing.

export type JsonRpcEnvelopeId = string | number;

export type IpcAuthMetadata =
  | {
      readonly kind: 'boot';
      readonly token: string;
    }
  | {
      readonly kind: 'child';
      readonly handle: string;
      readonly token: string;
      readonly jobId: string;
      readonly sessionId: string;
    };

export interface JsonRpcRequestEnvelope<TParams = unknown> {
  readonly kind: 'request';
  readonly id: JsonRpcEnvelopeId;
  readonly method: string;
  readonly params?: TParams;
  readonly auth?: IpcAuthMetadata;
}

export interface JsonRpcResponseEnvelope<TResult = unknown> {
  readonly kind: 'response';
  readonly id: JsonRpcEnvelopeId;
  readonly result: TResult;
}

export interface JsonRpcNotificationEnvelope<TParams = unknown> {
  readonly kind: 'notification';
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcErrorEnvelope {
  readonly kind: 'error';
  readonly id: JsonRpcEnvelopeId | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcEnvelope<TRequestParams = unknown, TResponseResult = unknown, TNotificationParams = unknown> =
  | JsonRpcRequestEnvelope<TRequestParams>
  | JsonRpcResponseEnvelope<TResponseResult>
  | JsonRpcNotificationEnvelope<TNotificationParams>
  | JsonRpcErrorEnvelope;

const jsonRpcEnvelopeIdSchema = z.union([z.string().min(1), z.number()]);

export const ipcAuthMetadataSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('boot'),
      token: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('child'),
      handle: z.string().min(1),
      token: z.string().min(1),
      jobId: z.string().min(1),
      sessionId: z.string().min(1),
    })
    .strict(),
]);

export const jsonRpcRequestEnvelopeSchema = z
  .object({
    kind: z.literal('request'),
    id: jsonRpcEnvelopeIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
    auth: ipcAuthMetadataSchema.optional(),
  })
  .strict();

const jsonRpcResponseEnvelopeSchema = z
  .object({
    kind: z.literal('response'),
    id: jsonRpcEnvelopeIdSchema,
    result: z.unknown(),
  })
  .strict();

const jsonRpcNotificationEnvelopeSchema = z
  .object({
    kind: z.literal('notification'),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

const jsonRpcErrorEnvelopeSchema = z
  .object({
    kind: z.literal('error'),
    id: jsonRpcEnvelopeIdSchema.nullable(),
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
  jsonRpcRequestEnvelopeSchema,
  jsonRpcResponseEnvelopeSchema,
  jsonRpcNotificationEnvelopeSchema,
  jsonRpcErrorEnvelopeSchema,
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
