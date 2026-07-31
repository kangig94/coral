import {
  createCliDetector,
  type AuthProbeResult,
  type CliDetectorConfig,
  type CliDetectorEnvPort,
  type CliDetectorProcessPort,
  type CliInfo,
} from '../cli-detection.js';

const AUTH_ERROR_MESSAGE =
  'Claude CLI is not authenticated. Run "claude auth login" with the same CLAUDE_CONFIG_DIR, then retry.';

type AuthEvidence = 'authenticated' | 'unauthenticated';

const AUTHENTICATED_STATUSES: ReadonlySet<string> = new Set(['authenticated', 'logged_in', 'loggedin', 'active']);
const UNAUTHENTICATED_STATUSES: ReadonlySet<string> = new Set([
  'unauthenticated',
  'logged_out',
  'loggedout',
  'not_authenticated',
  'missing',
  'expired',
  'inactive',
]);

function statusEvidence(value: unknown): AuthEvidence | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
  if (AUTHENTICATED_STATUSES.has(normalized)) return 'authenticated';
  if (UNAUTHENTICATED_STATUSES.has(normalized)) return 'unauthenticated';
  return null;
}

function parseAuthStatus(stdout: string): AuthProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { authState: 'unknown' };
    }

    const record = parsed as Record<string, unknown>;
    const evidence = new Set<AuthEvidence>();
    if (typeof record.loggedIn === 'boolean') {
      evidence.add(record.loggedIn ? 'authenticated' : 'unauthenticated');
    }
    if (typeof record.authenticated === 'boolean') {
      evidence.add(record.authenticated ? 'authenticated' : 'unauthenticated');
    }
    for (const value of [record.status, record.auth_status]) {
      const state = statusEvidence(value);
      if (state !== null) evidence.add(state);
    }

    if (evidence.size !== 1) return { authState: 'unknown' };
    if (evidence.has('authenticated')) return { authState: 'authenticated' };
    return { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
  } catch {
    // Non-JSON output remains eligible for the generic auth-error fallback.
  }
  return null;
}

const CONFIG: CliDetectorConfig = Object.freeze({
  binaryName: 'claude',
  versionArgs: Object.freeze(['--version']),
  notFoundMessage: 'Claude CLI not found. Install it from the Claude Code distribution.',
  authEnvVar: 'ANTHROPIC_API_KEY',
  authCommand: Object.freeze(['auth', 'status', '--json']),
  authErrorPattern:
    /not logged in|unauthorized|unauthenticated|authentication required|login required|no api key|missing.*api.*key/i,
  authErrorMessage: AUTH_ERROR_MESSAGE,
  parseAuthOutput: parseAuthStatus,
});

const detectorsByProcess = new WeakMap<
  CliDetectorProcessPort,
  WeakMap<CliDetectorEnvPort, ReturnType<typeof createCliDetector>>
>();

export function detectClaudeCli(processPort: CliDetectorProcessPort, envPort: CliDetectorEnvPort): Promise<CliInfo> {
  let detectorsByEnv = detectorsByProcess.get(processPort);
  if (detectorsByEnv === undefined) {
    detectorsByEnv = new WeakMap();
    detectorsByProcess.set(processPort, detectorsByEnv);
  }
  let detector = detectorsByEnv.get(envPort);
  if (detector === undefined) {
    detector = createCliDetector(processPort, envPort, CONFIG);
    detectorsByEnv.set(envPort, detector);
  }
  return detector.detect();
}
