import type { EnvPort } from '../infra/port-types.js';
import type { ProcessPort } from '../runtime/ports.js';

export type CliInfo =
  | { available: false; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

export type CliDetectorProcessPort = Pick<ProcessPort, 'exec'>;
export type CliDetectorEnvPort = Pick<EnvPort, 'get'>;

type CliDetectorConfig = {
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
): {
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
        cachedCli = {
          ...availableCli,
          authState: 'unauthenticated',
          authError: auth.authError,
        };
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
    if (envPort.get(config.authEnvVar)?.trim()) {
      return { authState: 'authenticated' };
    }

    const result = await processPort.exec(config.binaryName, [...config.authCommand], {
      timeout: 5_000,
      encoding: 'utf-8',
    });
    const succeeded = !result.error && result.status === 0;
    if (succeeded) {
      if (!config.parseAuthOutput) {
        return { authState: 'authenticated' };
      }
      const parsed = config.parseAuthOutput(result.stdout);
      if (parsed !== null) {
        return parsed;
      }
    }

    const output = `${result.stdout}\n${result.stderr}`;
    if (config.authErrorPattern.test(output)) {
      return {
        authState: 'unauthenticated',
        authError: config.authErrorMessage,
      };
    }

    return { authState: 'unknown' };
  }
}

// ── Codex ──────────────────────────────────────

/** @knipignore Reached through provider test fixtures. */
export const CODEX_DETECTOR_CONFIG: CliDetectorConfig = Object.freeze({
  binaryName: 'codex',
  versionArgs: Object.freeze(['--version']),
  notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  authEnvVar: 'OPENAI_API_KEY',
  authCommand: Object.freeze(['whoami']),
  authErrorPattern: /not logged in|unauthorized|unauthenticated|no api key|missing.*api.*key|authentication required/i,
  authErrorMessage: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
});

// ── Claude ─────────────────────────────────────

const CLAUDE_AUTH_ERROR_MESSAGE =
  'Claude CLI is not authenticated. Run "claude auth login" or set the ANTHROPIC_API_KEY environment variable.';

function parseClaudeAuthStatus(stdout: string): AuthProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.authenticated === 'boolean') {
      return parsed.authenticated
        ? { authState: 'authenticated' }
        : { authState: 'unauthenticated', authError: CLAUDE_AUTH_ERROR_MESSAGE };
    }

    let status: string | null = null;
    if (typeof parsed.status === 'string') {
      status = parsed.status;
    } else if (typeof parsed.auth_status === 'string') {
      status = parsed.auth_status;
    }

    if (status === null) return null;
    if (/authenticated|logged.?in|active/i.test(status)) {
      return { authState: 'authenticated' };
    }
    if (/unauthenticated|logged.?out|not.?authenticated|missing|expired/i.test(status)) {
      return { authState: 'unauthenticated', authError: CLAUDE_AUTH_ERROR_MESSAGE };
    }
  } catch {
    // ignore malformed auth-status JSON
  }
  return null;
}

export const CLAUDE_DETECTOR_CONFIG: CliDetectorConfig = Object.freeze({
  binaryName: 'claude',
  versionArgs: Object.freeze(['--version']),
  notFoundMessage: 'Claude CLI not found. Install it from the Claude Code distribution.',
  authEnvVar: 'ANTHROPIC_API_KEY',
  authCommand: Object.freeze(['auth', 'status', '--json']),
  authErrorPattern:
    /not logged in|unauthorized|unauthenticated|authentication required|login required|no api key|missing.*api.*key/i,
  authErrorMessage: CLAUDE_AUTH_ERROR_MESSAGE,
  parseAuthOutput: parseClaudeAuthStatus,
});

const claudeDetectorsByPort = new WeakMap<
  CliDetectorProcessPort,
  WeakMap<CliDetectorEnvPort, ReturnType<typeof createCliDetector>>
>();

export function detectClaudeCli(processPort: CliDetectorProcessPort, envPort: CliDetectorEnvPort): Promise<CliInfo> {
  let detectorsByEnv = claudeDetectorsByPort.get(processPort);
  if (detectorsByEnv === undefined) {
    detectorsByEnv = new WeakMap();
    claudeDetectorsByPort.set(processPort, detectorsByEnv);
  }

  let detector = detectorsByEnv.get(envPort);
  if (detector === undefined) {
    detector = createCliDetector(processPort, envPort, CLAUDE_DETECTOR_CONFIG);
    detectorsByEnv.set(envPort, detector);
  }

  return detector.detect();
}
