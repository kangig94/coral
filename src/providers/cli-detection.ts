import { execFile } from 'node:child_process';

export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export type CliInfo =
  | { available: false; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

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

function createCliDetector(config: CliDetectorConfig): {
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

  function queryCliVersion(): Promise<CliInfo> {
    return new Promise<CliInfo>((resolve) => {
      execFile(config.binaryName, [...config.versionArgs], { timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
        if (err) {
          resolve({ available: false, error: config.notFoundMessage });
          return;
        }

        resolve({ available: true, version: stdout.trim(), authState: 'unknown' });
      });
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

// ── Codex ──────────────────────────────────────

const codexDetector = createCliDetector({
  binaryName: 'codex',
  versionArgs: ['--version'],
  notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  authEnvVar: 'OPENAI_API_KEY',
  authCommand: ['whoami'],
  authErrorPattern: /not logged in|unauthorized|unauthenticated|no api key|missing.*api.*key|authentication required/i,
  authErrorMessage: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
});

export const detectCodexCli = codexDetector.detect;
export const resetCodexCliCache = codexDetector.resetCache;

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

const claudeDetector = createCliDetector({
  binaryName: 'claude',
  versionArgs: ['--version'],
  notFoundMessage: 'Claude CLI not found. Install it from the Claude Code distribution.',
  authEnvVar: 'ANTHROPIC_API_KEY',
  authCommand: ['auth', 'status', '--json'],
  authErrorPattern:
    /not logged in|unauthorized|unauthenticated|authentication required|login required|no api key|missing.*api.*key/i,
  authErrorMessage: CLAUDE_AUTH_ERROR_MESSAGE,
  parseAuthOutput: parseClaudeAuthStatus,
});

export const detectClaudeCli = claudeDetector.detect;
export const resetClaudeCliCache = claudeDetector.resetCache;
