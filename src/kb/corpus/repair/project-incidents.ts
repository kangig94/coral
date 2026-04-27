import type { CorpusScanView, DetectedIncident, Detector } from './corpus-scan.js';
import { fileSyntaxDetector } from './detect/file-syntax.js';
import { frontmatterShapeDetector } from './detect/frontmatter-shape.js';
import { identitySequenceDetector } from './detect/identity-sequence.js';
import { referenceIntegrityDetector } from './detect/reference-integrity.js';

const ALL_DETECTORS: readonly Detector[] = [
  fileSyntaxDetector,
  frontmatterShapeDetector,
  identitySequenceDetector,
  referenceIntegrityDetector,
];

/**
 * Aggregates detected incidents across every typed detector. Pure projection over
 * `CorpusScanView`; does not touch storage. Callers feed the result to
 * `applyDetectedIncidentFixesLocked` (under the mutation lock).
 *
 * Lives in its own file (separate from `corpus-scan.ts`) so detectors can keep
 * type-importing from `corpus-scan.ts` without forming the cycle
 * `corpus-scan → detect/* → corpus-scan`.
 */
export function projectIncidents(scan: CorpusScanView): DetectedIncident[] {
  return ALL_DETECTORS.flatMap((detector) => detector.detect(scan));
}
