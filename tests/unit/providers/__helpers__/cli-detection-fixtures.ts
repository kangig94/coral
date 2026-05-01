import {
  CLAUDE_DETECTOR_CONFIG,
  CODEX_DETECTOR_CONFIG,
  createCliDetector,
  type CliDetectorProcessPort,
} from '#src/providers/cli-detection.js';

export function createCodexDetectorForTest(processPort: CliDetectorProcessPort) {
  return createCliDetector(processPort, CODEX_DETECTOR_CONFIG);
}

export function createClaudeDetectorForTest(processPort: CliDetectorProcessPort) {
  return createCliDetector(processPort, CLAUDE_DETECTOR_CONFIG);
}
