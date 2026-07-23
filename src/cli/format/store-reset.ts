import type { StoreResetPublicReport } from '../../store/reset-incident.js';

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
