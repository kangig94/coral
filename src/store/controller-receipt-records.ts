import { join } from 'node:path';
import type { Runtime } from '../runtime/ports.js';

function receiptDir(runDir: string): string {
  return join(runDir, 'controller-receipts.v1');
}

function appendRecord(
  runtime: Pick<Runtime, 'storage' | 'ids'>,
  runDir: string,
  key: string,
  suffix: string,
  record: string,
): void {
  const { storage } = runtime;
  const dir = receiptDir(runDir);
  storage.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.${suffix}.json`);
  const temporary = join(dir, `.${runtime.ids.uuid()}.stage`);
  try {
    storage.writeFileSync(temporary, `${record}\n`, { flag: 'wx' });
    const file = storage.openSync(temporary, 'r');
    try {
      storage.fdatasyncSync(file);
    } finally {
      storage.closeSync(file);
    }
    try {
      storage.linkSync(temporary, path);
    } catch (error: unknown) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
        storage.readFileSync(path, 'utf-8') !== `${record}\n`
      )
        throw error;
    }
    if (!storage.syncDirectoryDurableSync(dir)) throw new Error('Controller receipt directory was not persisted.');
  } finally {
    storage.rmSync(temporary, { force: true });
  }
}

export function appendControllerReceipt(
  runtime: Pick<Runtime, 'storage' | 'ids'>,
  runDir: string,
  key: string,
  record: string,
): void {
  appendRecord(runtime, runDir, key, 'receipt', record);
}

export function appendControllerRecoveryGrant(
  runtime: Pick<Runtime, 'storage' | 'ids'>,
  runDir: string,
  key: string,
  record: string,
): void {
  appendRecord(runtime, runDir, key, 'grant', record);
}

export function readControllerRecoveryGrant(
  runtime: Pick<Runtime, 'storage'>,
  runDir: string,
  key: string,
): string | null {
  try {
    return runtime.storage.readFileSync(join(receiptDir(runDir), `${key}.grant.json`), 'utf-8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readControllerReceipts(runtime: Pick<Runtime, 'storage'>, runDir: string): readonly string[] {
  const dir = receiptDir(runDir);
  let names: string[];
  try {
    names = runtime.storage.readdirSync(dir);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith('.receipt.json'))
    .map((name) => runtime.storage.readFileSync(join(dir, name), 'utf-8'));
}
