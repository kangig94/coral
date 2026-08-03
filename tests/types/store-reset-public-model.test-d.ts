import { formatStoreResetReport } from '../../src/cli/format/store-reset.js';
import {
  projectStoreResetPublicReport,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifestV3,
} from '../../src/store/reset-incident.js';

declare const localReport: StoreResetIncidentLocalReport;
declare const manifest: StoreResetIncidentManifestV3;

formatStoreResetReport(projectStoreResetPublicReport(localReport));

// @ts-expect-error a validated local report is not the branded public model.
formatStoreResetReport(localReport);

// @ts-expect-error a manifest cannot bypass the public projection.
formatStoreResetReport(manifest);

const forged = {
  incidentId: manifest.incidentId,
  resetAt: manifest.resetAt,
  reason: manifest.reason,
  schemaVersion: manifest.schemaVersion,
  resetPolicyCause: manifest.resetPolicyCause,
  resetPolicyEvidence: manifest.resetPolicyEvidence,
  storedFingerprint: manifest.storedFingerprint,
  expectedFingerprint: manifest.expectedFingerprint,
  build: manifest.build,
  handoff: manifest.handoff,
  files: [],
  diagnostic: {
    integrity: 'ok' as const,
    termination: 'completed' as const,
    cleanup: 'removed' as const,
  },
};

// @ts-expect-error a structurally matching object cannot forge the private brand.
formatStoreResetReport(forged);

if (manifest.resetPolicyEvidence !== null) {
  // @ts-expect-error unvalidated executable paths are not manifest authority.
  const executablePath = manifest.resetPolicyEvidence.observedTarget.executablePath;
  void executablePath;
}
