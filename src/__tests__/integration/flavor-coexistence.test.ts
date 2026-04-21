import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCoralPaths } from '../../coordinator/paths.js';
import { equipmentAddonPath, equipmentDataDir, equipmentInstallLockPath } from '../../infra/equipment-paths.js';

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
    const prodEnv: NodeJS.ProcessEnv = {};
    const devEnv: NodeJS.ProcessEnv = { CORAL_FLAVOR: 'dev' };

    expect(equipmentDataDir('needle', { baseDir, env: prodEnv })).toBe(
      join(baseDir, 'data', 'equipment', 'needle'),
    );
    expect(equipmentDataDir('needle', { baseDir, env: devEnv })).toBe(
      join(baseDir, 'data-dev', 'equipment', 'needle'),
    );
    expect(equipmentAddonPath('needle', { baseDir, env: prodEnv })).toBe(
      join(baseDir, 'data', 'equipment', 'needle', 'coral-needle.node'),
    );
    expect(equipmentAddonPath('needle', { baseDir, env: devEnv })).toBe(
      join(baseDir, 'data-dev', 'equipment', 'needle', 'coral-needle.node'),
    );
    expect(equipmentInstallLockPath('needle', { baseDir, env: prodEnv })).toBe(
      join(baseDir, 'data', 'equipment', 'needle', 'install.lock'),
    );
    expect(equipmentInstallLockPath('needle', { baseDir, env: devEnv })).toBe(
      join(baseDir, 'data-dev', 'equipment', 'needle', 'install.lock'),
    );
  });
});
