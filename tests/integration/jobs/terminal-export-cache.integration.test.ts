import { expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminalExportFixture, TERMINAL_EXPORT_NOW } from '#tests/helpers/terminal-export.js';

it('reuses validated legacy terminal evidence across request sessions regardless of body size', () => {
  for (const size of [1_000, 1_000_000, 8_000_000]) {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete({
        terminalAt: TERMINAL_EXPORT_NOW - 20 * 86_400_000,
        terminal: { content: 'x'.repeat(size), outcome: { kind: 'completed' }, durationMs: 1 },
      });
      const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
      delete stored.terminalAge;
      writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
      rmSync(dirname(f.resultPath), { recursive: true, force: true });
      const owner = f.store.getResultExportOwner();
      owner.observeResultAvailability(f.jobId, {}); // warm location cache
      let parsedBytes = 0;
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        parsedBytes += text.length;
        return parse(text, reviver);
      });
      try {
        expect(owner.observeResultAvailability(f.jobId, {}).kind).toBe('retained-away');
        expect(parsedBytes).toBeLessThan(4096);
      } finally {
        spy.mockRestore();
      }
    } finally {
      f.close();
    }
  }
});
