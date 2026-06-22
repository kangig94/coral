import type { EngineInstaller, EngineInstallerOptions, LocalExpansionInstallState } from '../../expansion/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import { KIWI_INSTALL_ONLY_ID, KIWI_MODEL_VERSION } from './constants.js';
import { ensureKiwiModelArtifact, hasKiwiDurableState, inspectKiwiModelArtifact } from './model-artifact.js';
import { kiwiDataDir } from './paths.js';

function isInstallLocked(runtime: Runtime): boolean {
  try {
    runtime.storage.statSync(runtime.paths.coral.engine.installLockPath(KIWI_INSTALL_ONLY_ID));
    return true;
  } catch {
    return false;
  }
}

export const kiwiInstaller: EngineInstaller = {
  inspect(runtime, name): LocalExpansionInstallState {
    const state = inspectKiwiModelArtifact(runtime);
    return {
      targetDir: kiwiDataDir(runtime),
      addonPath: null,
      installLockPath: runtime.paths.coral.engine.installLockPath(name),
      version: state.manifest?.modelVersion ?? null,
      method: state.installed ? 'github-release' : null,
      installed: state.installed,
      installLocked: isInstallLocked(runtime),
      durableState: state.installed || hasKiwiDurableState(runtime),
    };
  },
  async install(ctx: EngineInstallerOptions): Promise<unknown> {
    return ensureKiwiModelArtifact(ctx.runtime, {
      logger: ctx.logger,
      lockTimeoutMs: ctx.lockTimeoutMs,
      update: ctx.update,
    });
  },
  async uninstall(ctx: EngineInstallerOptions): Promise<unknown> {
    const current = kiwiInstaller.inspect(ctx.runtime, KIWI_INSTALL_ONLY_ID);
    ctx.runtime.storage.rmSync(kiwiDataDir(ctx.runtime), { recursive: true, force: true });
    return { status: current.durableState ? 'uninstalled' : 'not_equipped' };
  },
};

export const KIWI_INSTALLER_VERSION = KIWI_MODEL_VERSION;
