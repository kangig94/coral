export const BODY_DECODER = new TextDecoder();

export function decodeEventBody(body: Uint8Array | Buffer): unknown {
  return JSON.parse(BODY_DECODER.decode(body));
}

export function encodeEventBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf-8');
}
