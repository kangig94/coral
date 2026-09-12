import type { StoreResetPublicReport } from '../../store/reset-incident.js';
import type { StoreResetIncidentListResult } from '../../store/reset-incident-reader.js';
import type { StoreResetReleasePresentation } from '../../store/reset-retention.js';
import { assertNever } from '../../infra/error-format.js';

function code(value: string): string {
  return `\`${value}\``;
}

function observed(value: string | null): string {
  return value === null ? 'not observed' : code(value);
}

function retention(entry: StoreResetIncidentListResult['incidents'][number]): string {
  switch (entry.retention.slot) {
    case 'unknown':
      return 'unknown';
    case 'claimed':
      return 'claimed';
    case 'excess':
      return `excess (${entry.retention.lineage}; holder ${entry.retention.holder})`;
    default:
      return assertNever(entry.retention);
  }
}

function preservation(entry: StoreResetIncidentListResult['incidents'][number]): string {
  switch (entry.retention.slot) {
    case 'unknown':
      return 'unknown';
    case 'claimed':
    case 'excess': {
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

function discarded(result: StoreResetIncidentListResult): string {
  if (result.discarded === null) return 'Discarded descendant evidence: none.';
  const latest = result.discarded.latest;
  return `Discarded descendant evidence: count=${result.discarded.count} bytes=${result.discarded.evidenceBytes} latest_reset_at=${latest.resetAt} latest_cause=${latest.resetPolicyCause} deferred_to=${latest.deferredTo}.`;
}

function releaseInstruction(target: 'legacy' | 'gen2'): readonly string[] {
  return target === 'gen2'
    ? [
        'To permanently remove a committed incident: coral-cli backend store-reset release --target gen2 --flavor <prod|dev> <incident-id>',
      ]
    : [];
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
      discarded(result),
      ...(result.truncated
        ? ['Listing truncated at the incident-root safety bound; release a listed incident, then list again.']
        : []),
      'File a Store-reset incident issue with this complete output; do not attach DB, WAL, SHM, or raw logs.',
      ...releaseInstruction(target),
    ].join('\n');
  }
  return [
    'Incident ID | Reset at | Schema | Reason | Reset policy | State | Files | Evidence bytes | Retention | Preservation | Resume left active | Stored Coral version',
    ...result.incidents.map((incident) =>
      incident.state === 'ready'
        ? `${incident.incidentId} | ${incident.resetAt} | V${incident.schemaVersion} | ${incident.reason} | ${incident.resetPolicyCause ?? 'legacy-v2'} | ${incident.state} | ${incident.fileCount} | ${incident.evidenceBytes} | ${retention(incident)} | ${preservation(incident)} | ${incident.retention.slot === 'unknown' ? 'unknown' : incident.retention.resumeLeftActive ? 'yes' : 'no'} | ${incident.storedProductVersion ?? 'none'}`
        : `${incident.incidentId} | - | - | - | - | ${incident.state} | - | ${incident.evidenceBytes} | ${retention(incident)} | ${preservation(incident)} | ${incident.retention.slot === 'unknown' ? 'unknown' : incident.retention.resumeLeftActive ? 'yes' : 'no'} | ${incident.storedProductVersion ?? 'none'}`,
    ),
    '',
    discarded(result),
    ...(result.truncated
      ? ['Listing truncated at the incident-root safety bound; release a listed incident, then list again.']
      : []),
    'States: ready produces a Markdown report; malformed, unsupported, build_mismatch, unsafe, and unavailable produce a fixed public-safe error.',
    `Next: coral-cli backend store-reset report --target ${target} <ready-incident-id>`,
    'For a non-ready incident, run the same report command with its ID and paste the fixed error output into the issue form.',
    'Non-ready evidence remains retained. Do not move, restore, delete, or upload DB, WAL, or SHM files.',
    'When a stored Coral version is known, install that version to inspect the preserved store with a compatible build.',
    ...releaseInstruction(target),
  ].join('\n');
}

export function formatStoreResetRelease(result: StoreResetReleasePresentation): string {
  switch (result.kind) {
    case 'released': {
      const evidence = result.evidenceBytes === null ? 'evidence size unavailable' : `${result.evidenceBytes} bytes`;
      return `Released preserved store-reset incident '${result.incidentId}' (${evidence}) from ${result.target} ${result.flavor}.`;
    }
    case 'not-holder': {
      const evidence = result.evidenceBytes === null ? 'evidence size unavailable' : `${result.evidenceBytes} bytes`;
      return `Released non-holder store-reset incident '${result.incidentId}' (${evidence}) from ${result.target} ${result.flavor}; the preserved slot is unchanged.`;
    }
    case 'absent':
      return `Store-reset incident '${result.incidentId}' is absent from ${result.target} ${result.flavor}. Next: coral-cli backend store-reset list --target ${result.target}.`;
    case 'staged':
      return `Store-reset incident '${result.incidentId}' is staged and belongs to crash recovery; no evidence was released. Start Coral and let crash recovery finish, then retry.`;
    case 'unsafe':
      return `Store-reset incident '${result.incidentId}' is behind an unsafe quarantine path; no evidence was released and the preserved slot is unchanged.`;
    case 'undeterminable':
      return `Store-reset incident '${result.incidentId}' could not be verified as committed; no evidence was released and the preserved slot is unchanged. Retry; if it persists, report this complete output.`;
    default:
      return assertNever(result);
  }
}
