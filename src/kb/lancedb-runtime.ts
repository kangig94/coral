import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { kbRuntimeDir } from './paths.js';
import type { KbLanceDbAdapter } from './types.js';

type ConnectFn = (uri: string) => Promise<unknown> | unknown;

function resolveConnect(moduleValue: unknown): ConnectFn {
  if (typeof moduleValue === 'object' && moduleValue !== null) {
    const maybeConnect = 'connect' in moduleValue ? moduleValue.connect : undefined;
    if (typeof maybeConnect === 'function') {
      return maybeConnect as ConnectFn;
    }

    const maybeDefault = 'default' in moduleValue ? moduleValue.default : undefined;
    if (typeof maybeDefault === 'object' && maybeDefault !== null) {
      const defaultConnect = 'connect' in maybeDefault ? maybeDefault.connect : undefined;
      if (typeof defaultConnect === 'function') {
        return defaultConnect as ConnectFn;
      }
    }
  }

  throw new Error('Invalid LanceDB module');
}

export async function loadKbLanceDb(specifier: string, runtimeDir = kbRuntimeDir()): Promise<KbLanceDbAdapter> {
  const moduleValue = await import(specifier);
  const connect = resolveConnect(moduleValue);
  const dbPath = join(runtimeDir, 'kb.lance');
  let dbPromise: Promise<unknown> | null = null;
  const getDb = async (): Promise<unknown> => {
    if (dbPromise) return dbPromise;
    mkdirSync(runtimeDir, { recursive: true });
    dbPromise = Promise.resolve(connect(dbPath));
    return dbPromise;
  };

  return {
    getDb,
    async ensureTables(): Promise<void> {
      await getDb();
    },
  };
}
