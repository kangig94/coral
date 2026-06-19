import { acquireDirectoryLock, isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { CoralSetupErrorContext } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import type { EngineInstaller, EngineInstallerOptions, LocalExpansionInstallState } from './contract.js';
import type { InstallError } from './rpc-contract.js';

const INSTALL_LOCK_TIMEOUT_MS = 250;
const INSTALL_TIMEOUT_MS = 300_000;

/**
 * Declarative spec for an install-only package whose installation is a single
 * shell pipeline (e.g. `curl … | bash`). The binary lands under the package's
 * engine data directory so `unequip` can remove it by deleting that tree.
 */
export interface ShellInstallerSpec {
  /** Shell pipeline that installs the binary into `binDir`. */
  readonly buildInstallCommand: (binDir: string) => string;
  /** Absolute path to the binary that must exist after a successful install. */
  readonly binaryPath: (binDir: string) => string;
  /**
   * Update the already-installed binary in place (e.g. its own `update`
   * subcommand). When provided, `update` runs this instead of reinstalling.
   */
  readonly buildUpdateCommand?: (binary: string) => string;
  /**
   * Tear down side effects the binary registered outside its own directory
   * (e.g. agent configs / MCP registration) via its own `uninstall`
   * subcommand. Run best-effort before the binary directory is removed.
   */
  readonly buildUninstallCommand?: (binary: string) => string;
}

// Mirrors the installer-level error construction in src/engines/needle/install.ts;
// installExpansion re-validates the returned object against installResponseSchema.
function toInstallError(
  code: Parameters<typeof documentedCoralSetupError>[0],
  context: CoralSetupErrorContext,
): InstallError {
  const error = documentedCoralSetupError(code, context);
  return {
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  };
}

function dataDirOf(runtime: Runtime, name: string): string {
  return runtime.paths.coral.engine.dataDir(name);
}

function isFile(runtime: Runtime, path: string): boolean {
  try {
    return runtime.storage.statSync(path).isFile();
  } catch {
    return false;
  }
}

function isLocked(runtime: Runtime, lockPath: string): boolean {
  try {
    return runtime.storage.statSync(lockPath).isDirectory();
  } catch {
    return false;
  }
}

// Serialize install/uninstall behind the per-package directory lock, routing all
// lock I/O through the runtime ports (matching needle's withInstallLock).
async function withInstallLock<T>(opts: EngineInstallerOptions, run: () => Promise<T>): Promise<T | InstallError> {
  // The lock lives inside targetDir, so the directory must exist before
  // acquireDirectoryLock's non-recursive mkdir of the lock path.
  opts.runtime.storage.mkdirSync(dataDirOf(opts.runtime, opts.name), { recursive: true });

  let release: () => void;
  try {
    release = await acquireDirectoryLock(
      opts.runtime.paths.coral.engine.installLockPath(opts.name),
      { storage: opts.runtime.storage, time: opts.runtime.time },
      opts.lockTimeoutMs ?? INSTALL_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', { name: opts.name });
    }
    throw error;
  }

  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * Build an {@link EngineInstaller} for an install-only package. Installation
 * runs a shell pipeline; installed state is detected by the binary's presence;
 * uninstallation removes the package's engine data directory.
 */
export function createShellInstaller(spec: ShellInstallerSpec): EngineInstaller {
  function inspect(runtime: Runtime, name: string): LocalExpansionInstallState {
    const targetDir = dataDirOf(runtime, name);
    const installLockPath = runtime.paths.coral.engine.installLockPath(name);
    const binary = spec.binaryPath(targetDir);
    const installed = isFile(runtime, binary);
    return {
      targetDir,
      addonPath: installed ? binary : null,
      installLockPath,
      version: null,
      method: installed ? 'shell' : null,
      installed,
      installLocked: isLocked(runtime, installLockPath),
      durableState: installed,
    };
  }

  return {
    inspect,

    async install(opts: EngineInstallerOptions): Promise<unknown> {
      const targetDir = dataDirOf(opts.runtime, opts.name);
      const binary = spec.binaryPath(targetDir);
      const alreadyInstalled = isFile(opts.runtime, binary);

      if (alreadyInstalled && opts.update !== true) {
        return { status: 'already_installed', method: 'shell', version: opts.version, targetDir, command: binary };
      }

      // Update the installed binary in place when it can update itself; otherwise
      // (fresh install, or update with no self-update) run the full install pipeline.
      const selfUpdate = opts.update === true && alreadyInstalled ? spec.buildUpdateCommand : undefined;
      const command = selfUpdate ? selfUpdate(binary) : spec.buildInstallCommand(targetDir);

      return withInstallLock(opts, async () => {
        const result = await opts.runtime.process.exec('bash', ['-c', command], {
          timeout: INSTALL_TIMEOUT_MS,
          inheritEnv: true,
          encoding: 'utf-8',
        });

        if (result.status !== 0 || result.error) {
          const detail = (result.stderr.trim().length > 0 ? result.stderr : (result.error?.message ?? '')).trim();
          return toInstallError('expansion_install_command_failed', {
            name: opts.name,
            ...(detail.length > 0 ? { detail } : {}),
          });
        }

        if (!isFile(opts.runtime, binary)) {
          return toInstallError('expansion_install_command_failed', {
            name: opts.name,
            detail: `Install command completed but ${binary} is missing.`,
          });
        }

        return {
          status: opts.update === true ? 'updated' : 'installed',
          method: 'shell',
          version: opts.version,
          targetDir,
          command: binary,
        };
      });
    },

    async uninstall(opts: EngineInstallerOptions): Promise<unknown> {
      const targetDir = dataDirOf(opts.runtime, opts.name);
      const binary = spec.binaryPath(targetDir);
      if (!isFile(opts.runtime, binary)) {
        return { status: 'not_equipped' };
      }
      return withInstallLock(opts, async () => {
        // Let the binary tear down what it registered outside its own directory
        // (agent configs / MCP registration). Best-effort: its teardown is
        // advisory and we must still remove Coral's artifact regardless.
        if (spec.buildUninstallCommand !== undefined) {
          await opts.runtime.process
            .exec('bash', ['-c', spec.buildUninstallCommand(binary)], {
              timeout: INSTALL_TIMEOUT_MS,
              inheritEnv: true,
              encoding: 'utf-8',
            })
            .catch(() => undefined);
        }
        opts.runtime.storage.rmSync(targetDir, { recursive: true, force: true });
        return { status: 'uninstalled' };
      });
    },
  };
}
