import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

function receiptDir(runDir: string): string {
  return join(runDir, 'controller-receipts.v1');
}

function appendRecord(runDir: string, key: string, suffix: string, record: string): void {
  const dir = receiptDir(runDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${key}.${suffix}.json`);
  const temporary = join(dir, `.${randomUUID()}.stage`);
  try {
    writeFileSync(temporary, `${record}\n`, { flag: 'wx' });
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    try {
      linkSync(temporary, path);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST') ||
          readFileSync(path, 'utf8') !== `${record}\n`) throw error;
    }
    const directory = openSync(dir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function appendControllerReceipt(runDir: string, key: string, record: string): void {
  appendRecord(runDir, key, 'receipt', record);
}

export function appendControllerRecoveryGrant(runDir: string, key: string, record: string): void {
  appendRecord(runDir, key, 'grant', record);
}

export function readControllerRecoveryGrant(runDir: string, key: string): string | null {
  try { return readFileSync(join(receiptDir(runDir), `${key}.grant.json`), 'utf8'); }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function readControllerReceipts(runDir: string): readonly string[] {
  const dir = receiptDir(runDir);
  let names: string[];
  try { names = readdirSync(dir); } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.receipt.json')).map((name) => readFileSync(join(dir, name), 'utf8'));
}
