import {
  createCliDetector,
  type AuthProbeResult,
  type CliInfo,
} from '../cli-detection.js';

export type { AuthState } from '../cli-detection.js';

const AUTH_ERROR_MESSAGE =
  'Claude CLI is not authenticated. Run "claude auth login" or set the ANTHROPIC_API_KEY environment variable.';

function parseAuthStatus(stdout: string): AuthProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.authenticated === 'boolean') {
      return parsed.authenticated
        ? { authState: 'authenticated' }
        : { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
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
      return { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
    }
  } catch {
    // ignore malformed auth-status JSON
  }
  return null;
}

const detector = createCliDetector({
  binaryName: 'claude',
  versionArgs: ['--version'],
  notFoundMessage: 'Claude CLI not found. Install it from the Claude Code distribution.',
  authEnvVar: 'ANTHROPIC_API_KEY',
  authCommand: ['auth', 'status', '--json'],
  authErrorPattern: /not logged in|unauthorized|unauthenticated|authentication required|login required|no api key|missing.*api.*key/i,
  authErrorMessage: AUTH_ERROR_MESSAGE,
  parseAuthOutput: parseAuthStatus,
});

export type ClaudeCliInfo = CliInfo;

export const detectClaudeCli = detector.detect;
export const resetClaudeCliCache = detector.resetCache;
