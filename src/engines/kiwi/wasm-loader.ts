import { randomUUID } from 'node:crypto';

import type { ModelFiles } from 'kiwi-nlp';
import initKiwiModule from 'kiwi-nlp/dist/build/kiwi-wasm.js';

import type { Runtime } from '../../runtime/ports.js';
import { KIWI_WASM_FILE_NAME } from './constants.js';
import { kiwiWasmPath } from './paths.js';

type KiwiWasmModule = {
  readonly FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
  api(command: string): string;
};

export type KiwiWasmInitializer = (moduleArg?: Record<string, unknown>) => Promise<unknown>;

const initKiwi = initKiwiModule as unknown as KiwiWasmInitializer;

export type KiwiApi = {
  cmd<T = unknown>(command: Record<string, unknown>): T;
  loadModelFiles(files: ModelFiles): Promise<{
    readonly modelPath: string;
    unload(): Promise<void>;
  }>;
};

export async function createKiwiApi(
  runtime: Pick<Runtime, 'paths'>,
  initialize: KiwiWasmInitializer = initKiwi,
): Promise<KiwiApi> {
  const kiwi = (await initialize({
    locateFile: (path: string, prefix = '') =>
      path === KIWI_WASM_FILE_NAME ? kiwiWasmPath(runtime) : `${prefix}${path}`,
  })) as KiwiWasmModule;

  return {
    cmd<T = unknown>(command: Record<string, unknown>): T {
      return JSON.parse(kiwi.api(JSON.stringify(command))) as T;
    },
    async loadModelFiles(files: ModelFiles) {
      const modelPath = `kiwi-model-${randomUUID()}`;
      kiwi.FS.mkdir(modelPath);
      const loadedFiles: string[] = [];
      try {
        for (const [name, data] of Object.entries(files)) {
          if (typeof data === 'string') {
            throw new Error('Kiwi model files must be installed locally before loading.');
          }
          const path = `${modelPath}/${name}`;
          kiwi.FS.writeFile(path, data as Uint8Array);
          loadedFiles.push(path);
        }
      } catch (error: unknown) {
        for (const path of loadedFiles.reverse()) {
          try {
            kiwi.FS.unlink(path);
          } catch {
            /* best-effort cleanup */
          }
        }
        try {
          kiwi.FS.rmdir(modelPath);
        } catch {
          /* best-effort cleanup */
        }
        throw error;
      }

      return {
        modelPath,
        async unload(): Promise<void> {
          for (const path of loadedFiles.reverse()) {
            try {
              kiwi.FS.unlink(path);
            } catch {
              /* best-effort cleanup */
            }
          }
          try {
            kiwi.FS.rmdir(modelPath);
          } catch {
            /* best-effort cleanup */
          }
        },
      };
    },
  };
}
