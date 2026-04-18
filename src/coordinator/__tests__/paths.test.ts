import { describe, it, expect } from 'vitest';
import { composeCoralPaths } from '../paths.js';

describe('composeCoralPaths', () => {
  it('returns a frozen record covering all five path families', () => {
    const p = composeCoralPaths('prod');
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['coordinator', 'corpus', 'equipment', 'exports', 'store']);
    expect(p.store.dbFile).toContain('.coral/data/store/store.db');
    expect(p.corpus.kbRoot).toContain('.coral/kb');
    expect(p.coordinator.socketPath).toBeTruthy();
    expect(p.exports.jobsRoot).toContain('.coral/exports/jobs');
    expect(p.equipment.equipmentRoot).toContain('.coral/data/equipment');
  });

  it('dev flavor has distinct segments from prod', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');
    expect(dev.store.dbDir).not.toBe(prod.store.dbDir);
    expect(dev.store.dbDir).toContain('data-dev');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev');
    expect(dev.equipment.equipmentRoot).toContain('data-dev/equipment');
  });

  it('throws when attempting to mutate the frozen record', () => {
    const p = composeCoralPaths('prod');
    expect(() => {
      // @ts-expect-error — mutation is what we are asserting fails
      p.store = {} as never;
    }).toThrow();
  });
});
