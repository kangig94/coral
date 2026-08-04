import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ValidatedHandoffTarget,
} from '#src/infra/handoff-target.js';

const roots: string[] = [];
const backendBundle = 'foreign backend fixture';
const cliBundle = 'foreign cli fixture';
const claudeAppserverBundle = 'foreign claude appserver fixture';
const manifest: StrictBundleManifest = {
  version: '2.1.0',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: createHash('sha256').update(backendBundle).digest('hex').slice(0, 16),
  cliBundleHash: createHash('sha256').update(cliBundle).digest('hex').slice(0, 16),
  claudeAppserverBundleHash: createHash('sha256').update(claudeAppserverBundle).digest('hex').slice(0, 16),
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
};

function createBundle(adjacentManifest: unknown = manifest): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-handoff-target-'));
  roots.push(root);
  writeFileSync(join(root, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(root, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(root, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(adjacentManifest), 'utf8');
  return root;
}

async function releaseTarget(target: ValidatedHandoffTarget): Promise<void> {
  await withValidatedHandoffTarget(target, () => undefined);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('handoff-target', () => {
  it('should seal a validated target and expose its evidence only inside the execution boundary', async () => {
    const bundleDir = createBundle();
    const result = createForeignTargetValidator()(bundleDir, manifest);

    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Reflect.ownKeys(result.target)).toEqual([]);
    const lockPath = join(dirname(bundleDir), `.${basename(bundleDir)}.coral-target-execution.lock`);
    expect(existsSync(lockPath)).toBe(true);

    await withValidatedHandoffTarget(result.target, (execution) => {
      expect(execution.bundleDir).toBe(bundleDir);
      expect(execution.manifest).toEqual(manifest);
      execution.assertExecutable();
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    ['version', { ...manifest, version: '2.2.0' }],
    ['buildSetId', { ...manifest, buildSetId: '223e4567-e89b-42d3-a456-426614174000' }],
    ['bundleHash', { ...manifest, bundleHash: 'f'.repeat(16) }],
    ['cliBundleHash', { ...manifest, cliBundleHash: 'e'.repeat(16) }],
    ['claudeAppserverBundleHash', { ...manifest, claudeAppserverBundleHash: 'd'.repeat(16) }],
    ['flavor', { ...manifest, flavor: 'dev' as const }],
    ['storeFormatFingerprint', { ...manifest, storeFormatFingerprint: `sha256:${'b'.repeat(64)}` }],
  ])('should reject an adjacent manifest whose %s differs from the authenticated identity', (_field, expected) => {
    const result = createForeignTargetValidator()(createBundle(), expected);

    expect(result).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-manifest-mismatch' },
    });
  });

  it.each([
    ['coral-backend.cjs', 'tampered backend'],
    ['coral-cli.cjs', 'tampered cli'],
    ['coral-claude-appserver.cjs', 'tampered claude appserver'],
  ])('should hash and reject a changed %s', (fileName, contents) => {
    const bundleDir = createBundle();
    writeFileSync(join(bundleDir, fileName), contents, 'utf8');

    expect(createForeignTargetValidator()(bundleDir, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-bundle-mismatch' },
    });
  });

  it('should reject malformed and non-strict adjacent manifests', () => {
    const malformed = createBundle();
    writeFileSync(join(malformed, 'manifest.json'), '{not-json', 'utf8');
    expect(createForeignTargetValidator()(malformed, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-manifest-invalid' },
    });

    const unknownField = createBundle({ ...manifest, extra: true });
    expect(createForeignTargetValidator()(unknownField, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-manifest-invalid' },
    });
  });

  it('should reject missing adjacent manifests and invalid expected manifests', () => {
    const missing = createBundle();
    rmSync(join(missing, 'manifest.json'));
    expect(createForeignTargetValidator()(missing, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'adjacent-manifest-unavailable' },
    });

    const bundleDir = createBundle();
    expect(createForeignTargetValidator()(bundleDir, { ...manifest, version: 'latest' })).toMatchObject({
      kind: 'invalid',
      evidence: { expectedManifest: null, failure: 'expected-manifest-invalid' },
    });
  });

  it('should require the supplied bundle directory to be canonical', () => {
    const bundleDir = createBundle();
    const linkRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-link-'));
    roots.push(linkRoot);
    const link = join(linkRoot, 'bundle');
    symlinkSync(bundleDir, link, 'dir');

    expect(createForeignTargetValidator()(link, manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'bundle-dir-not-canonical' },
    });
    expect(createForeignTargetValidator()('relative/bundle', manifest)).toMatchObject({
      kind: 'invalid',
      evidence: { failure: 'bundle-dir-not-canonical' },
    });
  });

  it('should release the target lease after invalid validation', async () => {
    const bundleDir = createBundle({ ...manifest, version: '2.0.0' });
    expect(createForeignTargetValidator()(bundleDir, manifest).kind).toBe('invalid');
    writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const retried = createForeignTargetValidator()(bundleDir, manifest);
    expect(retried.kind).toBe('validated');
    if (retried.kind === 'validated') {
      await releaseTarget(retried.target);
    }
  });

  it('should re-hash while holding the lease immediately before execution', async () => {
    const bundleDir = createBundle();
    const result = createForeignTargetValidator()(bundleDir, manifest);
    expect(result.kind).toBe('validated');
    if (result.kind !== 'validated') return;
    writeFileSync(join(bundleDir, 'coral-cli.cjs'), 'changed after validation', 'utf8');

    await expect(
      withValidatedHandoffTarget(result.target, (execution) => execution.assertExecutable()),
    ).rejects.toThrow('bytes changed before execution');
  });

  it('should reject a cast object at the consumer boundary', async () => {
    await expect(withValidatedHandoffTarget({} as ValidatedHandoffTarget, () => undefined)).rejects.toThrow(
      'was not produced',
    );
  });
});
