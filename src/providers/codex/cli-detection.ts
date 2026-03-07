/**
 * Codex CLI detection and validation.
 * Caches CLI availability for process lifetime and re-probes auth when needed.
 */

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

const AUTH_ERROR_PATTERN = /not logged in|unauthorized|unauthenticated|no api key|missing.*api.*key|authentication required/i;
const AUTH_ERROR_MESSAGE = 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.';

// CLI availability: cached permanently after first successful probe
let cachedCli: CliInfo | null = null;

// In-flight probe: shared across concurrent callers, cleared in finally
let inFlightProbe: Promise<CliInfo> | null = null;

// Positive auth: once confirmed, skip re-probing for server lifetime.
// Scope limitation: if auth is revoked mid-session, not re-detected until restart.
let confirmedAuth = false;

export async function detectCodexCli(): Promise<CliInfo> {
  if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) {
    return cachedCli;
  }

  if (inFlightProbe !== null) return inFlightProbe;

  inFlightProbe = runProbe().finally(() => {
    inFlightProbe = null;
  });
  return inFlightProbe;
}

export function resetCliCache(): void {
  cachedCli = null;
  inFlightProbe = null;
  confirmedAuth = false;
}

async function runProbe(): Promise<CliInfo> {
  const cli = cachedCli ?? await queryCodexVersion();
  cachedCli = cli;
  if (!cli.available) return cli;

  const version = cli.version;
  const auth = await queryAuthState();
  if (auth.authState === 'authenticated') {
    confirmedAuth = true;
    cachedCli = { available: true, version, authState: 'authenticated' };
    return cachedCli;
  }

  if (auth.authState === 'unauthenticated') {
    cachedCli = {
      available: true,
      version,
      authState: 'unauthenticated',
      authError: auth.authError,
    };
    return cachedCli;
  }

  cachedCli = { available: true, version, authState: 'unknown' };
  return cachedCli;
}

function queryCodexVersion(): Promise<CliInfo> {
  return new Promise<CliInfo>((resolve) => {
    execFile('codex', ['--version'], { timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          error: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
        });
        return;
      }
      resolve({ available: true, version: stdout.trim(), authState: 'unknown' });
    });
  });
}

function queryAuthState(): Promise<AuthProbeResult> {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return Promise.resolve({ authState: 'authenticated' });
  }

  return new Promise<AuthProbeResult>((resolve) => {
    execFile('codex', ['whoami'], { timeout: 5_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ authState: 'authenticated' });
        return;
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
