// Standard JSON-RPC 2.0 vocabulary. Shared by every coral consumer that
// speaks JSON-RPC over the wire — internal IPC (`transport/json-rpc.ts`,
// which adds a coral-internal `kind` discriminator on top of these shapes)
// and external app-server protocols (`providers/claude/appserver/protocol.ts`).
//
// The `id` union follows the JSON-RPC 2.0 spec: `string | number | null`.
// `null` is the spec-mandated value for error responses where the server
// could not parse a request id. Coral's internal IPC excludes `null` from
// non-error envelopes by composition — this base intentionally permits it.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TParams = unknown> {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  method: string;
  params?: TParams;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<TResult = unknown> {
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export function buildJsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorObject {
  return data === undefined ? { code, message } : { code, message, data };
}
