import type { EnvPort } from '../infra/port-types.js';
import { classifyExecOutcome } from '../infra/port-types.js';
import type { ProcessPort } from '../runtime/ports.js';

/**
 * Three answers about the binary, not two. `not-found` is a probe that ran and settled the question; the CLI
 * is absent, or present and unable to report a version. `undetermined` is a probe that never got an answer —
 * the 10s bound elapsed, or the system had no process slot to fork with — which says nothing about whether the
 * CLI is installed.
 *
 * The split is in the type rather than only in the caching because this value becomes a sentence an operator
 * reads. Collapsed, a timeout under load surfaced the configured `notFoundMessage`, which by its nature tells
 * someone to install the binary — instructing them to fix software they already have, and naming a cause that
 * was never observed. `authState` had modelled its own third answer from the beginning; availability had not.
 */
export type CliInfo =
  | { available: false; reason: 'not-found'; error: string }
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
        // The launch failed for a reason that will not change under a running daemon, so the configured
        // "install it" message is the right one and is worth caching.
        return { available: false, reason: 'not-found', error: config.notFoundMessage };
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
