import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { installedBuild, validatedRunningBuildRoot } from '#src/infra/installed-build-root.js';
import * as registry from '#src/infra/plugin-registry.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-installed-build-'));
  roots.push(root);
  const manifest = strictBundleManifestSchema.parse(JSON.parse(readFileSync('clients/build/manifest.v2.json', 'utf8')));
  const installed = join(root, 'plugin-cache');
  const oldCopy = join(root, 'gen2', 'builds', manifest.buildSetId);
  cpSync('clients/build', join(installed, 'bridge'), { recursive: true });
  cpSync('clients/build', join(oldCopy, 'bridge'), { recursive: true });
  const installedPluginRoots = vi.fn(() => [installed]);
  vi.spyOn(registry, 'createPluginRegistry').mockReturnValue({ installedPluginRoots } as unknown as ReturnType<
    typeof registry.createPluginRegistry
  >);
  return { root, manifest, installed, oldCopy, installedPluginRoots };
}

it('finds a build only through validated installed registry roots', () => {
  const f = fixture();
  const invalid = join(f.root, 'invalid');
  mkdirSync(join(invalid, 'bridge'), { recursive: true });
  writeFileSync(join(invalid, 'bridge', 'manifest.v2.json'), '{}');
  f.installedPluginRoots.mockReturnValue([invalid, f.installed]);
  expect(installedBuild(f.manifest.buildSetId)).toEqual({ root: f.installed, manifest: f.manifest });
  expect(installedBuild('11111111-1111-4111-8111-111111111111')).toBeNull();
});

it('accepts a literal legacy copy root without discovering it by build id', () => {
  const f = fixture();
  rmSync(f.installed, { recursive: true });
  expect(installedBuild(f.manifest.buildSetId)).toBeNull();
  expect(validatedRunningBuildRoot(f.oldCopy, f.manifest)).toBe(f.oldCopy);
});
