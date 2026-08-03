import type { StoreResetIncidentListResult, StoreResetPublicReport } from '../../store/reset-incident.js';

function code(value: string): string {
  return `\`${value}\``;
}

function observed(value: string | null): string {
  return value === null ? 'not observed' : code(value);
}

export function formatStoreResetReport(report: StoreResetPublicReport): string {
  const lines = [
    '# Coral store-reset incident report',
    '',
    `- Incident ID: ${code(report.incidentId)}`,
    `- Reset at: ${code(report.resetAt)}`,
    `- Manifest schema: ${code(`V${report.schemaVersion}`)}`,
    `- Reason: ${code(report.reason)}`,
    `- Reset policy cause: ${report.resetPolicyCause === null ? 'legacy-v2' : code(report.resetPolicyCause)}`,
    `- Stored fingerprint: ${report.storedFingerprint === null ? 'missing' : code(report.storedFingerprint)}`,
    `- Expected fingerprint: ${code(report.expectedFingerprint)}`,
    `- Coral version: ${code(report.build.version)}`,
    `- Build-set ID: ${code(report.build.buildSetId)}`,
    `- Backend bundle hash: ${code(report.build.backendBundleHash)}`,
    `- Build flavor: ${code(report.build.flavor)}`,
    `- Acquired via handoff: ${report.handoff.acquiredViaHandoff ? 'yes' : 'no'}`,
    ...(report.resetPolicyEvidence === null
      ? []
      : [
          '',
          '## Newer-target validation evidence',
          '',
          `- Validation failure: ${code(report.resetPolicyEvidence.validationFailure.code)}`,
          `- Observed version: ${observed(report.resetPolicyEvidence.observedTarget.version)}`,
          `- Observed build-set ID: ${observed(report.resetPolicyEvidence.observedTarget.buildSetId)}`,
          `- Observed bundle hash: ${observed(report.resetPolicyEvidence.observedTarget.bundleHash)}`,
          `- Observed flavor: ${observed(report.resetPolicyEvidence.observedTarget.flavor)}`,
          `- Observed store fingerprint: ${observed(report.resetPolicyEvidence.observedTarget.storeFormatFingerprint)}`,
          `- Executable path SHA-256: ${observed(report.resetPolicyEvidence.observedTarget.executablePathSha256)}`,
          `- Executable SHA-256: ${observed(report.resetPolicyEvidence.observedTarget.executableSha256)}`,
        ]),
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

export function formatStoreResetList(result: StoreResetIncidentListResult, target: 'legacy' | 'gen2'): string {
  if (result.incidents.length === 0) {
    return [
      `No ${target} store-reset incidents.`,
      'File a Store-reset incident issue with this complete output; do not attach DB, WAL, SHM, or raw logs.',
    ].join('\n');
  }
  return [
    'Incident ID | Reset at | Schema | Reason | Reset policy | State | Files',
    ...result.incidents.map((incident) =>
      incident.state === 'ready'
        ? `${incident.incidentId} | ${incident.resetAt} | V${incident.schemaVersion} | ${incident.reason} | ${incident.resetPolicyCause ?? 'legacy-v2'} | ${incident.state} | ${incident.fileCount}`
        : `${incident.incidentId} | - | - | - | - | ${incident.state} | -`,
    ),
    '',
    'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.',
    `Next: coral-cli backend store-reset report --target ${target} <ready-incident-id>`,
    'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.',
    'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.',
  ].join('\n');
}
