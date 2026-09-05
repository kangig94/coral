import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { hashStableAdjacentBundle, type StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { compareProductVersions } from '#src/infra/product-version.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  ACTIVE_STORE_SELECTION_MAX_BYTES,
  ACTIVE_STORE_SELECTION_VERSION,
  ACTIVE_STORE_TRANSITION_MAX_BYTES,
  ACTIVE_STORE_TRANSITION_VERSION,
  ActiveStoreSelectionDecodeError,
  ActiveStoreTransitionDecodeError,
  decodeActiveStoreSelection,
  decodeActiveStoreTransition,
  encodeActiveStoreSelection,
  encodeActiveStoreTransition,
  publishActiveStoreSelection,
  readActiveStoreSelection,
  readActiveStoreSelectionForCoordination,
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
const v0109ManifestSchema = z
  .object({
    version: z
      .string()
      .max(128)
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    buildSetId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    bundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    cliBundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    claudeAppserverBundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
const v0109SelectionSchema = z
  .object({
    version: z.literal(1),
    manifest: v0109ManifestSchema,
    bundleDir: z.string().min(1),
    activeStoreFingerprint: v0109ManifestSchema.shape.storeFormatFingerprint,
  })
  .strict();
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '123456789abcdef0',
  claudeAppserverBundleHash: '23456789abcdef01',
  durableWrapperBundleHash: '3456789abcdef012',
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
    version: ACTIVE_STORE_SELECTION_VERSION,
    manifest,
    bundleDir,
    activeStoreFingerprint: manifest.storeFormatFingerprint,
  };
  return { runtime, bundleDir, selection };
}

function decodeV0109ActiveStoreSelection(bytes: Uint8Array): z.infer<typeof v0109SelectionSchema> {
  if (bytes.byteLength > ACTIVE_STORE_SELECTION_MAX_BYTES) throw new Error('selection_too_large');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  const parsed = v0109SelectionSchema.parse(value);
  if (parsed.activeStoreFingerprint !== parsed.manifest.storeFormatFingerprint) {
    throw new Error('selection_manifest_disagreement');
  }
  if (!isAbsolute(parsed.bundleDir) || resolve(parsed.bundleDir) !== parsed.bundleDir) {
    throw new Error('selection_bundle_dir_not_canonical');
  }
  return parsed;
}

function v0109ManifestMatches(
  left: z.infer<typeof v0109ManifestSchema>,
  right: z.infer<typeof v0109ManifestSchema>,
): boolean {
  return Object.keys(v0109ManifestSchema.shape).every(
    (field) => left[field as keyof typeof left] === right[field as keyof typeof right],
  );
}

function v0109ValidatesSelectedTarget(selected: z.infer<typeof v0109SelectionSchema>): boolean {
  if (!isAbsolute(selected.bundleDir) || resolve(selected.bundleDir) !== selected.bundleDir) return false;
  try {
    if (realpathSync(selected.bundleDir) !== selected.bundleDir) return false;
    const adjacent = v0109ManifestSchema.parse(
      JSON.parse(readFileSync(join(selected.bundleDir, 'manifest.json'), 'utf8')),
    );
    if (!v0109ManifestMatches(adjacent, selected.manifest)) return false;
    return (
      hashStableAdjacentBundle(selected.bundleDir, 'coral-backend.cjs') === selected.manifest.bundleHash &&
      hashStableAdjacentBundle(selected.bundleDir, 'coral-cli.cjs') === selected.manifest.cliBundleHash &&
      hashStableAdjacentBundle(selected.bundleDir, 'coral-claude-appserver.cjs') ===
        selected.manifest.claudeAppserverBundleHash
    );
  } catch {
    return false;
  }
}

function coordinateV0109ActiveStoreSelection(
  bytes: Uint8Array,
): Readonly<{ kind: 'handoff' }> | Readonly<{ kind: 'opened' }> {
  const selected = decodeV0109ActiveStoreSelection(bytes);
  if (compareProductVersions(selected.manifest.version, '0.10.9') <= 0) return { kind: 'opened' };
  return v0109ValidatesSelectedTarget(selected) ? { kind: 'handoff' } : { kind: 'opened' };
}

function writeV0109BundleFile(bundleDir: string, fileName: string, contents: string): string {
  writeFileSync(join(bundleDir, fileName), contents, { mode: 0o600 });
  return createHash('sha256').update(contents).digest('hex').slice(0, 16);
}

function installV0109TargetBundle(selection: ActiveStoreSelection): ActiveStoreSelection {
  const hashes = {
    bundleHash: writeV0109BundleFile(selection.bundleDir, 'coral-backend.cjs', 'backend bundle'),
    cliBundleHash: writeV0109BundleFile(selection.bundleDir, 'coral-cli.cjs', 'cli bundle'),
    claudeAppserverBundleHash: writeV0109BundleFile(
      selection.bundleDir,
      'coral-claude-appserver.cjs',
      'appserver bundle',
    ),
  };
  const selected = {
    ...selection,
    manifest: { ...selection.manifest, ...hashes },
  };
  const releasedManifest = {
    version: selected.manifest.version,
    buildSetId: selected.manifest.buildSetId,
    bundleHash: selected.manifest.bundleHash,
    cliBundleHash: selected.manifest.cliBundleHash,
    claudeAppserverBundleHash: selected.manifest.claudeAppserverBundleHash,
    flavor: selected.manifest.flavor,
    storeFormatFingerprint: selected.manifest.storeFormatFingerprint,
  };
  writeFileSync(join(selection.bundleDir, 'manifest.json'), JSON.stringify(releasedManifest), { mode: 0o600 });
  return selected;
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
    version: ACTIVE_STORE_TRANSITION_VERSION,
    transitionId: '223e4567-e89b-42d3-a456-426614174000',
    kind: 'selection-recovery',
    evidence,
    currentManifest: manifest,
    currentBundleDir: selection.bundleDir,
  };
}

