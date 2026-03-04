/**
 * Claude CLI detection and validation.
 * Caches CLI availability for process lifetime and re-probes auth when needed.
 */

import { execFile } from 'node:child_process';

export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown';

export type ClaudeCliInfo =
  | { available: false; error: string }
  | { available: true; version: string; authState: 'authenticated' }
  | { available: true; version: string; authState: 'unknown' }
  | { available: true; version: string; authState: 'unauthenticated'; authError: string };

type AuthProbeResult =
  | { authState: 'authenticated' }
  | { authState: 'unknown' }
  | { authState: 'unauthenticated'; authError: string };

const AUTH_ERROR_PATTERN = /not logged in|unauthorized|unauthenticated|authentication required|login required|no api key|missing.*api.*key/i;
const AUTH_ERROR_MESSAGE = 'Claude CLI is not authenticated. Run "claude auth login" or set the ANTHROPIC_API_KEY environment variable.';

// CLI availability: cached permanently after first successful probe
let cachedCli: ClaudeCliInfo | null = null;

// In-flight probe: shared across concurrent callers, cleared in finally
let inFlightProbe: Promise<ClaudeCliInfo> | null = null;

// Positive auth: once confirmed, skip re-probing for server lifetime.
// Scope limitation: if auth is revoked mid-session, not re-detected until restart.
let confirmedAuth = false;

export async function detectClaudeCli(): Promise<ClaudeCliInfo> {
  if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) {
    return cachedCli;
  }

  if (inFlightProbe !== null) return inFlightProbe;

  inFlightProbe = runProbe().finally(() => {
    inFlightProbe = null;
  });
  return inFlightProbe;
}

export function resetClaudeCliCache(): void {
  cachedCli = null;
  inFlightProbe = null;
  confirmedAuth = false;
}

async function runProbe(): Promise<ClaudeCliInfo> {
  const cli = cachedCli ?? await queryClaudeVersion();
  cachedCli = cli;
  if (!cli.available) return cli;

  const auth = await queryAuthState();
  const version = cli.version;
  let nextCli: ClaudeCliInfo;

  if (auth.authState === 'authenticated') {
    confirmedAuth = true;
    nextCli = { available: true, version, authState: 'authenticated' };
  } else if (auth.authState === 'unauthenticated') {
    nextCli = {
      available: true,
      version,
      authState: 'unauthenticated',
      authError: auth.authError,
    };
  } else {
    nextCli = { available: true, version, authState: 'unknown' };
  }

  cachedCli = nextCli;
  return nextCli;
}

function queryClaudeVersion(): Promise<ClaudeCliInfo> {
  return new Promise<ClaudeCliInfo>((resolve) => {
    execFile('claude', ['--version'], { timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          error: 'Claude CLI not found. Install it from the Claude Code distribution.',
        });
        return;
      }
      resolve({ available: true, version: stdout.trim(), authState: 'unknown' });
    });
  });
}

function queryAuthState(): Promise<AuthProbeResult> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return Promise.resolve({ authState: 'authenticated' });
  }

  return new Promise<AuthProbeResult>((resolve) => {
    execFile('claude', ['auth', 'status', '--json'], { timeout: 5_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) {
        const parsed = parseAuthStatus(stdout);
        if (parsed !== null) {
          resolve(parsed);
          return;
        }
      }

      const output = `${stdout}\n${stderr}`;
      if (AUTH_ERROR_PATTERN.test(output)) {
        resolve({ authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE });
        return;
      }

      resolve({ authState: 'unknown' });
    });
  });
}

function parseAuthStatus(stdout: string): AuthProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.authenticated === 'boolean') {
      return parsed.authenticated
        ? { authState: 'authenticated' }
        : { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
    }

    const status = typeof parsed.status === 'string'
      ? parsed.status
      : typeof parsed.auth_status === 'string'
        ? parsed.auth_status
        : null;
    if (status !== null) {
      if (/authenticated|logged.?in|active/i.test(status)) {
        return { authState: 'authenticated' };
      }
      if (/unauthenticated|logged.?out|not.?authenticated|missing|expired/i.test(status)) {
        return { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
      }
    }
  } catch {
    // ignore malformed auth-status JSON
  }
  return null;
}
