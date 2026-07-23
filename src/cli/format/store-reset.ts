import type { StoreResetIncidentListResult, StoreResetPublicReport } from '../../store/reset-incident.js';

function code(value: string): string {
  return `\`${value}\``;
}

export function formatStoreResetReport(report: StoreResetPublicReport): string {
  const lines = [
    '# Coral store-reset incident report',
    '',
    `- Incident ID: ${code(report.incidentId)}`,
    `- Reset at: ${code(report.resetAt)}`,
    `- Reason: ${code(report.reason)}`,
    `- Stored fingerprint: ${report.storedFingerprint === null ? 'missing' : code(report.storedFingerprint)}`,
    `- Expected fingerprint: ${code(report.expectedFingerprint)}`,
    `- Coral version: ${code(report.build.version)}`,
    `- Build-set ID: ${code(report.build.buildSetId)}`,
    `- Backend bundle hash: ${code(report.build.backendBundleHash)}`,
    `- Build flavor: ${code(report.build.flavor)}`,
    `- Acquired via handoff: ${report.handoff.acquiredViaHandoff ? 'yes' : 'no'}`,
    '',
    '## Evidence',
    '',
    '| File | Size (bytes) | Recorded SHA-256 | Verification |',
    '|---|---:|---|---|',
    ...report.files.map(
      (file) => `| ${code(file.name)} | ${file.sizeBytes} | ${code(file.sha256)} | ${code(file.verification)} |`,
    ),
    '',
    '## SQLite diagnostic',
    '',
    `- Integrity: ${code(report.diagnostic.integrity)}`,
    `- Termination: ${code(report.diagnostic.termination)}`,
    `- Cleanup: ${code(report.diagnostic.cleanup)}`,
    '',
  ];
  return lines.join('\n');
}

export function formatStoreResetList(result: StoreResetIncidentListResult): string {
  if (result.incidents.length === 0) return 'No store-reset incidents.';
  return [
    'Incident ID | Reset at | Reason | State | Files',
    ...result.incidents.map((incident) =>
      incident.state === 'ready'
        ? `${incident.incidentId} | ${incident.resetAt} | ${incident.reason} | ${incident.state} | ${incident.fileCount}`
        : `${incident.incidentId} | - | - | ${incident.state} | -`,
    ),
  ].join('\n');
}
