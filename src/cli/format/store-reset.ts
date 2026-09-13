import type { StoreResetPublicReport } from '../../store/reset-incident.js';
import type { StoreResetIncidentListResult } from '../../store/reset-incident-reader.js';
import type { StoreResetReleasePresentation } from '../../store/reset-retention.js';
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

function evidenceBytes(value: number | null): string {
  return value === null ? 'size unavailable' : `${value} bytes`;
}

function preservation(entry: StoreResetIncidentListResult['incidents'][number]): string {
  switch (entry.retention.slot) {
    case 'unknown':
    case 'parked':
      return 'unknown';
    case 'claimed': {
      const mechanism = entry.retention.preservation;
      if (mechanism === 'unknown') return 'unknown';
      switch (mechanism.kind) {
        case 'linked':
          return `linked (${mechanism.coherence})`;
        case 'copied': {
          let why: string;
          switch (mechanism.cause.kind) {
            case 'exclusion-unproven':
              why = mechanism.cause.reason;
              break;
            case 'link-unsupported':
              why = mechanism.cause.code;
              break;
            default:
              return assertNever(mechanism.cause);
          }
          return `copied (${why}; ${mechanism.coherence})`;
        }
        default:
          return assertNever(mechanism);
      }
    }
    default:
      return assertNever(entry.retention);
  }
}

function parked(entry: StoreResetIncidentListResult['incidents'][number]): string {
  const entries = entry.retention.parked;
  return entries === undefined || entries === 'unknown'
    ? 'unknown'
    : entries.length === 0
      ? 'none'
      : entries.map((parkedEntry) => `${parkedEntry.name} (${parkedEntry.kind})`).join(',');
}

function releaseInstruction(target: 'legacy' | 'gen2'): readonly string[] {
  return target === 'gen2'
    ? [
        'To permanently remove a listed incident or parked record:',
        'command=coral-cli backend store-reset release --target gen2 --flavor <prod|dev> <incident-id>',
      ]
    : [];
}

