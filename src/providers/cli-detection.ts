import type { EnvPort } from '../infra/port-types.js';
import { classifyExecOutcome } from '../infra/port-types.js';
import type { ProcessPort } from '../runtime/ports.js';

/** Unavailable answers are cacheable only when their reason is an established condition of this command. */
export type CliInfo =
  | { available: false; reason: 'not-found'; error: string }
  | { available: false; reason: 'permission-denied'; error: string }
  | { available: false; reason: 'invalid-path'; error: string }
  | { available: false; reason: 'undetermined'; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

export type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

export type CliDetectorProcessPort = Pick<ProcessPort, 'exec'>;
export type CliDetectorEnvPort = Pick<EnvPort, 'get'>;

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

export function createCliDetector(
  processPort: CliDetectorProcessPort,
  envPort: CliDetectorEnvPort,
  config: CliDetectorConfig,
): { detect: () => Promise<CliInfo>; resetCache: () => void } {
  /**
   * Answers only. A probe that could not be answered is not remembered at all, and deliberately so.
   */
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
    // A non-answer is returned and forgotten: caching it would let one unobserved fork failure answer for
    // every later call, which is the collapse the `reason` split above exists to end.
    if (!cli.available && cli.reason === 'undetermined') return cli;
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
        // ENOENT establishes absence, EACCES/EPERM establish denied execution, and ENOTDIR establishes an
        // invalid command path; only an answered probe may establish a verdict about command behavior.
        switch (outcome.code) {
          case 'ENOENT':
            return { available: false, reason: 'not-found', error: config.notFoundMessage };
          case 'EACCES':
          case 'EPERM':
            return {
              available: false,
              reason: 'permission-denied',
              error: `could not run \`${command}\` (${outcome.code}); check execute permissions on \`${config.binaryName}\` and for the user running the Coral daemon, then retry`,
            };
          case 'ENOTDIR':
            return {
              available: false,
              reason: 'invalid-path',
              error: `could not run \`${command}\` (ENOTDIR); a component of the configured command path \`${config.binaryName}\` is not a directory — correct the configured path, then retry`,
            };
          default:
            return {
              available: false,
              reason: 'undetermined',
              error: `could not run \`${command}\` because the launch refusal (${outcome.code}) is not classified — retry the command`,
            };
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
