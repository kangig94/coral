import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const EXEC_PATTERNS = ['appendOutput', 'scheduleKill', 'finish', 'clearTimers'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('exec factory no-duplication invariant (AC11a)', () => {
  it.each(EXEC_PATTERNS)('pattern "%s" appears only in src/runtime/exec-builder.ts', (pattern) => {
    const builder = readFileSync(join(ROOT, 'src/runtime/exec-builder.ts'), 'utf-8');
    const real = readFileSync(join(ROOT, 'src/runtime/real.ts'), 'utf-8');
    const simulation = readFileSync(join(ROOT, 'tools/simulation/runtime.ts'), 'utf-8');

    expect(builder.includes(pattern)).toBe(true);
    const realDefines = new RegExp(`function\\s+${pattern}|const\\s+${pattern}\\s*=`).test(real);
    const simDefines = new RegExp(`function\\s+${pattern}|const\\s+${pattern}\\s*=`).test(simulation);
    expect(realDefines).toBe(false);
    expect(simDefines).toBe(false);
  });
});
