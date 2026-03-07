import { createCliDetector } from '../cli-detection.js';

export type { AuthState, CliInfo } from '../cli-detection.js';

const detector = createCliDetector({
  binaryName: 'codex',
  versionArgs: ['--version'],
  notFoundMessage: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
  authEnvVar: 'OPENAI_API_KEY',
  authCommand: ['whoami'],
  authErrorPattern: /not logged in|unauthorized|unauthenticated|no api key|missing.*api.*key|authentication required/i,
  authErrorMessage: 'Codex CLI is not authenticated. Run "codex login" or set the OPENAI_API_KEY environment variable.',
});

export const detectCodexCli = detector.detect;
export const resetCliCache = detector.resetCache;
