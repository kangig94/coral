import {
  CLAUDE_DETECTOR_CONFIG,
  CODEX_DETECTOR_CONFIG,
  createCliDetector,
  type CliDetectorEnvPort,
  type CliDetectorProcessPort,
} from '#src/providers/cli-detection.js';

const ambientEnvForTests: CliDetectorEnvPort = {
  get: (key: string) => process.env[key],
};

export function createCodexDetectorForTest(processPort: CliDetectorProcessPort) {
  return createCliDetector(processPort, ambientEnvForTests, CODEX_DETECTOR_CONFIG);
}

export function createClaudeDetectorForTest(processPort: CliDetectorProcessPort) {
  return createCliDetector(processPort, ambientEnvForTests, CLAUDE_DETECTOR_CONFIG);
}
