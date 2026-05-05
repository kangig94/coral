import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { StoragePort } from './port-types.js';

export type FileTailChunk = {
  lines: string[];
  newOffset: number;
};

type FileTailStorage = Pick<StoragePort, 'statSync' | 'openSync' | 'readSync' | 'closeSync'>;

export function readAppendedLines(path: string, fromOffset: number, storage?: FileTailStorage): FileTailChunk {
  const reader = storage ?? { closeSync, openSync, readSync, statSync };
  try {
    const stats = reader.statSync(path);
    if (stats.size <= fromOffset) {
      return { lines: [], newOffset: fromOffset };
    }

    const byteLength = stats.size - fromOffset;
    const fd = reader.openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(byteLength);
      const bytesRead = reader.readSync(fd, buffer, 0, byteLength, fromOffset);
      if (bytesRead <= 0) {
        return { lines: [], newOffset: fromOffset };
      }

      const chunk = buffer.subarray(0, bytesRead);
      const lastNewlineIndex = chunk.lastIndexOf(0x0a);
      if (lastNewlineIndex === -1) {
        return { lines: [], newOffset: fromOffset };
      }

      const completeChunk = chunk.subarray(0, lastNewlineIndex + 1).toString('utf-8');
      const lines = completeChunk
        .split('\n')
        .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
        .filter((line) => line.trim().length > 0);

      return {
        lines,
        newOffset: fromOffset + lastNewlineIndex + 1,
      };
    } finally {
      reader.closeSync(fd);
    }
  } catch {
    return { lines: [], newOffset: fromOffset };
  }
}
