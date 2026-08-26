import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTemporaryHomeOwner } from '#tests/support/temporary-home-lifecycle.js';

const preservedHomes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of preservedHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('temporary HOME lifecycle discovery', () => {
  it.each([
    ['corrupt JSON', '{'],
    ['a rejected record shape', JSON.stringify({ socketPath: '/tmp/coral.sock' })],
  ])('preserves the HOME when discovery contains %s', async (_label, discovery) => {
    const owner = createTemporaryHomeOwner();
    const home = owner.create('coral-undecodable-home-', 'prod');
    preservedHomes.push(home);
    const infoFile = owner.discoveryRuntime(home).paths.coral.coordinator.infoFile;
    mkdirSync(dirname(infoFile), { recursive: true });
    writeFileSync(infoFile, discovery, 'utf-8');
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});

    await owner.cleanup();

    expect(existsSync(home)).toBe(true);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('discovery record was undecodable'));
  });

  it('removes the HOME when discovery is missing', async () => {
    const owner = createTemporaryHomeOwner();
    const home = owner.create('coral-missing-discovery-home-', 'prod');

    await owner.cleanup();

    expect(existsSync(home)).toBe(false);
  });
});
