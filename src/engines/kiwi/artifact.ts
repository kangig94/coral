import { errorMessage } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID, KIWI_NLP_VERSION } from './constants.js';
import { isInstallPathUnwritableError, kiwiInstallError, type KiwiInstallError } from './install-error.js';
import {
  ensureKiwiModelArtifact,
  inspectKiwiModelArtifact,
  probeKiwiModelArtifactIdentity,
  type KiwiModelArtifactInstallResult,
  type KiwiModelArtifactState,
} from './model-artifact.js';
import { type KiwiPackageOperationOptions, withKiwiPackageOperationLock } from './operation-lock.js';
import { kiwiDataDir } from './paths.js';
import {
  ensureKiwiWasmArtifactLocked,
  inspectKiwiWasmArtifact,
  probeKiwiWasmArtifactIdentity,
  type KiwiWasmArtifactState,
  type KiwiWasmInstallOptions,
} from './wasm-artifact.js';

export type KiwiArtifactComponent = 'model' | 'wasm';

export type KiwiArtifactState = {
  readonly ready: boolean;
  readonly model: KiwiModelArtifactState;
  readonly wasm: KiwiWasmArtifactState;
  readonly missingComponents: readonly KiwiArtifactComponent[];
};

type KiwiArtifactInstallSuccess = {
  readonly status: 'installed' | 'updated' | 'already_installed' | 'already_up_to_date';
  readonly method: 'runtime-download';
  readonly version: string;
  readonly targetDir: string;
};

export type KiwiArtifactInstallResult = KiwiArtifactInstallSuccess | KiwiInstallError;

type EnsureModelArtifact = typeof ensureKiwiModelArtifact;
type EnsureWasmArtifact = typeof ensureKiwiWasmArtifactLocked;

export type KiwiArtifactInstallOptions = KiwiPackageOperationOptions &
  KiwiWasmInstallOptions & {
    readonly update?: boolean;
    readonly ensureModelArtifact?: EnsureModelArtifact;
    readonly ensureWasmArtifact?: EnsureWasmArtifact;
  };

export function probeKiwiArtifactIdentity(runtime: Pick<Runtime, 'paths' | 'storage'>): string {
  return JSON.stringify({
    model: probeKiwiModelArtifactIdentity(runtime),
    wasm: probeKiwiWasmArtifactIdentity(runtime),
  });
}

export function inspectKiwiArtifact(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiArtifactState {
  const model = inspectKiwiModelArtifact(runtime);
  const wasm = inspectKiwiWasmArtifact(runtime);
  const missingComponents: KiwiArtifactComponent[] = [];
  if (!model.installed) {
    missingComponents.push('model');
  }
  if (!wasm.installed) {
    missingComponents.push('wasm');
  }
  return {
    ready: missingComponents.length === 0,
    model,
    wasm,
    missingComponents,
  };
}

export function hasKiwiArtifact(runtime: Pick<Runtime, 'paths' | 'storage'>): boolean {
  return inspectKiwiArtifact(runtime).ready;
}

export function hasKiwiArtifactDurableState(runtime: Pick<Runtime, 'paths' | 'storage'>): boolean {
  const dataDir = kiwiDataDir(runtime);
  try {
    if (!runtime.storage.statSync(dataDir).isDirectory()) {
      return false;
    }
    return runtime.storage.readdirSync(dataDir, { withFileTypes: true }).length > 0;
  } catch {
    return false;
  }
}

export function kiwiArtifactStateKey(state: KiwiArtifactState): string {
  return JSON.stringify({
    ready: state.ready,
    missingComponents: state.missingComponents,
    model: {
      installed: state.model.installed,
      missingFiles: state.model.missingFiles,
      manifest: state.model.manifest,
    },
    wasm: {
      installed: state.wasm.installed,
      reason: state.wasm.reason,
      payloadSha256: state.wasm.payloadSha256,
      manifest: state.wasm.manifest,
    },
  });
}

function isInstallError(
  result: KiwiModelArtifactInstallResult,
): result is Extract<KiwiModelArtifactInstallResult, { status: 'error' }> {
  return result.status === 'error';
}

function installResult(
  runtime: Pick<Runtime, 'paths'>,
  update: boolean | undefined,
  alreadyReady: boolean,
): KiwiArtifactInstallSuccess {
  return {
    status: alreadyReady
      ? update === true
        ? 'already_up_to_date'
        : 'already_installed'
      : update === true
        ? 'updated'
        : 'installed',
    method: 'runtime-download',
    version: KIWI_NLP_VERSION,
    targetDir: kiwiDataDir(runtime),
  };
}

function artifactInstallError(error: unknown): KiwiInstallError {
  const causeName = error instanceof Error ? error.name : typeof error;
  const causeMessage = errorMessage(error);
  const causeStack = error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined;
  const causeCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

  return kiwiInstallError('expansion_install_artifact_failed', {
    name: KIWI_INSTALL_ONLY_ID,
    detail: causeMessage,
    causeName,
    causeMessage,
    ...(causeStack === undefined ? {} : { causeStack }),
    ...(causeCode === undefined ? {} : { causeCode }),
  });
}

async function ensureKiwiArtifactLocked(
  runtime: Runtime,
  opts: KiwiArtifactInstallOptions,
): Promise<KiwiArtifactInstallResult> {
  const before = inspectKiwiArtifact(runtime);
  if (before.ready) {
    return installResult(runtime, opts.update, true);
  }

  if (!before.model.installed) {
    const modelResult = await (opts.ensureModelArtifact ?? ensureKiwiModelArtifact)(runtime, {
      update: opts.update,
      lockTimeoutMs: opts.lockTimeoutMs,
      logger: opts.logger,
      operationLockHeld: true,
    });
    if (isInstallError(modelResult)) {
      return modelResult;
    }
  }

  if (!inspectKiwiArtifact(runtime).wasm.installed) {
    try {
      const wasmResult = await (opts.ensureWasmArtifact ?? ensureKiwiWasmArtifactLocked)(runtime, {
        logger: opts.logger,
        download: opts.download,
        extract: opts.extract,
      });
      if (!wasmResult.installed) {
        return artifactInstallError(
          new Error(`Kiwi WASM artifact install completed without readiness: ${wasmResult.reason ?? 'unknown reason'}`),
        );
      }
    } catch (error: unknown) {
      if (isInstallPathUnwritableError(error)) {
        throw error;
      }
      return artifactInstallError(error);
    }
  }

  const installed = inspectKiwiArtifact(runtime);
  if (!installed.ready) {
    throw new Error(`Kiwi artifact install completed without readiness: ${installed.missingComponents.join(', ')}`);
  }
  return installResult(runtime, opts.update, false);
}

export async function ensureKiwiArtifact(
  runtime: Runtime,
  opts: KiwiArtifactInstallOptions = {},
): Promise<KiwiArtifactInstallResult> {
  try {
    return await withKiwiPackageOperationLock(runtime, opts, () => ensureKiwiArtifactLocked(runtime, opts));
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return kiwiInstallError('expansion_install_path_unwritable', { name: KIWI_INSTALL_ONLY_ID });
    }
    return artifactInstallError(error);
  }
}
