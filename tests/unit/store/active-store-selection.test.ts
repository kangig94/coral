import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_MAX_BYTES,
  ACTIVE_STORE_TRANSITION_MAX_BYTES,
  ActiveStoreSelectionDecodeError,
  ActiveStoreTransitionDecodeError,
  decodeActiveStoreSelection,
  decodeActiveStoreTransition,
  encodeActiveStoreSelection,
  encodeActiveStoreTransition,
  readActiveStoreSelection,
  readActiveStoreTransition,
  resolveActiveStoreRecordPaths,
  type ActiveStoreSelection,
  type ActiveStoreSelectionFailureCode,
  type ActiveStoreTransition,
  type NewerStoreEvidence,
} from '#src/store/active-store-selection.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';

const roots: string[] = [];
const encoder = new TextEncoder();
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function harness(): {
  readonly runtime: Runtime;
  readonly bundleDir: string;
  readonly selection: ActiveStoreSelection;
} {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-active-selection-'));
  roots.push(baseDir);
  const runtime = createRealRuntime('prod', { baseDir });
  const bundleDir = join(baseDir, 'bundle');
  mkdirSync(bundleDir, { mode: 0o700 });
  const selection: ActiveStoreSelection = {
    version: 1,
    manifest,
    bundleDir,
    activeStoreFingerprint: manifest.storeFormatFingerprint,
  };
  return { runtime, bundleDir, selection };
}

function publishRecord(runtime: Runtime, file: 'selectionFile' | 'transitionFile', bytes: Uint8Array): string {
  const paths = resolveActiveStoreRecordPaths(runtime);
  mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
  chmodSync(paths.coordinationRoot, 0o700);
  writeFileSync(paths[file], bytes, { mode: 0o600 });
  chmodSync(paths[file], 0o600);
  return paths[file];
}

function newerStoreEvidence(current: StrictBundleManifest = manifest): NewerStoreEvidence {
  return {
    kind: 'newer-incompatible',
    currentFingerprint: current.storeFormatFingerprint,
    currentProductVersion: current.version,
    storedFingerprint: `sha256:${'b'.repeat(64)}`,
    storedProductVersion: '3.0.0',
  };
}

function transition(
  selection: ActiveStoreSelection,
  evidence: ActiveStoreTransition['evidence'],
): ActiveStoreTransition {
  return {
    version: 1,
    transitionId: '223e4567-e89b-42d3-a456-426614174000',
    kind: 'selection-recovery',
    evidence,
    currentManifest: manifest,
    currentBundleDir: selection.bundleDir,
  };
}

