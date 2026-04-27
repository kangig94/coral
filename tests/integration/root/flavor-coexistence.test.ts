import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCoralPaths } from '#src/infra/path/compose.js';
import { expansionPaths } from '#src/infra/path/expansion.js';

function assertDistinctPathPair(prodPath: string, devPath: string): void {
  expect(prodPath).not.toBe(devPath);
  expect(devPath.startsWith(`${prodPath}/`)).toBe(false);
  expect(prodPath.startsWith(`${devPath}/`)).toBe(false);
}

describe('flavor coexistence integration', () => {
  it('keeps prod and dev expansion roots isolated', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');

    expect(prod.expansion.expansionRoot).toContain('data/expansion');
    expect(dev.expansion.expansionRoot).toContain('data-dev/expansion');
    assertDistinctPathPair(prod.expansion.expansionRoot, dev.expansion.expansionRoot);
  });

  it('routes expansion helpers to the flavor-specific install directories', () => {
    const baseDir = '/tmp/coral-flavor-coexistence';
    const prodEq = expansionPaths('prod', { baseDir });
    const devEq = expansionPaths('dev', { baseDir });

    expect(prodEq.dataDir('needle')).toBe(join(baseDir, 'data', 'expansion', 'needle'));
    expect(devEq.dataDir('needle')).toBe(join(baseDir, 'data-dev', 'expansion', 'needle'));
    expect(prodEq.addonPath('needle')).toBe(
      join(baseDir, 'data', 'expansion', 'needle', 'coral-needle.node'),
    );
    expect(devEq.addonPath('needle')).toBe(
      join(baseDir, 'data-dev', 'expansion', 'needle', 'coral-needle.node'),
    );
    expect(prodEq.installLockPath('needle')).toBe(join(baseDir, 'data', 'expansion', 'needle', 'install.lock'));
    expect(devEq.installLockPath('needle')).toBe(
      join(baseDir, 'data-dev', 'expansion', 'needle', 'install.lock'),
    );
  });
});
