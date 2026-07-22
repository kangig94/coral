import type { EnvPort } from '../infra/port-types.js';
import type { ProcessPort } from '../runtime/ports.js';

export type CliInfo =
  | { available: false; error: string }
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
    if (result.error || (result.status !== null && result.status !== 0)) {
      return { available: false, error: config.notFoundMessage };
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
