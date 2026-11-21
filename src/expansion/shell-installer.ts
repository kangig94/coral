import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  findEquippedTool,
  isExecutableFile,
  standardToolPath,
  type EquippedAgentTool,
} from '../../clients/hooks/lib/equip-tools.mjs';
import { isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { CoralSetupErrorContext } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import type { EngineInstaller, EngineInstallerOptions, LocalExpansionInstallState } from './contract.js';
import { assertExpansionPackageId } from './package-id.js';
import type { InstallError } from './rpc-contract.js';
import { acquirePackageOperationLock } from './package-lock.js';
import { PACKAGE_OPERATION_LOCK_TIMEOUT_MS } from '../infra/package-operation-lock.js';

const INSTALL_TIMEOUT_MS = 300_000;

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

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRegularFile(runtime: Runtime, path: string): boolean {
  try {
    return runtime.storage.lstatSync(path).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function realpathIfPresent(runtime: Runtime, path: string): string | null {
  try {
    return runtime.storage.realpathSync(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

type LegacyCopy =
  | { kind: 'absent' }
  | { kind: 'migratable'; canonicalPath: string }
  | { kind: 'retained'; reason: string }
  | { kind: 'aliases-standard'; reason: string };

function inspectLegacyCopy(runtime: Runtime, path: string, standard: string): LegacyCopy {
  try {
    if (!runtime.storage.lstatSync(path).isFile()) {
      return { kind: 'retained', reason: 'The path is not a regular file. Inspect it before removing it manually.' };
    }
  } catch (error) {
    if (isMissing(error)) return { kind: 'absent' };
    return { kind: 'retained', reason: 'Coral could not inspect the path. Restore access before rechecking it.' };
  }

  const parent = dirname(path);
  const stateRootParent = dirname(dirname(runtime.paths.coral.generation.root));
  try {
    const expectedParent = resolve(runtime.storage.realpathSync(stateRootParent), relative(stateRootParent, parent));
    if (!runtime.storage.lstatSync(parent).isDirectory() || runtime.storage.realpathSync(parent) !== expectedParent) {
      return {
        kind: 'retained',
        reason:
          "The legacy engine directory is symlinked or outside its canonical location. Restore a real directory at Coral's expected engine path before retrying migration.",
      };
    }
    const canonicalPath = join(expectedParent, basename(path));
    if (realpathIfPresent(runtime, standard) === canonicalPath) {
      return {
        kind: 'aliases-standard',
        reason: `The standard path ${standard} resolves to the legacy copy at ${path}. Use a standard directory outside the Coral engine tree and retry.`,
      };
    }
    if (!runtime.storage.lstatSync(canonicalPath).isFile()) {
      return {
        kind: 'retained',
        reason: 'The canonical path is not a regular file. Inspect it before removing it manually.',
      };
    }
    return { kind: 'migratable', canonicalPath };
  } catch {
    return {
      kind: 'retained',
      reason: 'Coral could not verify the canonical engine or standard path. Restore access before retrying migration.',
    };
  }
}

function legacyStatus(copy: LegacyCopy, path: string, name: string): { statusDescription?: string } {
  switch (copy.kind) {
    case 'absent':
      return {};
    case 'migratable':
      return { statusDescription: `Legacy Coral copy at ${path}. Run '/equip ${name}' to migrate it.` };
    default:
      return { statusDescription: `Legacy Coral path at ${path} is retained. ${copy.reason}` };
  }
}

function isLocked(runtime: Runtime, lockPath: string): boolean {
  try {
    return runtime.storage.statSync(lockPath).isDirectory();
  } catch {
    return false;
  }
}

// Serialize direct installer calls behind the shared package-operation lock.
async function withInstallLock<T>(opts: EngineInstallerOptions, run: () => Promise<T>): Promise<T | InstallError> {
  if (opts.operationLockHeld === true) {
    return run();
  }

  let release: Awaited<ReturnType<typeof acquirePackageOperationLock>>;
  try {
    release = await acquirePackageOperationLock(
      opts.runtime,
      opts.name,
      opts.lockTimeoutMs ?? PACKAGE_OPERATION_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', { name: opts.name });
    }
    throw error;
  }

  try {
    const result = await run();
    release.assertOwned();
    return result;
  } finally {
    release();
  }
}

export function createShellInstaller(tool: EquippedAgentTool, installCommand: string): EngineInstaller {
  const packageId = assertExpansionPackageId(tool.id);

  function assertInstallerIdentity(name: string): void {
    if (name !== packageId) {
      throw new Error(`Shell installer identity mismatch: expected '${packageId}', got '${name}'`);
    }
  }

  function legacyBinaryPath(runtime: Runtime): string {
    return join(runtime.paths.coral.engine.dataDir(packageId), tool.bin);
  }

  function installedBinary(runtime: Runtime): string | null {
    return findEquippedTool(tool, runtime.env, runtime.storage, legacyBinaryPath(runtime));
  }

  return {
    installTargetDir: (runtime) => dirname(standardToolPath(tool, runtime.env.homedir())),

    inspect(runtime, name): LocalExpansionInstallState {
      assertInstallerIdentity(name);
      const binary = installedBinary(runtime);
      const legacy = legacyBinaryPath(runtime);
      const installLockPath = runtime.paths.coral.engine.installLockPath(name);
      const standard = standardToolPath(tool, runtime.env.homedir());
      return {
        targetDir: dirname(standard),
        addonPath: binary,
        installLockPath,
        version: null,
        method: binary === null ? null : 'shell',
        installed: binary !== null,
        installLocked: isLocked(runtime, installLockPath),
        durableState: binary !== null,
        ...legacyStatus(inspectLegacyCopy(runtime, legacy, standard), legacy, name),
      };
    },

    async install(opts: EngineInstallerOptions): Promise<unknown> {
      assertInstallerIdentity(opts.name);
      return withInstallLock(opts, async () => {
        const { runtime, name, version } = opts;
        const binary = installedBinary(runtime);
        const legacy = legacyBinaryPath(runtime);
        const standard = standardToolPath(tool, runtime.env.homedir());
        const targetDir = dirname(standard);
        const legacyBefore = inspectLegacyCopy(runtime, legacy, standard);
        if (legacyBefore.kind === 'aliases-standard') {
          return toInstallError('expansion_install_command_failed', { name, detail: legacyBefore.reason });
        }
        if (binary !== null && opts.update !== true && legacyBefore.kind !== 'migratable') {
          return {
            status: 'already_installed',
            method: 'shell',
            version,
            command: binary,
            targetDir,
            ...legacyStatus(legacyBefore, legacy, name),
          };
        }

        if (opts.update === true && binary !== null && (binary !== standard || !isRegularFile(runtime, standard))) {
          return toInstallError('expansion_external_tool_managed', { name, path: binary, operation: 'update' });
        }

        const result = await runtime.process.exec('bash', ['-o', 'pipefail', '-c', installCommand], {
          timeout: INSTALL_TIMEOUT_MS,
          inheritEnv: true,
          encoding: 'utf-8',
        });
        if (result.status !== 0 || result.error) {
          const detail = result.stderr.trim() || result.error?.message.trim();
          return toInstallError('expansion_install_command_failed', { name, ...(detail ? { detail } : {}) });
        }

        if (!isExecutableFile(runtime.storage, standard) || !isRegularFile(runtime, standard)) {
          return toInstallError('expansion_install_command_failed', {
            name,
            detail: `Install command completed without placing an executable file at ${standard}.`,
          });
        }
        const legacyAfter = inspectLegacyCopy(runtime, legacy, standard);
        if (legacyAfter.kind === 'aliases-standard') {
          return toInstallError('expansion_install_command_failed', { name, detail: legacyAfter.reason });
        }
        const migrated = legacyBefore.kind !== 'absent' && legacyAfter.kind === 'migratable';
        if (migrated) {
          runtime.storage.rmSync(legacyAfter.canonicalPath, { force: true });
        }

        const command = installedBinary(runtime);
        if (command === null) {
          return toInstallError('expansion_install_command_failed', {
            name,
            detail: 'The installed executable could no longer be resolved after installation.',
          });
        }
        return {
          status: opts.update === true ? 'updated' : 'installed',
          method: 'shell',
          version,
          command,
          targetDir,
          ...(migrated ? {} : legacyStatus(legacyAfter, legacy, name)),
        };
      });
    },

    async uninstall(opts: EngineInstallerOptions): Promise<unknown> {
      assertInstallerIdentity(opts.name);
      return withInstallLock(opts, async () => {
        const binary = installedBinary(opts.runtime);
        return binary === null
          ? { status: 'not_equipped' }
          : toInstallError('expansion_external_tool_managed', {
              name: opts.name,
              path: binary,
              operation: 'uninstall',
            });
      });
    },
  };
}
