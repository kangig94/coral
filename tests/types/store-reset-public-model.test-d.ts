import { formatStoreResetReport } from '../../src/cli/format/store-reset.js';
import {
  projectStoreResetPublicReport,
  type StoreResetIncidentLocalReport,
  type StoreResetIncidentManifestV2,
} from '../../src/store/reset-incident.js';

declare const localReport: StoreResetIncidentLocalReport;
declare const manifest: StoreResetIncidentManifestV2;

formatStoreResetReport(projectStoreResetPublicReport(localReport));

// @ts-expect-error a validated local report is not the branded public model.
formatStoreResetReport(localReport);

// @ts-expect-error a manifest cannot bypass the public projection.
formatStoreResetReport(manifest);

const forged = {
  incidentId: manifest.incidentId,
  resetAt: manifest.resetAt,
  reason: manifest.reason,
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
