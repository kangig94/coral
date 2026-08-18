import type { EnvPort, TimePort } from '../infra/port-types.js';
import { INDECISIVE_PROBE_REPROBE_INTERVAL_MS, STANDING_PROBE_ERRNOS } from '../infra/process-constants.js';
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
export type CliDetectorTimePort = Pick<TimePort, 'now'>;

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

type UndeterminedCli = Extract<CliInfo, { reason: 'undetermined' }>;

export function createCliDetector(
  processPort: CliDetectorProcessPort,
  envPort: CliDetectorEnvPort,
  config: CliDetectorConfig,
  timePort: CliDetectorTimePort,
): { detect: () => Promise<CliInfo>; resetCache: () => void } {
  /** Answers only. A probe that could not be answered is held below instead, and expires. */
  let cachedCli: CliInfo | null = null;
  let heldUndetermined: { info: UndeterminedCli; at: number } | null = null;
  let inFlightProbe: Promise<CliInfo> | null = null;
  let confirmedAuth = false;

  return { detect, resetCache };

  async function detect(): Promise<CliInfo> {
    if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) return cachedCli;
    if (inFlightProbe !== null) return inFlightProbe;
    // A non-answer is not remembered as one, but re-forking on every call is its own failure: `detect` runs on
    // each provider preflight, so a machine that cannot fork would pay the 10s bound per operation. Held for
    // one interval, then asked again — a recovered machine heals without a daemon restart.
    //
    // Whether any of this state survives between calls is the caller's to decide: a provider that builds fresh
    // port objects per probe gets a fresh detector from its own memoiser and keeps nothing. One such caller
    // exists today and its own module records it. The type split above holds regardless — it is about what
    // this answers, not about how long the answer is kept.
    if (heldUndetermined !== null) {
      if (timePort.now() - heldUndetermined.at < INDECISIVE_PROBE_REPROBE_INTERVAL_MS) return heldUndetermined.info;
      heldUndetermined = null;
    }
    inFlightProbe = runProbe().finally(() => {
      inFlightProbe = null;
    });
    return inFlightProbe;
  }

  function resetCache(): void {
    cachedCli = null;
    heldUndetermined = null;
    inFlightProbe = null;
    confirmedAuth = false;
  }

  async function runProbe(): Promise<CliInfo> {
    const cli = cachedCli ?? (await queryCliVersion());
    if (!cli.available && cli.reason === 'undetermined') {
      heldUndetermined = { info: cli, at: timePort.now() };
      return cli;
    }
    heldUndetermined = null;
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

    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      // Everything the launch failed on that is not a standing fact about this machine is a non-answer,
      // including an error carrying no recognisable code at all. That default is the opposite of the one
      // `git-sync.ts` takes on its own probe, and deliberately: there, a codeless error is a known synthesis
      // meaning git ran and exited, so it decides. Here nothing guarantees that, and the wrong guess is not a
      // wasted fork — it is telling an operator to install software they already have.
      if (typeof code !== 'string' || !STANDING_PROBE_ERRNOS.has(code)) {
        return {
          available: false,
          reason: 'undetermined',
          error: `could not run \`${config.binaryName} ${config.versionArgs.join(' ')}\` to check (${
            code ?? result.error.message
          }); this is not a statement that ${config.binaryName} is missing`,
        };
      }
      return { available: false, reason: 'not-found', error: config.notFoundMessage };
    }

    // No launch failure: the binary ran. A non-zero exit is it answering that it cannot report a version,
    // which is as settled as an absent binary and is cached the same way.
    if (result.status !== null && result.status !== 0) {
      return { available: false, reason: 'not-found', error: config.notFoundMessage };
    }
    return { available: true, version: result.stdout.trim(), authState: 'unknown' };
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
