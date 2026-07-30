import type { EngineInstaller, EngineInstallerOptions, LocalExpansionInstallState } from '../../expansion/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import { ensureKiwiArtifact, hasKiwiArtifactDurableState, inspectKiwiArtifact } from './artifact.js';
import { KIWI_INSTALL_ONLY_ID, KIWI_NLP_VERSION } from './constants.js';
import { withKiwiPackageOperationLock } from './operation-lock.js';
import { kiwiDataDir } from './paths.js';

function isInstallLocked(runtime: Runtime): boolean {
  try {
    runtime.storage.statSync(runtime.paths.coral.engine.installLockPath(KIWI_INSTALL_ONLY_ID));
    return true;
  } catch {
    return false;
  }
}

function assertKiwiInstallerIdentity(name: string): void {
  if (name !== KIWI_INSTALL_ONLY_ID) {
    throw new Error(`Kiwi installer identity mismatch: expected '${KIWI_INSTALL_ONLY_ID}', got '${name}'`);
  }
}

export const kiwiInstaller: EngineInstaller = {
  inspect(runtime, name): LocalExpansionInstallState {
    assertKiwiInstallerIdentity(name);
    const state = inspectKiwiArtifact(runtime);
    return {
      targetDir: kiwiDataDir(runtime),
      addonPath: null,
      installLockPath: runtime.paths.coral.engine.installLockPath(name),
      version: state.ready ? KIWI_NLP_VERSION : null,
      method: state.ready ? 'runtime-download' : null,
      installed: state.ready,
      installLocked: isInstallLocked(runtime),
      durableState: hasKiwiArtifactDurableState(runtime),
    };
  },
  async install(ctx: EngineInstallerOptions): Promise<unknown> {
    assertKiwiInstallerIdentity(ctx.name);
    return ensureKiwiArtifact(ctx.runtime, {
      logger: ctx.logger,
      lockTimeoutMs: ctx.lockTimeoutMs,
      update: ctx.update,
      operationLockHeld: ctx.operationLockHeld,
    });
  },
  async uninstall(ctx: EngineInstallerOptions): Promise<unknown> {
    assertKiwiInstallerIdentity(ctx.name);
    return withKiwiPackageOperationLock(ctx.runtime, ctx, async () => {
      const current = kiwiInstaller.inspect(ctx.runtime, KIWI_INSTALL_ONLY_ID);
      ctx.runtime.storage.rmSync(kiwiDataDir(ctx.runtime), { recursive: true, force: true });
      return { status: current.durableState ? 'uninstalled' : 'not_equipped' };
    });
  },
};

export const KIWI_INSTALLER_VERSION = KIWI_NLP_VERSION;
