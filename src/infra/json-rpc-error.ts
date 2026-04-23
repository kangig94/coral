export function buildJsonRpcError(code: number, message: string, data?: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  return data === undefined ? { code, message } : { code, message, data };
}
