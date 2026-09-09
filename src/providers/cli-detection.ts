import type { EnvPort, SpawnFailureEvidence, StoragePort } from '../infra/port-types.js';
import { classifyExecOutcome, classifySpawnFailure } from '../infra/port-types.js';
import { assertNever } from '../infra/error-format.js';
import type { ProcessPort } from '../runtime/ports.js';

/** Only command-scoped unavailability may be cached across probes. */
export type CliInfo =
  | { available: false; reason: 'command-could-not-start'; error: string }
  | { available: false; reason: 'version-check-failed'; error: string }
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
  storage: Pick<StoragePort, 'observeDirectoryTraversabilitySync' | 'statSync'>;
};
export type CliDetectorEnvPort = Pick<EnvPort, 'get'>;

export type CliDetectorConfig = {
  binaryName: string;
  versionArgs: readonly string[];
  authEnvVar: string;
  authCommand: readonly string[];
  authErrorPattern: RegExp;
  authErrorMessage: string;
  parseAuthOutput?: (stdout: string) => AuthProbeResult | null;
};

function cliInfoFromSpawnFailure(
  processPort: CliDetectorProcessPort,
  config: CliDetectorConfig,
  command: string,
  evidence: SpawnFailureEvidence,
): CliInfo {
  switch (evidence.kind) {
    case 'command-could-not-start':
      return {
        available: false,
        reason: 'command-could-not-start',
        error: `Could not start \`${command}\` using the Coral daemon's PATH (ENOENT); ensure \`${config.binaryName}\` is installed and runnable at a location on that PATH, and restart the Coral backend after changing that PATH before retrying.`,
      };
    case 'command-not-executable':
      if (evidence.code === 'ENOTDIR') {
        return {
          available: false,
          reason: 'invalid-path',
          error: `Could not run \`${command}\` because the Coral daemon's PATH resolves \`${config.binaryName}\` through a component that is not a directory (${evidence.code}); correct that PATH, restart the Coral backend, then retry.`,
        };
      }
      return {
        available: false,
        reason: 'permission-denied',
        error: `Could not run \`${command}\` because the executable selected by the Coral daemon's PATH may not be executed by the daemon user (${evidence.code}); fix that executable's permissions, or correct the daemon's PATH and restart the Coral backend, then retry.`,
      };
    case 'working-directory-missing':
      return {
        available: false,
        reason: 'invalid-working-directory',
        error: `Could not run \`${command}\` because working directory \`${processPort.cwd}\` does not exist; restore it or choose another working directory, then retry.`,
      };
    case 'working-directory-not-directory':
      return {
        available: false,
        reason: 'invalid-working-directory',
        error: `Could not run \`${command}\` because working directory \`${processPort.cwd}\` is not a directory; choose a directory, then retry.`,
      };
    case 'working-directory-not-traversable':
      return {
        available: false,
        reason: 'invalid-working-directory',
        error: `Could not run \`${command}\` because working directory \`${processPort.cwd}\` is not traversable by the user running the Coral daemon; grant that user search permission or choose another working directory, then retry.`,
      };
    case 'unresolved':
      return {
        available: false,
        reason: 'undetermined',
        error: `Could not determine whether \`${command}\` failed because of the command or working directory \`${processPort.cwd}\` (${evidence.code}); verify that the directory exists and is traversable by the user running the Coral daemon, then retry.`,
      };
    default:
      return assertNever(evidence);
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
          error: `Could not run \`${command}\` to check (${outcome.detail}); this does not mean ${config.binaryName} is missing, so retry the command in a moment.`,
        };
      case 'launch-refused':
        return cliInfoFromSpawnFailure(
          processPort,
          config,
          command,
          classifySpawnFailure(processPort.storage, processPort.cwd, outcome.code),
        );
      case 'answered':
        return outcome.status === 0
          ? { available: true, version: result.stdout.trim(), authState: 'unknown' }
          : {
              available: false,
              reason: 'version-check-failed',
              error: `\`${command}\` exited with status ${outcome.status} instead of reporting a version; ensure \`${config.binaryName}\` runs correctly for the user running the Coral daemon, then retry.`,
            };
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
