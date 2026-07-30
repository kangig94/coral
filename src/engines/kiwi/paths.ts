import { join } from 'node:path';

import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID, KIWI_MODEL_VERSION, KIWI_NLP_VERSION, KIWI_WASM_FILE_NAME } from './constants.js';

const KIWI_MODEL_DIR_NAME = 'cong-base';
const KIWI_MODEL_MANIFEST_FILE = 'manifest.json';
const KIWI_WASM_MANIFEST_FILE = 'manifest.json';

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

export function kiwiWasmDir(runtime: Pick<Runtime, 'paths'>): string {
  return join(kiwiDataDir(runtime), 'wasm', `v${KIWI_NLP_VERSION}`);
}

export function kiwiWasmManifestPath(runtime: Pick<Runtime, 'paths'>): string {
  return join(kiwiWasmDir(runtime), KIWI_WASM_MANIFEST_FILE);
}

export function kiwiWasmPath(runtime: Pick<Runtime, 'paths'>): string {
  return join(kiwiWasmDir(runtime), KIWI_WASM_FILE_NAME);
}
