import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCoralPaths } from '#src/infra/path/index.js';
import { enginePaths } from '#src/infra/path/engine.js';

function assertDistinctPathPair(prodPath: string, devPath: string): void {
  expect(prodPath).not.toBe(devPath);
  expect(devPath.startsWith(`${prodPath}/`)).toBe(false);
  expect(prodPath.startsWith(`${devPath}/`)).toBe(false);
}

describe('flavor coexistence integration', () => {
  it('keeps prod and dev expansion roots isolated', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');

    expect(prod.engine.engineRoot).toContain('data/engines');
    expect(dev.engine.engineRoot).toContain('data-dev/engines');
    assertDistinctPathPair(prod.engine.engineRoot, dev.engine.engineRoot);
  });

  it('routes expansion helpers to the flavor-specific install directories', () => {
    const baseDir = '/tmp/coral-flavor-coexistence';
    const prodEq = enginePaths('prod', { baseDir });
    const devEq = enginePaths('dev', { baseDir });

    expect(prodEq.dataDir('vector')).toBe(join(baseDir, 'data', 'engines', 'vector'));
    expect(devEq.dataDir('vector')).toBe(join(baseDir, 'data-dev', 'engines', 'vector'));
    expect(prodEq.installLockPath('vector')).toBe(join(baseDir, 'data', 'engines', '.locks', 'vector.lock'));
    expect(devEq.installLockPath('vector')).toBe(join(baseDir, 'data-dev', 'engines', '.locks', 'vector.lock'));
  });
});
