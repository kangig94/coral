import { describe, expect, it } from 'vitest';

import { isUsageBudgetExhausted } from '#src/kb/curate/usage-budget.js';

describe('curate usage budget runtime isolation', () => {
  it('reads the usage cache from the injected home only', () => {
    let observedPath = '';

    const exhausted = isUsageBudgetExhausted({
      homeDir: '/isolated-home',
      now: () => 1_000,
      storage: {
        readFileSync(path) {
          observedPath = path;
          return JSON.stringify({
            claude: {
              ts: 900,
              data: { fiveHour: 91, weekly: 10 },
            },
          });
        },
      },
    });

    expect(exhausted).toBe(true);
    expect(observedPath).toBe('/isolated-home/.claude/hud/.coral-cache.json');
  });

  it('does not read ambient home when no home is injected', () => {
    const exhausted = isUsageBudgetExhausted({
      now: () => 1_000,
      storage: {
        readFileSync() {
          throw new Error('storage should not be read without an injected home');
        },
      },
    });

    expect(exhausted).toBe(false);
  });
});
