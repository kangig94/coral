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
    '## Next step',
    '',
    'Paste this complete output into the Store-reset incident issue form in the Coral GitHub repository.',
    'No file was uploaded. Do not attach DB, WAL, SHM, raw logs, credentials, settings, or environment files.',
    'The retained evidence is diagnostic only and cannot be restored as active Coral state.',
    '',
  ];
  return lines.join('\n');
}

export function formatStoreResetList(result: StoreResetIncidentListResult): string {
  if (result.incidents.length === 0) {
    return [
      'No store-reset incidents.',
      'If an unexpected reset warning included an incident ID, report that ID directly.',
      'Otherwise, file a Store-reset incident issue with this complete output; do not attach DB, WAL, SHM, or raw logs.',
    ].join('\n');
  }
  return [
    'Incident ID | Reset at | Reason | State | Files',
    ...result.incidents.map((incident) =>
      incident.state === 'ready'
        ? `${incident.incidentId} | ${incident.resetAt} | ${incident.reason} | ${incident.state} | ${incident.fileCount}`
        : `${incident.incidentId} | - | - | ${incident.state} | -`,
    ),
    '',
    'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.',
    'Next: coral-cli backend store-reset report <ready-incident-id>',
    'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.',
    'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.',
  ].join('\n');
}
