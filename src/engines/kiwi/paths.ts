import { createRequire } from 'node:module';
import { join } from 'node:path';

import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID, KIWI_MODEL_VERSION } from './constants.js';

const require = createRequire(import.meta.url);
const KIWI_MODEL_DIR_NAME = 'cong-base';
const KIWI_MODEL_MANIFEST_FILE = 'manifest.json';

export function kiwiDataDir(runtime: Pick<Runtime, 'paths'>): string {
  return runtime.paths.coral.engine.dataDir(KIWI_INSTALL_ONLY_ID);
}

export function kiwiModelDir(runtime: Pick<Runtime, 'paths'>): string {
  return join(kiwiDataDir(runtime), 'models', `v${KIWI_MODEL_VERSION}`, KIWI_MODEL_DIR_NAME);
}

export function kiwiModelManifestPath(runtime: Pick<Runtime, 'paths'>): string {
  return join(kiwiModelDir(runtime), KIWI_MODEL_MANIFEST_FILE);
}

export function kiwiModelFilePath(runtime: Pick<Runtime, 'paths'>, fileName: string): string {
  return join(kiwiModelDir(runtime), fileName);
}

export function kiwiWasmPath(): string {
  return require.resolve('kiwi-nlp/dist/kiwi-wasm.wasm');
}
