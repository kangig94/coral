import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const EXEC_PATTERNS = ['appendOutput', 'scheduleKill', 'finish', 'clearTimers'];

describe('exec factory no-duplication invariant (AC11a)', () => {
  it.each(EXEC_PATTERNS)('pattern "%s" appears only in src/runtime/exec-builder.ts', (pattern) => {
    const builder = readFileSync('src/runtime/exec-builder.ts', 'utf-8');
    const real = readFileSync('src/runtime/real.ts', 'utf-8');
    const simulation = readFileSync('src/simulation/runtime.ts', 'utf-8');

    expect(builder.includes(pattern)).toBe(true);
    const realDefines = new RegExp(`function\\s+${pattern}|const\\s+${pattern}\\s*=`).test(real);
    const simDefines = new RegExp(`function\\s+${pattern}|const\\s+${pattern}\\s*=`).test(simulation);
    expect(realDefines).toBe(false);
    expect(simDefines).toBe(false);
  });
});
