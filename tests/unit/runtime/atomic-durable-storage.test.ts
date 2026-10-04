import { expect, it, vi } from 'vitest';
import { InMemoryStorage } from '#tools/simulation/core/memory-storage.js';

it('the simulation publisher preserves exclusive stage ownership during a nested publication', () => {
  let now = 0;
  const storage = new InMemoryStorage({ now: () => now });
  const target = '/publication/job.json';
  const open = vi.spyOn(storage, 'openSync');
  const rename = storage.renameSync.bind(storage);
  let heldStage = '';
  vi.spyOn(storage, 'renameSync').mockImplementation((stage, path) => {
    if (!heldStage) {
      heldStage = String(stage);
      now += 25 * 3_600_000;
      expect(storage.writeAtomicDurableSync(target, 'second')).toBe(true);
      expect(storage.existsSync(heldStage)).toBe(true);
    }
    rename(stage, path);
  });
  expect(storage.writeAtomicDurableSync(target, 'first')).toBe(true);
  expect(storage.readFileSync(target, 'utf-8')).toBe('first');
  expect(storage.readdirSync('/publication')).toEqual(['job.json']);
  expect(open.mock.calls).toHaveLength(2);
  expect(open.mock.calls[0][0]).not.toBe(open.mock.calls[1][0]);
  for (const [stage, flags] of open.mock.calls) {
    expect(flags).toBe('wx');
    expect(stage).not.toMatch(/\.json$/);
  }
});
