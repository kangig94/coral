import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCoralPaths } from '#src/infra/path/compose.js';
import { equipmentPaths } from '#src/infra/path/equipment.js';

function assertDistinctPathPair(prodPath: string, devPath: string): void {
  expect(prodPath).not.toBe(devPath);
  expect(devPath.startsWith(`${prodPath}/`)).toBe(false);
  expect(prodPath.startsWith(`${devPath}/`)).toBe(false);
}

describe('flavor coexistence integration', () => {
  it('keeps prod and dev equipment roots isolated', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');

    expect(prod.equipment.equipmentRoot).toContain('data/equipment');
    expect(dev.equipment.equipmentRoot).toContain('data-dev/equipment');
    assertDistinctPathPair(prod.equipment.equipmentRoot, dev.equipment.equipmentRoot);
  });

  it('routes equipment helpers to the flavor-specific install directories', () => {
    const baseDir = '/tmp/coral-flavor-coexistence';
    const prodEq = equipmentPaths('prod', { baseDir });
    const devEq = equipmentPaths('dev', { baseDir });

    expect(prodEq.dataDir('needle')).toBe(join(baseDir, 'data', 'equipment', 'needle'));
    expect(devEq.dataDir('needle')).toBe(join(baseDir, 'data-dev', 'equipment', 'needle'));
    expect(prodEq.addonPath('needle')).toBe(
      join(baseDir, 'data', 'equipment', 'needle', 'coral-needle.node'),
    );
    expect(devEq.addonPath('needle')).toBe(
      join(baseDir, 'data-dev', 'equipment', 'needle', 'coral-needle.node'),
    );
    expect(prodEq.installLockPath('needle')).toBe(join(baseDir, 'data', 'equipment', 'needle', 'install.lock'));
    expect(devEq.installLockPath('needle')).toBe(
      join(baseDir, 'data-dev', 'equipment', 'needle', 'install.lock'),
    );
  });
});
