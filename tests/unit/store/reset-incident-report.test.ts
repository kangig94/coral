import { describe, expect, it } from 'vitest';

import { formatStoreResetReport } from '#src/cli/format/store-reset.js';
import { projectStoreResetPublicReport, type StoreResetIncidentLocalReport } from '#src/store/reset-incident.js';

function localReport(): StoreResetIncidentLocalReport {
  return {
    manifest: {
      schemaVersion: 2,
      incidentId: '123e4567-e89b-12d3-a456-426614174000',
      resetAt: '2026-07-23T01:02:03.004Z',
      reason: 'mismatch',
      storedFingerprint: `sha256:${'1'.repeat(64)}`,
      expectedFingerprint: `sha256:${'2'.repeat(64)}`,
      build: {
        version: '0.9.16',
        buildSetId: '223e4567-e89b-12d3-a456-426614174000',
        backendBundleHash: '0123456789abcdef',
        flavor: 'prod',
      },
      runtime: {
        namespace: 'private-namespace-sentinel',
        nodeVersion: 'v24.7.0',
        platform: 'linux',
        architecture: 'x64',
        processId: 424_242,
      },
      handoff: {
        acquiredViaHandoff: true,
      },
      files: [
        {
          name: 'store.db',
          sizeBytes: 123,
          mtimeMs: 1_754_000_000_000,
          sha256: 'a'.repeat(64),
        },
      ],
    },
    fileVerification: [{ name: 'store.db', status: 'match' }],
    diagnostic: {
      integrity: 'ok',
      termination: 'completed',
      cleanup: 'removed',
    },
  };
}

describe('store reset public report', () => {
  it('projects a closed public model before deterministic rendering', () => {
    const report = projectStoreResetPublicReport(localReport());
    const markdown = formatStoreResetReport(report);

    expect(markdown).toMatchInlineSnapshot(`
      "# Coral store-reset incident report

      - Incident ID: \`123e4567-e89b-12d3-a456-426614174000\`
      - Reset at: \`2026-07-23T01:02:03.004Z\`
      - Reason: \`mismatch\`
      - Stored fingerprint: \`sha256:1111111111111111111111111111111111111111111111111111111111111111\`
      - Expected fingerprint: \`sha256:2222222222222222222222222222222222222222222222222222222222222222\`
      - Coral version: \`0.9.16\`
      - Build-set ID: \`223e4567-e89b-12d3-a456-426614174000\`
      - Backend bundle hash: \`0123456789abcdef\`
      - Build flavor: \`prod\`
      - Acquired via handoff: yes

      ## Evidence

      | File | Size (bytes) | Recorded SHA-256 | Verification |
      |---|---:|---|---|
      | \`store.db\` | 123 | \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\` | \`match\` |

      ## SQLite diagnostic

      - Integrity: \`ok\`
      - Termination: \`completed\`
      - Cleanup: \`removed\`

      ## Next step

      Paste this complete output into the Store-reset incident issue form in the Coral GitHub repository.
      No file was uploaded. Do not attach DB, WAL, SHM, raw logs, credentials, settings, or environment files.
      The retained evidence is diagnostic only and cannot be restored as active Coral state.
      "
    `);
  });

  it('drops local-only runtime identity and unmodeled values', () => {
    const local = localReport() as StoreResetIncidentLocalReport & {
      readonly rawError: string;
      readonly rawChildOutput: string;
    };
    Object.assign(local, {
      rawError: 'private-error-sentinel',
      rawChildOutput: 'private-child-sentinel',
    });

    const report = projectStoreResetPublicReport(local);
    const rendered = formatStoreResetReport(report);

    expect(rendered).not.toContain('private-namespace-sentinel');
    expect(rendered).not.toContain('424242');
    expect(rendered).not.toContain('private-error-sentinel');
    expect(rendered).not.toContain('private-child-sentinel');
    expect(Object.keys(report)).toEqual([
      'incidentId',
      'resetAt',
      'reason',
      'storedFingerprint',
      'expectedFingerprint',
      'build',
      'handoff',
      'files',
      'diagnostic',
    ]);
  });
});