function expectSelectionDecodeCode(bytes: Uint8Array, code: string): void {
  try {
    decodeActiveStoreSelection(bytes);
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
  it('should derive all versioned record paths from the generation coordination boundary', () => {
    const { runtime } = harness();
    const boundary = resolveGenerationBoundaryPaths(runtime);

    expect(resolveActiveStoreRecordPaths(runtime)).toEqual({
      coordinationRoot: boundary.coordinationRoot,
      selectionFile: join(boundary.coordinationRoot, 'active-store-selection.v2.json'),
      transitionFile: join(boundary.coordinationRoot, 'active-store-transition.v2.json'),
      selectionV1File: join(boundary.coordinationRoot, 'active-store-selection.v1.json'),
      transitionV1File: join(boundary.coordinationRoot, 'active-store-transition.v1.json'),
    });
  });

  it('should publish a v1 selection that the v0.10.9 decoder understands for routing', () => {
    const { runtime, selection: emptyTargetSelection } = harness();
    const selection = installV0109TargetBundle(emptyTargetSelection);
    publishActiveStoreSelection(runtime, selection);

    const releasedRecord = readFileSync(resolveActiveStoreRecordPaths(runtime).selectionV1File);
    const decoded = decodeV0109ActiveStoreSelection(releasedRecord);
    const v1Manifest = {
      version: selection.manifest.version,
      buildSetId: selection.manifest.buildSetId,
      bundleHash: selection.manifest.bundleHash,
      cliBundleHash: selection.manifest.cliBundleHash,
      claudeAppserverBundleHash: selection.manifest.claudeAppserverBundleHash,
      flavor: selection.manifest.flavor,
      storeFormatFingerprint: selection.manifest.storeFormatFingerprint,
    };
    expect(decoded).toEqual({
      version: 1,
      manifest: v1Manifest,
      bundleDir: selection.bundleDir,
      activeStoreFingerprint: selection.activeStoreFingerprint,
    });
    expect(decoded.manifest.version).toBe(selection.manifest.version);
    expect(decoded.bundleDir).toBe(selection.bundleDir);
    expect(decoded.manifest).not.toHaveProperty('durableWrapperBundleHash');
    expect(coordinateV0109ActiveStoreSelection(releasedRecord)).toEqual({ kind: 'handoff' });
  });

  it.each([
    ['absent v2', false],
    ['stale v2', true],
  ] as const)(
    'should expose the committed v1 projection instead of a %s after an interrupted publication',
    (_case, stale) => {
      const { runtime, selection } = harness();
      if (stale) {
        publishActiveStoreSelection(runtime, {
          ...selection,
          manifest: {
            ...selection.manifest,
            version: '1.0.0',
            buildSetId: '223e4567-e89b-42d3-a456-426614174000',
          },
        });
      }
      const paths = resolveActiveStoreRecordPaths(runtime);
      const write = runtime.storage.writeAtomicDurableSync.bind(runtime.storage);
      runtime.storage.writeAtomicDurableSync = (path, bytes, options) =>
        path === paths.selectionFile ? false : write(path, bytes, options);

      expect(() => publishActiveStoreSelection(runtime, selection)).toThrow();
      runtime.storage.writeAtomicDurableSync = write;

      expect(readActiveStoreSelectionForCoordination(runtime)).toMatchObject({
        kind: 'v1',
        selection: {
          version: 1,
          manifest: { version: selection.manifest.version, buildSetId: selection.manifest.buildSetId },
          bundleDir: selection.bundleDir,
        },
      });
    },
  );

  it('should encode and read a strict selection from a private coordination directory', () => {
    const { runtime, selection } = harness();
    publishRecord(runtime, 'selectionFile', encodeActiveStoreSelection(selection));

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
  });

  it.each(invalidSelectionCases)('should distinguish %s', (_name, createBytes, code) => {
    const { runtime, selection } = harness();
    const bytes = createBytes(selection);
    expectSelectionDecodeCode(bytes, code);

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

  it('should leave filesystem target validation out of the lexical selection decoder', () => {
    const { bundleDir, selection } = harness();
    const link = join(bundleDir, '..', 'bundle-link');
    symlinkSync(bundleDir, link, 'dir');

    expect(decodeActiveStoreSelection(encoder.encode(JSON.stringify({ ...selection, bundleDir: link })))).toEqual({
      ...selection,
      bundleDir: link,
    });
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
    }

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'rejected', failureCode });
  });

  it('should repair a wrong-mode record owned by the current user before reading it', () => {
    const { runtime, selection } = harness();
    const path = publishRecord(runtime, 'selectionFile', encodeActiveStoreSelection(selection));
    chmodSync(path, 0o755);

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.getuid === undefined)('should refuse mode repair for a foreign-owned record', () => {
    const { runtime, selection } = harness();
    const path = publishRecord(runtime, 'selectionFile', encodeActiveStoreSelection(selection));
    chmodSync(path, 0o755);
    const stat = runtime.storage.statSync.bind(runtime.storage);
    vi.spyOn(runtime.storage, 'statSync').mockImplementation((target, options) => {
      const result = stat(target, options);
      return target === path
        ? {
            ...result,
            uid: BigInt(process.getuid?.() ?? 0) + 1n,
            isDirectory: () => result.isDirectory(),
            isFile: () => result.isFile(),
          }
        : result;
    });
    const chmod = vi.spyOn(runtime.storage, 'chmodSync');

    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'rejected', failureCode: 'record_mode' });
    expect(chmod).not.toHaveBeenCalled();
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32')('should establish mode 0600 under a restrictive umask', () => {
    const { runtime, selection } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    const previousUmask = process.umask(0o277);
    try {
      expect(
        runtime.storage.writeAtomicDurableSync(paths.selectionFile, encodeActiveStoreSelection(selection), {
          mode: 0o600,
        }),
      ).toBe(true);
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(paths.selectionFile).mode & 0o777).toBe(0o600);
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
  });

  it.skipIf(process.platform === 'win32')('should correct a leftover temporary file mode before publication', () => {
    const { runtime, selection } = harness();
    const paths = resolveActiveStoreRecordPaths(runtime);
    mkdirSync(paths.coordinationRoot, { recursive: true, mode: 0o700 });
    writeFileSync(`${paths.selectionFile}.tmp`, 'interrupted publication', { mode: 0o777 });
    chmodSync(`${paths.selectionFile}.tmp`, 0o777);

    expect(
      runtime.storage.writeAtomicDurableSync(paths.selectionFile, encodeActiveStoreSelection(selection), {
        mode: 0o600,
      }),
    ).toBe(true);

    expect(statSync(paths.selectionFile).mode & 0o777).toBe(0o600);
    expect(readActiveStoreSelection(runtime)).toEqual({ kind: 'valid', selection });
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
