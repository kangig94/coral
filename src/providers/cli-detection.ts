import { execFile } from 'node:child_process';

export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export type CliInfo =
  | { available: false; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

export type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

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

export function createCliDetector(config: CliDetectorConfig): {
  detect: () => Promise<CliInfo>;
  resetCache: () => void;
} {
  let cachedCli: CliInfo | null = null;
  let inFlightProbe: Promise<CliInfo> | null = null;
  let confirmedAuth = false;

  return { detect, resetCache };

  async function detect(): Promise<CliInfo> {
    if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) {
      return cachedCli;
    }

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
    const cli = cachedCli ?? await queryCliVersion();
    cachedCli = cli;
    if (!cli.available) return cli;

    const auth = await queryAuthState();
    if (auth.authState === 'authenticated') {
      confirmedAuth = true;
      cachedCli = { available: true, version: cli.version, authState: 'authenticated' };
      return cachedCli;
    }

    if (auth.authState === 'unauthenticated') {
      cachedCli = {
        available: true,
        version: cli.version,
        authState: 'unauthenticated',
        authError: auth.authError,
      };
      return cachedCli;
    }

    cachedCli = { available: true, version: cli.version, authState: 'unknown' };
    return cachedCli;
  }

  function queryCliVersion(): Promise<CliInfo> {
    return new Promise<CliInfo>((resolve) => {
      execFile(
        config.binaryName,
        [...config.versionArgs],
        { timeout: 10_000, encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            resolve({ available: false, error: config.notFoundMessage });
            return;
          }

          resolve({ available: true, version: stdout.trim(), authState: 'unknown' });
        },
      );
    });
  }

  function queryAuthState(): Promise<AuthProbeResult> {
    if (process.env[config.authEnvVar]?.trim()) {
      return Promise.resolve({ authState: 'authenticated' });
    }

    return new Promise<AuthProbeResult>((resolve) => {
      execFile(
        config.binaryName,
        [...config.authCommand],
        { timeout: 5_000, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) {
            if (!config.parseAuthOutput) {
              resolve({ authState: 'authenticated' });
              return;
            }

            const parsed = config.parseAuthOutput(stdout);
            if (parsed !== null) {
              resolve(parsed);
              return;
            }
          }

          const output = `${stdout}\n${stderr}`;
          if (config.authErrorPattern.test(output)) {
            resolve({
              authState: 'unauthenticated',
              authError: config.authErrorMessage,
            });
            return;
          }

          resolve({ authState: 'unknown' });
        },
      );
    });
  }
}
