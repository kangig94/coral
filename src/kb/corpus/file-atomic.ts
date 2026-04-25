import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeFileAtomic(filePath: string, payload: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
