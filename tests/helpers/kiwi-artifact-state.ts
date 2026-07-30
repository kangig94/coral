import type { KiwiArtifactComponent, KiwiArtifactState } from '#src/engines/kiwi/artifact.js';
import {
  KIWI_INSTALL_ONLY_ID,
  KIWI_MODEL_ARCHIVE_SIZE_BYTES,
  KIWI_MODEL_FILES,
  KIWI_MODEL_SHA256,
  KIWI_MODEL_TYPE,
  KIWI_MODEL_URL,
  KIWI_MODEL_VERSION,
  KIWI_NLP_PACKAGE_INTEGRITY,
  KIWI_NLP_PACKAGE_SHA256,
  KIWI_NLP_PACKAGE_SIZE_BYTES,
  KIWI_NLP_PACKAGE_URL,
  KIWI_NLP_VERSION,
  KIWI_WASM_FILE_NAME,
  KIWI_WASM_SHA256,
  KIWI_WASM_SIZE_BYTES,
  KIWI_WASM_TAR_ENTRY,
} from '#src/engines/kiwi/constants.js';

const INSTALLED_AT = '2026-06-19T00:00:00.000Z';

export function installedKiwiArtifactState(installedAt = INSTALLED_AT): KiwiArtifactState {
  return {
    ready: true,
    missingComponents: [],
    model: {
      targetDir: '/tmp/kiwi/model',
      manifestPath: '/tmp/kiwi/model/manifest.json',
      installed: true,
      missingFiles: [],
      manifest: {
        packageId: KIWI_INSTALL_ONLY_ID,
        kiwiNlpVersion: KIWI_NLP_VERSION,
        modelVersion: KIWI_MODEL_VERSION,
        modelType: KIWI_MODEL_TYPE,
        sourceUrl: KIWI_MODEL_URL,
        archiveSha256: KIWI_MODEL_SHA256,
        archiveSizeBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES,
        files: KIWI_MODEL_FILES,
        installedAt,
      },
    },
    wasm: {
      targetDir: '/tmp/kiwi/wasm',
      manifestPath: '/tmp/kiwi/wasm/manifest.json',
      wasmPath: `/tmp/kiwi/wasm/${KIWI_WASM_FILE_NAME}`,
      installed: true,
      manifest: {
        schemaVersion: 1,
        artifact: 'kiwi-wasm',
        packageId: KIWI_INSTALL_ONLY_ID,
        kiwiNlpVersion: KIWI_NLP_VERSION,
        sourceUrl: KIWI_NLP_PACKAGE_URL,
        archiveIntegrity: KIWI_NLP_PACKAGE_INTEGRITY,
        archiveSha256: KIWI_NLP_PACKAGE_SHA256,
        archiveSizeBytes: KIWI_NLP_PACKAGE_SIZE_BYTES,
        archiveEntry: KIWI_WASM_TAR_ENTRY,
        wasmSha256: KIWI_WASM_SHA256,
        wasmSizeBytes: KIWI_WASM_SIZE_BYTES,
        file: KIWI_WASM_FILE_NAME,
        installedAt,
      },
      payloadValid: true,
      payloadSha256: KIWI_WASM_SHA256,
      reason: null,
    },
  };
}

export function missingKiwiArtifactState(missingComponent: KiwiArtifactComponent = 'model'): KiwiArtifactState {
  const installed = installedKiwiArtifactState();
  if (missingComponent === 'wasm') {
    return {
      ...installed,
      ready: false,
      missingComponents: ['wasm'],
      wasm: {
        ...installed.wasm,
        installed: false,
        manifest: null,
        payloadValid: false,
        payloadSha256: null,
        reason: 'file_missing',
      },
    };
  }
  return {
    ...installed,
    ready: false,
    missingComponents: ['model'],
    model: {
      ...installed.model,
      installed: false,
      manifest: null,
      missingFiles: ['cong.mdl'],
    },
  };
}
