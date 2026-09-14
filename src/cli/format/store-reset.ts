import type { StoreResetPublicReport } from '../../store/reset-incident.js';
import type { StoreResetReleasePresentation } from '../../store/operator-store-reset.js';
import type { StoreResetListResult, StoreResetReportResult } from '../store-reset.js';
import { assertNever } from '../../infra/error-format.js';

export function constrainStoreResetRendererInput<Value>(value: Value): Value {
  if (typeof value === 'string') {
    return JSON.stringify(value).slice(1, -1).replaceAll('|', '\\u007c').replaceAll('`', '\\u0060') as Value;
  }
  if (Array.isArray(value)) return value.map(constrainStoreResetRendererInput) as Value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, constrainStoreResetRendererInput(entry)]),
    ) as Value;
  }
  return value;
}

function code(value: string): string {
  return `\`${value}\``;
}

function observed(value: string | null): string {
  return value === null ? 'not observed' : code(value);
}

function releaseInstruction(target: 'legacy' | 'gen2'): readonly string[] {
  return target === 'gen2'
    ? [
        'To permanently remove a non-current epoch:',
        'command=coral-cli backend store-reset release --target gen2 --flavor <prod|dev> <epoch>',
      ]
    : [];
}

export function formatStoreResetReport(report: StoreResetPublicReport): string {
  report = constrainStoreResetRendererInput(report);
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

export function formatStoreEpochReport(result: Extract<StoreResetReportResult, { readonly kind: 'epoch' }>): string {
  result = constrainStoreResetRendererInput(result);
  return [
    '# Coral store epoch report',
    '',
    `- Epoch: ${code(String(result.epoch.epoch))}`,
    `- Role: ${code(result.epoch.role)}`,
    `- Bytes: ${result.epoch.bytes ?? 'unknown'}`,
    `- Classification: ${code(result.epoch.classification.kind)}`,
    `- Stored Coral version: ${result.epoch.storedProductVersion === null ? 'not observed' : code(result.epoch.storedProductVersion)}`,
    `- Epoch metadata: ${result.epoch.epochJson === null ? 'legacy-epoch-0' : code(JSON.stringify(result.epoch.epochJson))}`,
    '',
    '## SQLite diagnostic',
    '',
    `- Integrity: ${code(result.diagnostic.integrity)}`,
    `- Termination: ${code(result.diagnostic.termination)}`,
    `- Cleanup: ${code(result.diagnostic.cleanup)}`,
    '',
    'No file was uploaded. Do not attach DB, WAL, SHM, raw logs, credentials, settings, or environment files.',
    '',
  ].join('\n');
}

export function formatStoreResetList(result: StoreResetListResult, target: 'legacy' | 'gen2'): string {
  result = constrainStoreResetRendererInput(result);
  target = constrainStoreResetRendererInput(target);
  if (result.epochs.length === 0 && result.legacyIncidents.length === 0) {
    return [`No ${target} store epochs or legacy store-reset incidents.`, ...releaseInstruction(target)].join('\n');
  }
  return [
    'Epoch | Role | Bytes | Classification | Stored Coral version | Epoch metadata',
    ...result.epochs.map(
      (epoch) =>
        `${epoch.epoch} | ${epoch.role} | ${epoch.bytes ?? 'unknown'} | ${epoch.classification.kind} | ${epoch.storedProductVersion ?? 'none'} | ${epoch.epochJson === null ? 'legacy-epoch-0' : JSON.stringify(epoch.epochJson)}`,
    ),
    ...(result.legacyIncidents.length === 0
      ? []
      : [
          '',
          'Legacy incident ID | State | Reset at | Reason | Files | Bytes',
          ...result.legacyIncidents.map(
            (incident) =>
              `${incident.incidentId} | ${incident.state} | ${incident.resetAt ?? '-'} | ${incident.reason ?? '-'} | ${incident.fileCount ?? '-'} | ${incident.bytes ?? 'unknown'}`,
          ),
        ]),
    '',
    ...(result.truncated ? ['Legacy quarantine listing was truncated at its safety bound.'] : []),
    ...(result.legacyIncidents.some((incident) => incident.state === 'ready')
      ? [
          'Legacy ready incidents remain reportable.',
          `command=coral-cli backend store-reset report --target ${target} <ready-incident-id>`,
        ]
      : []),
    ...(target === 'gen2' && result.epochs.length > 0
      ? [
          'To run the bounded read-only diagnostic for an epoch:',
          'command=coral-cli backend store-reset report --target gen2 <epoch>',
        ]
      : []),
    ...releaseInstruction(target),
  ].join('\n');
}

export function formatStoreResetRelease(result: StoreResetReleasePresentation): string {
  result = constrainStoreResetRendererInput(result);
  switch (result.kind) {
    case 'released':
      return `Released store epoch ${result.epoch} from ${result.target} ${result.flavor}.`;
    case 'partially-released':
      return `Store epoch ${result.epoch} was only partially released from ${result.target} ${result.flavor}; retry the release command.`;
    case 'absent':
      return `Store epoch ${result.epoch} is absent from ${result.target} ${result.flavor}.`;
    case 'current':
      return `Store epoch ${result.epoch} is current and was not released from ${result.target} ${result.flavor}.`;
    default:
      return assertNever(result);
  }
}
