import type { EnvPort, StoragePort } from '../infra/port-types.js';
import { classifyExecOutcome } from '../infra/port-types.js';
import { assertNever } from '../infra/error-format.js';
import type { ProcessPort } from '../runtime/ports.js';

/** Only command-scoped unavailability may be cached across probes. */
export type CliInfo =
  | { available: false; reason: 'not-found'; error: string }
  | { available: false; reason: 'permission-denied'; error: string }
  | { available: false; reason: 'invalid-path'; error: string }
  | { available: false; reason: 'invalid-working-directory'; error: string }
  | { available: false; reason: 'undetermined'; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

export type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

export type CliDetectorProcessPort = Pick<ProcessPort, 'exec'> & {
  cwd: string;
  storage: Pick<StoragePort, 'statSync'>;
};
export type CliDetectorEnvPort = Pick<EnvPort, 'get'>;

type WorkingDirectoryObservation = 'directory' | 'missing' | 'not-directory' | 'unobserved';

export type CliDetectorConfig = {
  binaryName: string;
  versionArgs: readonly string[];
  notFoundMessage: string;
  authEnvVar: string;
  authCommand: readonly string[];
  authErrorPattern: RegExp;
  authErrorMessage: string;
  parseAuthOutput?: (stdout: string) => AuthProbeResult | null;
};

function observeWorkingDirectory(port: CliDetectorProcessPort): WorkingDirectoryObservation {
  try {
    return port.storage.statSync(port.cwd).isDirectory() ? 'directory' : 'not-directory';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return 'missing';
    if (code === 'ENOTDIR') return 'not-directory';
    return 'unobserved';
  }
}

export function createCliDetector(
  processPort: CliDetectorProcessPort,
  envPort: CliDetectorEnvPort,
  config: CliDetectorConfig,
): { detect: () => Promise<CliInfo>; resetCache: () => void } {
  /** Command-scoped answers only; request-scoped and unobserved outcomes must be re-probed. */
  let cachedCli: CliInfo | null = null;
  let inFlightProbe: Promise<CliInfo> | null = null;
  let confirmedAuth = false;

  return { detect, resetCache };

  async function detect(): Promise<CliInfo> {
    if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) return cachedCli;
    if (inFlightProbe !== null) return inFlightProbe;
    inFlightProbe = runProbe().finally(() => {
      inFlightProbe = null;
    });
    return inFlightProbe;
  }

  function resetCache(): void {
    cachedCli = null;
    inFlightProbe = null;
    confirmedAuth = false;
  }

  async function runProbe(): Promise<CliInfo> {
    const cli = cachedCli ?? (await queryCliVersion());
    // Request-scoped and unobserved failures must not survive into a later request through this cache.
    if (!cli.available && (cli.reason === 'invalid-working-directory' || cli.reason === 'undetermined')) return cli;
    cachedCli = cli;
    if (!cli.available) return cli;

    const availableCli = { available: true as const, version: cli.version };
    const auth = await queryAuthState();
    switch (auth.authState) {
      case 'authenticated':
        confirmedAuth = true;
        cachedCli = { ...availableCli, authState: 'authenticated' };
        return cachedCli;
      case 'unauthenticated':
        cachedCli = { ...availableCli, authState: 'unauthenticated', authError: auth.authError };
        return cachedCli;
      case 'unknown':
        cachedCli = { ...availableCli, authState: 'unknown' };
        return cachedCli;
    }
  }

  async function queryCliVersion(): Promise<CliInfo> {
    const result = await processPort.exec(config.binaryName, [...config.versionArgs], {
      timeout: 10_000,
      encoding: 'utf-8',
    });

    const command = `${config.binaryName} ${config.versionArgs.join(' ')}`;
    const outcome = classifyExecOutcome(result);
    switch (outcome.kind) {
      case 'no-answer':
        return {
          available: false,
          reason: 'undetermined',
          error: `could not run \`${command}\` to check (${outcome.detail}); this does not mean ${config.binaryName} is missing — retry the command in a moment`,
        };
      case 'launch-refused':
        // Measured on Node v26.3.1: child_process.spawn reports ENOENT with error.path set to the command for
        // both a missing command and a missing cwd, and synchronously throws ENOTDIR when an existing command
        // is given a cwd that is a file.
        switch (outcome.code) {
          case 'ENOENT':
          case 'ENOTDIR': {
            const cwd = observeWorkingDirectory(processPort);
            switch (cwd) {
              case 'missing':
                return {
                  available: false,
                  reason: 'invalid-working-directory',
                  error: `could not run \`${command}\` because working directory \`${processPort.cwd}\` does not exist; restore it or choose another working directory, then retry`,
                };
              case 'not-directory':
                return {
                  available: false,
                  reason: 'invalid-working-directory',
                  error: `could not run \`${command}\` because working directory \`${processPort.cwd}\` is not a directory; choose a directory, then retry`,
                };
              case 'unobserved':
                return {
                  available: false,
                  reason: 'undetermined',
                  error: `could not inspect working directory \`${processPort.cwd}\` after \`${command}\` failed to launch (${outcome.code}); whether ${config.binaryName} is installed was not established — check that the working directory is accessible, then retry`,
                };
              case 'directory':
                return outcome.code === 'ENOENT'
                  ? { available: false, reason: 'not-found', error: config.notFoundMessage }
                  : {
                      available: false,
                      reason: 'invalid-path',
                      error: `could not run \`${command}\` (ENOTDIR); a component of the configured command path \`${config.binaryName}\` is not a directory — correct the configured path, then retry`,
                    };
              default:
                return assertNever(cwd);
            }
          }
          case 'EACCES':
          case 'EPERM':
            return {
              available: false,
              reason: 'permission-denied',
              error: `could not run \`${command}\` (${outcome.code}); check execute permissions on \`${config.binaryName}\` and for the user running the Coral daemon, then retry`,
            };
          default:
            return assertNever(outcome.code);
        }
      case 'answered':
        // A non-zero exit is the binary answering that it cannot report a version, which is as settled as an
        // absent one and is cached the same way.
        return outcome.status === 0
          ? { available: true, version: result.stdout.trim(), authState: 'unknown' }
          : { available: false, reason: 'not-found', error: config.notFoundMessage };
    }
  }

  async function queryAuthState(): Promise<AuthProbeResult> {
    if (envPort.get(config.authEnvVar)?.trim()) return { authState: 'authenticated' };

    const result = await processPort.exec(config.binaryName, [...config.authCommand], {
      timeout: 5_000,
      encoding: 'utf-8',
    });
    if (!result.error && result.status === 0) {
      if (config.parseAuthOutput === undefined) return { authState: 'authenticated' };
      const parsed = config.parseAuthOutput(result.stdout);
      if (parsed !== null) return parsed;
    }

    if (config.authErrorPattern.test(`${result.stdout}\n${result.stderr}`)) {
      return { authState: 'unauthenticated', authError: config.authErrorMessage };
    }
    return { authState: 'unknown' };
  }
}
