import { createHash } from 'node:crypto';

export function hashToken(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}
