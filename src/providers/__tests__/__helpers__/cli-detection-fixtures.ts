import {
  CLAUDE_DETECTOR_CONFIG,
  CODEX_DETECTOR_CONFIG,
  createCliDetector,
} from '../../cli-detection.js';

export function createCodexDetectorForTest() {
  return createCliDetector(CODEX_DETECTOR_CONFIG);
}

export function createClaudeDetectorForTest() {
  return createCliDetector(CLAUDE_DETECTOR_CONFIG);
}