function parkingRootStatus(result: StoreResetIncidentListResult): readonly string[] {
  switch (result.parkingRootState) {
    case undefined:
    case 'absent':
    case 'ready':
      return [];
    case 'unsafe':
      return ['Parking root: unsafe; parked evidence could not be listed.'];
    case 'unavailable':
      return ['Parking root: unavailable; parked evidence could not be listed.'];
    default:
      return assertNever(result.parkingRootState);
  }
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

export function formatStoreResetList(result: StoreResetIncidentListResult, target: 'legacy' | 'gen2'): string {
  result = constrainStoreResetRendererInput(result);
  target = constrainStoreResetRendererInput(target);
  if (result.incidents.length === 0) {
    return [
      `No ${target} store-reset incidents.`,
      ...parkingRootStatus(result),
      ...(result.truncated
        ? ['Listing truncated at the incident-root safety bound; release a listed incident, then list again.']
        : []),
      'File a Store-reset incident issue with this complete output; do not attach DB, WAL, SHM, or raw logs.',
      ...releaseInstruction(target),
    ].join('\n');
  }
  return [
    'Incident ID | Reset at | Schema | Reason | Reset policy | State | Files | Incident bytes | Parking bytes | Preservation | Parked | Resume left active | Stored Coral version',
    ...result.incidents.map((incident) =>
      incident.state === 'ready'
        ? `${incident.incidentId} | ${incident.resetAt} | V${incident.schemaVersion} | ${incident.reason} | ${incident.resetPolicyCause ?? 'legacy-v2'} | ${incident.state} | ${incident.fileCount} | ${incident.evidenceBytes} | ${incident.parkingEvidenceBytes} | ${preservation(incident)} | ${parked(incident)} | ${incident.retention.slot === 'claimed' ? (incident.retention.resumeLeftActive ? 'yes' : 'no') : 'unknown'} | ${incident.storedProductVersion ?? 'none'}`
        : `${incident.incidentId} | - | - | - | - | ${incident.state} | - | ${incident.evidenceBytes} | ${incident.parkingEvidenceBytes} | ${preservation(incident)} | ${parked(incident)} | ${incident.retention.slot === 'claimed' ? (incident.retention.resumeLeftActive ? 'yes' : 'no') : 'unknown'} | ${incident.storedProductVersion ?? 'none'}`,
    ),
    ...parkingRootStatus(result),
    '',
    ...(result.truncated
      ? ['Listing truncated at the incident-root safety bound; release a listed incident, then list again.']
      : []),
    'States: ready produces a Markdown report; parked is owned evidence awaiting release; in-flight is a crash-recovery transaction; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.',
    ...(result.incidents.some((incident) => incident.state === 'ready')
      ? [
          'Next: report the ready incident.',
          `command=coral-cli backend store-reset report --target ${target} <ready-incident-id>`,
        ]
      : []),
    ...(result.incidents.some((incident) => incident.state !== 'ready' && incident.retention.slot !== 'parked')
      ? [
          'For a non-ready committed incident, run the report command with its ID and paste the fixed error output into the issue form.',
        ]
      : []),
    'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.',
    'When a stored Coral version is known, install that version to inspect the preserved store with a compatible build.',
    ...releaseInstruction(target),
  ].join('\n');
}

export function formatStoreResetRelease(result: StoreResetReleasePresentation): string {
  result = constrainStoreResetRendererInput(result);
  switch (result.kind) {
    case 'released': {
      return `Released preserved store-reset incident '${result.incidentId}' (incident: ${evidenceBytes(result.incidentEvidenceBytes)}; parking: ${evidenceBytes(result.parkingEvidenceBytes)}) from ${result.target} ${result.flavor}; deletion durability ${result.durability}.`;
    }
    case 'not-holder': {
      return `Released non-holder store-reset incident '${result.incidentId}' (incident: ${evidenceBytes(result.incidentEvidenceBytes)}; parking: ${evidenceBytes(result.parkingEvidenceBytes)}) from ${result.target} ${result.flavor}; deletion durability ${result.durability}; the preserved slot is unchanged.`;
    }
    case 'parked': {
      return `Released parked store-reset evidence '${result.incidentId}' (incident: ${evidenceBytes(result.incidentEvidenceBytes)}; parking: ${evidenceBytes(result.parkingEvidenceBytes)}) from ${result.target} ${result.flavor}; deletion durability ${result.durability}; the preserved slot is unchanged.`;
    }
    case 'released-unverified': {
      return `Released terminal store-reset parking '${result.incidentId}' from ${result.target} ${result.flavor} without a verified sidecar; parking byte accounting is unknown and deletion durability is ${result.durability}.`;
    }
    case 'partially-released': {
      return `Partially released store-reset incident '${result.incidentId}' (incident: ${evidenceBytes(result.incidentEvidenceBytes)}; parking: ${evidenceBytes(result.parkingEvidenceBytes)}) from ${result.target} ${result.flavor}: parking is ${result.parkingState}, incident is ${result.incidentState}; parking deletion durability is ${result.parkingDeletionDurability}; incident deletion durability is ${result.incidentDeletionDurability} (${result.cause}). Recursive deletion may have removed contents even when a directory remains. Inspect the listed state, then Retry this release command.`;
    }
    case 'absent':
      return `Store-reset incident '${result.incidentId}' is absent from ${result.target} ${result.flavor}.\ncommand=coral-cli backend store-reset list --target ${result.target}`;
    case 'staged':
      return `Store-reset incident '${result.incidentId}' is staged and belongs to crash recovery; no evidence was released. Start Coral and let crash recovery finish, then retry.`;
    case 'in-flight':
      return `Store-reset incident '${result.incidentId}' is an in-flight crash-recovery transaction; no evidence was released. Start Coral and let crash recovery finish, then retry.`;
    case 'unsafe':
      return `Store-reset incident '${result.incidentId}' is behind an unsafe quarantine path; no evidence was released and the preserved slot is unchanged.`;
    case 'undeterminable':
      return `Store-reset incident '${result.incidentId}' could not be verified as committed; no evidence was released and the preserved slot is unchanged. Retry; if it persists, report this complete output.`;
    default:
      return assertNever(result);
  }
}
