import { describe, expect, it } from 'vitest';

import {
  MAX_RESET_MANIFEST_BYTES,
  MAX_RESET_MANIFEST_JSON_DEPTH,
  parseStoreResetIncidentManifest,
  serializeStoreResetIncidentManifest,
  StoreResetManifestDecodeError,
  type StoreResetIncidentManifestV2,
} from '#src/store/reset-incident.js';

const encoder = new TextEncoder();

function manifest(): StoreResetIncidentManifestV2 {
  return {
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
      namespace: 'test-namespace',
      nodeVersion: 'v24.7.0',
      platform: 'linux',
      architecture: 'x64',
      processId: 42,
    },
    handoff: {
      acquiredViaHandoff: true,
    },
    files: [
      {
        name: 'store.db',
        sizeBytes: 123,
        mtimeMs: 1_754_000_000_000.25,
        sha256: 'a'.repeat(64),
      },
      {
        name: 'store.db.format',
        sizeBytes: 72,
        mtimeMs: 1_754_000_000_001,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function expectDecodeCode(run: () => unknown, code: StoreResetManifestDecodeError['code']): void {
  try {
    run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(StoreResetManifestDecodeError);
    expect((error as StoreResetManifestDecodeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe('store reset incident manifest parser', () => {
  it('parses the exact current schema and freezes the validated result', () => {
    const parsed = parseStoreResetIncidentManifest(bytes(manifest()));

    expect(parsed).toEqual(manifest());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.build)).toBe(true);
    expect(Object.isFrozen(parsed.files)).toBe(true);
    expect(Object.isFrozen(parsed.files[0])).toBe(true);
  });

  it('serializes only known fields in deterministic schema order', () => {
    const input = {
      ...manifest(),
      ignored: 'root-sentinel',
      build: { ...manifest().build, ignored: 'build-sentinel' },
      files: [{ ...manifest().files[0], ignored: 'file-sentinel' }],
    };

    const serialized = serializeStoreResetIncidentManifest(input);

    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).not.toContain('sentinel');
    expect(Object.keys(JSON.parse(serialized) as object)).toEqual([
      'schemaVersion',
      'incidentId',
      'resetAt',
      'reason',
      'storedFingerprint',
      'expectedFingerprint',
      'build',
      'runtime',
      'handoff',
      'files',
    ]);
    expect(parseStoreResetIncidentManifest(encoder.encode(serialized))).toEqual({
      ...manifest(),
      files: [manifest().files[0]],
    });
  });

  it('rejects legacy schema versions and invalid known fields', () => {
    expectDecodeCode(
      () => parseStoreResetIncidentManifest(bytes({ ...manifest(), schemaVersion: 1 })),
      'manifest_invalid_schema',
    );
    expectDecodeCode(
      () => parseStoreResetIncidentManifest(bytes({ ...manifest(), resetAt: '2026-07-23' })),
      'manifest_invalid_schema',
    );
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          bytes({
            ...manifest(),
            build: { ...manifest().build, backendBundleHash: 'test-bundle' },
          }),
        ),
      'manifest_invalid_schema',
    );
  });

  it('requires every current field while discarding unknown fields', () => {
    const { runtime: _runtime, ...missingRuntime } = manifest();
    expectDecodeCode(() => parseStoreResetIncidentManifest(bytes(missingRuntime)), 'manifest_invalid_schema');

    const parsed = parseStoreResetIncidentManifest(
      bytes({
        ...manifest(),
        unknown: { safely: ['discarded'] },
      }),
    );
    expect(parsed).toEqual(manifest());
  });

  it('rejects duplicate decoded keys at every object level, including unknown objects', () => {
    const valid = JSON.stringify(manifest());
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          encoder.encode(valid.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')),
        ),
      'manifest_duplicate_key',
    );
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          encoder.encode(valid.replace('"version":"0.9.16"', '"version":"0.9.16","\\u0076ersion":"0.9.16"')),
        ),
      'manifest_duplicate_key',
    );
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(encoder.encode(valid.replace(/}$/, ',"unknown":{"name":1,"\\u006eame":2}}'))),
      'manifest_duplicate_key',
    );
  });

  it('rejects malformed or non-fatally-decodable input before semantic validation', () => {
    expectDecodeCode(() => parseStoreResetIncidentManifest(new Uint8Array([0xc3, 0x28])), 'manifest_invalid_utf8');
    expectDecodeCode(
      () => parseStoreResetIncidentManifest(encoder.encode('{"schemaVersion":2,}')),
      'manifest_invalid_json',
    );
  });

  it('enforces the byte limit and explicit container depth limit', () => {
    expectDecodeCode(
      () => parseStoreResetIncidentManifest(new Uint8Array(MAX_RESET_MANIFEST_BYTES + 1)),
      'manifest_too_large',
    );

    const nested = `${'{"unknown":'.repeat(MAX_RESET_MANIFEST_JSON_DEPTH + 1)}null${'}'.repeat(
      MAX_RESET_MANIFEST_JSON_DEPTH + 1,
    )}`;
    expectDecodeCode(() => parseStoreResetIncidentManifest(encoder.encode(nested)), 'manifest_depth_exceeded');
  });

  it('accepts manifests exactly at the byte and container depth limits', () => {
    const serialized = encoder.encode(serializeStoreResetIncidentManifest(manifest()));
    const exactBytes = new Uint8Array(MAX_RESET_MANIFEST_BYTES);
    exactBytes.fill(0x20);
    exactBytes.set(serialized);

    expect(parseStoreResetIncidentManifest(exactBytes)).toEqual(manifest());

    let nestedUnknown: unknown = null;
    for (let depth = 0; depth < MAX_RESET_MANIFEST_JSON_DEPTH - 1; depth += 1) {
      nestedUnknown = { nested: nestedUnknown };
    }
    expect(parseStoreResetIncidentManifest(bytes({ ...manifest(), unknown: nestedUnknown }))).toEqual(manifest());
  });

  it('rejects duplicate, unknown, or non-canonically ordered evidence files', () => {
    const base = manifest();
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          bytes({
            ...base,
            files: [base.files[0], base.files[0]],
          }),
        ),
      'manifest_invalid_schema',
    );
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          bytes({
            ...base,
            files: [base.files[1], base.files[0]],
          }),
        ),
      'manifest_invalid_schema',
    );
    expectDecodeCode(
      () =>
        parseStoreResetIncidentManifest(
          bytes({
            ...base,
            files: [{ ...base.files[0], name: 'store.db-journal' }],
          }),
        ),
      'manifest_invalid_schema',
    );
  });
});
