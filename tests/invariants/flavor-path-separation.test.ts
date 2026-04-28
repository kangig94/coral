import { describe, it, expect } from 'vitest';
import { resolveBuildFlavor } from '#src/infra/build-flavor.js';
import { composeCoralPaths } from '#src/infra/path/compose.js';
import { kbRuntimeDir } from '#src/kb/paths.js';

const FAMILIES = ['store', 'corpus', 'coordinator', 'exports', 'engine'] as const;

function allLeafPaths(record: Record<string, unknown>, prefix = ''): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(record)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push({ key, value: v });
    else if (v && typeof v === 'object') out.push(...allLeafPaths(v as Record<string, unknown>, key));
  }
  return out;
}

describe('flavor path separation', () => {
  const prodFlavor = resolveBuildFlavor({});
  const devFlavor = resolveBuildFlavor({ CORAL_FLAVOR: 'dev' });
  const prod = composeCoralPaths(prodFlavor);
  const dev = composeCoralPaths(devFlavor);

  it('flavor-bound path bundle exposes exactly the declared families', () => {
    expect(Object.keys(prod).sort()).toEqual([...FAMILIES].sort());
    expect(Object.keys(dev).sort()).toEqual([...FAMILIES].sort());
  });

  it.each(FAMILIES)('%s family has distinct prod vs dev paths', (family) => {
    const prodLeaves = allLeafPaths(prod[family] as unknown as Record<string, unknown>);
    const devLeaves = allLeafPaths(dev[family] as unknown as Record<string, unknown>);
    expect(prodLeaves.length).toBeGreaterThan(0);
    expect(devLeaves.length).toBe(prodLeaves.length);
    const prodMap = new Map(prodLeaves.map((l) => [l.key, l.value]));
    const devMap = new Map(devLeaves.map((l) => [l.key, l.value]));
    for (const key of prodMap.keys()) {
      const prodVal = prodMap.get(key)!;
      const devVal = devMap.get(key)!;
      expect(devVal).not.toBe(prodVal);
      // Neither is a prefix of the other
      expect(devVal.startsWith(prodVal + '/')).toBe(false);
      expect(prodVal.startsWith(devVal + '/')).toBe(false);
    }
  });

  it('expected segment tokens appear in dev paths', () => {
    expect(dev.store.dbDir).toContain('data-dev/store');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev/jobs');
    expect(dev.engine.engineRoot).toContain('data-dev/engines');
    expect(kbRuntimeDir(devFlavor)).toContain('data-dev/kb');
    expect(kbRuntimeDir(devFlavor)).not.toContain('data/kb-dev');
    expect(kbRuntimeDir(prodFlavor)).toContain('data/kb');
  });
});
