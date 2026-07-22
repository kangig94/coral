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

function parseAuthStatus(stdout: string): AuthProbeResult | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof parsed.authenticated === 'boolean') {
      return parsed.authenticated
        ? { authState: 'authenticated' }
        : { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
    }
    const status =
      typeof parsed.status === 'string'
        ? parsed.status
        : typeof parsed.auth_status === 'string'
          ? parsed.auth_status
          : null;
    if (status === null) return null;
    if (/authenticated|logged.?in|active/i.test(status)) return { authState: 'authenticated' };
    if (/unauthenticated|logged.?out|not.?authenticated|missing|expired/i.test(status)) {
      return { authState: 'unauthenticated', authError: AUTH_ERROR_MESSAGE };
    }
  } catch {
    // Malformed JSON is not authenticated evidence.
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
