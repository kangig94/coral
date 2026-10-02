import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { recoverDamagedStartupWriter } from '#src/coordinator/succession/writer-recovery.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { createPluginFixture, spawnCoordinator, stopCoordinator, waitForDiscoveryRecord } from './helpers.js';

it.each([
  ['succession-writer.lock', Buffer.from('garbage'), false],
  ['succession-writer-generation.v1.json', Buffer.from('garbage'), false],
  ['succession-writer-generation.v1.json', Buffer.from([0xff, 0x00, 0x80]), false],
  ['succession-writer-generation.v1.json', Buffer.from('garbage'), true],
] as const)('automatically recovers repeated boots after damage to %s (%s)', async (file, damage, damagedEpochLock) => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'coral-writer-damage-'));
  roots.push(home);
  const fixture = createPluginFixture(roots, { flavor: 'prod' });
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const root = resolveGenerationBoundaryPaths(runtime).coordinationRoot;
  let child = spawnCoordinator({ fixture, home, tempRoots: roots });
  try {
    await waitForDiscoveryRecord(home, 'prod', 12_000);
    await stopCoordinator(child);
    writeFileSync(join(root, file), damage);
    if (damagedEpochLock) writeFileSync(join(runtime.paths.coral.store.dbDir, 'epoch-1', '.lock'), 'garbage');
    for (let attempt = 0; attempt < 2; attempt++) {
      child = spawnCoordinator({ fixture, home, tempRoots: roots });
      const discovery = await waitForDiscoveryRecord(home, 'prod', 12_000);
      await expect(
        requestIpcMethod(discovery.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: discovery.bootToken },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ status: 'ok' });
      await stopCoordinator(child);
    }
    const quarantined = readdirSync(root).find(
      (name) => name.startsWith(`${file}.malformed-`) || name.startsWith(`${file}.corrupt-`),
    );
    expect(quarantined).toBeDefined();
    expect(readFileSync(join(root, quarantined!))).toEqual(damage);
  } finally {
    await stopCoordinator(child);
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
});

it('does not reconstruct while an incumbent writer is still alive', async () => {
  const roots: string[] = [];
  const home = mkdtempSync(join(tmpdir(), 'coral-live-writer-damage-'));
  roots.push(home);
  const fixture = createPluginFixture(roots, { flavor: 'prod' });
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const root = resolveGenerationBoundaryPaths(runtime).coordinationRoot;
  const path = join(root, 'succession-writer-generation.v1.json');
  const child = spawnCoordinator({ fixture, home, tempRoots: roots });
  let original: Buffer | undefined;
  try {
    await waitForDiscoveryRecord(home, 'prod', 12_000);
    original = readFileSync(path);
    writeFileSync(path, 'garbage');
    expect(() => recoverDamagedStartupWriter(runtime)).toThrow(/absent epoch holders/u);
    expect(readFileSync(path, 'utf8')).toBe('garbage');
    expect(readdirSync(root).some((name) => name.startsWith('succession-writer-generation.v1.json.corrupt-'))).toBe(
      false,
    );
  } finally {
    if (original !== undefined) writeFileSync(path, original);
    await stopCoordinator(child);
    for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
  }
});