function expectSelectionDecodeCode(bytes: Uint8Array, runtime: Runtime, code: string): void {
  try {
    decodeActiveStoreSelection(bytes, runtime.storage);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ActiveStoreSelectionDecodeError);
    expect((error as ActiveStoreSelectionDecodeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

function expectTransitionDecodeCode(bytes: Uint8Array, code: string): void {
  try {
    decodeActiveStoreTransition(bytes);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ActiveStoreTransitionDecodeError);
    expect((error as ActiveStoreTransitionDecodeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

const invalidSelectionCases: ReadonlyArray<
  readonly [string, (selection: ActiveStoreSelection) => Uint8Array, ActiveStoreSelectionFailureCode]
> = [
  ['invalid UTF-8', () => new Uint8Array([0xc3, 0x28]), 'selection_invalid_utf8'],
  ['invalid JSON', () => encoder.encode('{"version":1,}'), 'selection_invalid_json'],
  [
    'an unknown field',
    (selection) => encoder.encode(JSON.stringify({ ...selection, unknown: true })),
    'selection_invalid_schema',
  ],
  [
    'manifest disagreement',
    (selection) =>
      encoder.encode(
        JSON.stringify({
          ...selection,
          activeStoreFingerprint: `sha256:${'f'.repeat(64)}`,
        }),
      ),
    'selection_manifest_disagreement',
  ],
  [
    'a lexically non-canonical bundle path',
    (selection) => encoder.encode(JSON.stringify({ ...selection, bundleDir: 'relative/bundle' })),
    'selection_bundle_dir_not_canonical',
  ],
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('active-store-selection', () => {
  it('should derive both record paths from the generation coordination boundary', () => {
    const { runtime } = harness();
    const boundary = resolveGenerationBoundaryPaths(runtime);

    expect(resolveActiveStoreRecordPaths(runtime)).toEqual({
      coordinationRoot: boundary.coordinationRoot,
      selectionFile: join(boundary.coordinationRoot, 'active-store-selection.v1.json'),
      transitionFile: join(boundary.coordinationRoot, 'active-store-transition.v1.json'),
    });
  });

  it('should encode and read a strict selection from a private coordination directory', () => {
    const { runtime, selection } = harness();
    publishRecord(runtime, 'selectionFile', encodeActiveStoreSelection(selection));

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
  });

  it.each(invalidSelectionCases)('should distinguish %s', (_name, createBytes, code) => {
    const { runtime, selection } = harness();
    const bytes = createBytes(selection);
    expectSelectionDecodeCode(bytes, runtime, code);

    publishRecord(runtime, 'selectionFile', bytes);
    expect(readActiveStoreSelection(runtime)).toMatchObject({
      kind: 'malformed',
      evidence: {
        selectionByteLength: bytes.byteLength,
        selectionSha256: createHash('sha256').update(bytes).digest('hex'),
        failureCode: code,
      },
    });
  });

  it('should reject a symlinked bundle directory as non-canonical', () => {
    const { runtime, bundleDir, selection } = harness();
    const link = join(bundleDir, '..', 'bundle-link');
    symlinkSync(bundleDir, link, 'dir');

    expectSelectionDecodeCode(
      encoder.encode(JSON.stringify({ ...selection, bundleDir: link })),
      runtime,
      'selection_bundle_dir_not_canonical',
    );
  });

  it('should return bounded digest-only evidence for malformed selection bytes', () => {
    const { runtime } = harness();
    const bounded = Buffer.alloc(ACTIVE_STORE_SELECTION_MAX_BYTES, 0x61);
    const bytes = Buffer.concat([bounded, Buffer.from('body-that-must-not-survive')]);
    publishRecord(runtime, 'selectionFile', bytes);

    expect(readActiveStoreSelection(runtime)).toEqual({
      kind: 'malformed',
      evidence: {
        kind: 'selection-malformed',
        selectionByteLength: ACTIVE_STORE_SELECTION_MAX_BYTES,
        selectionSha256: createHash('sha256').update(bounded).digest('hex'),
        failureCode: 'selection_too_large',
      },
    });
  });

  it.each([
    ['selection link', 'record_link'],
    ['selection directory', 'record_not_regular'],
    ['selection mode', 'record_mode'],
  ])('should distinguish an invalid %s', (_name, failureCode) => {
    const { runtime, selection } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    chmodSync(paths.coordinationRoot, 0o700);

    if (failureCode === 'record_link') {
      const target = join(paths.coordinationRoot, 'selection-target.json');
      writeFileSync(target, encodeActiveStoreSelection(selection), { mode: 0o600 });
      symlinkSync(target, paths.selectionFile);
    } else if (failureCode === 'record_not_regular') {
      mkdirSync(paths.selectionFile, { mode: 0o700 });
    } else {
      writeFileSync(paths.selectionFile, encodeActiveStoreSelection(selection), { mode: 0o600 });
      chmodSync(paths.selectionFile, 0o755);
    }

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'rejected', failureCode });
  });

  it('should tolerate a wider coordination directory while retaining private record checks', () => {
    const { runtime, selection } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    publishRecord(runtime, 'selectionFile', encodeActiveStoreSelection(selection));
    chmodSync(paths.coordinationRoot, 0o755);

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
  });

  it('should encode and decode every closed transition evidence arm', () => {
    const { selection } = harness();
    const invalidTargetEvidence = {
      bundleDir: selection.bundleDir,
      expectedManifest: manifest,
      failure: 'adjacent-manifest-unavailable' as const,
    };
    const malformedEvidence = {
      kind: 'selection-malformed' as const,
      selectionByteLength: 12,
      selectionSha256: 'c'.repeat(64),
      failureCode: 'selection_invalid_json' as const,
      storeEvidence: { kind: 'pending-classification' as const },
    };
    const records: ActiveStoreTransition[] = [
      transition(selection, {
        kind: 'valid-target-invalid',
        priorSelection: selection,
        invalidTargetEvidence,
        storeEvidence: { kind: 'pending-classification' },
      }),
      transition(selection, {
        kind: 'selection-absent',
        storeEvidence: newerStoreEvidence(),
      }),
      transition(selection, malformedEvidence),
      transition(selection, {
        kind: 'current-selection-newer-store',
        priorSelection: selection,
        newerStoreEvidence: newerStoreEvidence(),
      }),
    ];

    for (const record of records) {
      expect(decodeActiveStoreTransition(encodeActiveStoreTransition(record))).toEqual(record);
    }

    const malformedRecord = transition(selection, malformedEvidence);
    const serialized = new TextDecoder().decode(encodeActiveStoreTransition(malformedRecord));
    expect(serialized).not.toContain('body-that-must-not-survive');
  });

  it('should reject illegal transition combinations and unknown fields in the schema', () => {
    const { selection } = harness();
    const base = transition(selection, {
      kind: 'current-selection-newer-store',
      priorSelection: selection,
      newerStoreEvidence: newerStoreEvidence(),
    });

    expectTransitionDecodeCode(
      encoder.encode(
        JSON.stringify({
          ...base,
          evidence: {
            kind: 'current-selection-newer-store',
            priorSelection: selection,
            storeEvidence: { kind: 'pending-classification' },
          },
        }),
      ),
      'transition_invalid_schema',
    );
    expectTransitionDecodeCode(
      encoder.encode(JSON.stringify({ ...base, evidence: { ...base.evidence, unknown: true } })),
      'transition_invalid_schema',
    );
    expectTransitionDecodeCode(
      encoder.encode(
        JSON.stringify({
          ...base,
          evidence: {
            ...base.evidence,
            newerStoreEvidence: {
              ...newerStoreEvidence(),
              currentFingerprint: `sha256:${'f'.repeat(64)}`,
            },
          },
        }),
      ),
      'transition_invalid_schema',
    );
  });

  it('should bound and strictly decode the transition record', () => {
    const { runtime, selection } = harness();
    const record = transition(selection, {
      kind: 'selection-absent',
      storeEvidence: { kind: 'pending-classification' },
    });
    publishRecord(runtime, 'transitionFile', encodeActiveStoreTransition(record));

    expect(readActiveStoreTransition(runtime)).toEqual({ kind: 'valid', transition: record });
    expectTransitionDecodeCode(new Uint8Array([0xc3, 0x28]), 'transition_invalid_utf8');
    expectTransitionDecodeCode(encoder.encode('{"version":1,}'), 'transition_invalid_json');
    expectTransitionDecodeCode(new Uint8Array(ACTIVE_STORE_TRANSITION_MAX_BYTES + 1), 'transition_too_large');
  });
});
