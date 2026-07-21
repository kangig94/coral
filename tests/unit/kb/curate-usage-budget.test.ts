import { describe, expect, it } from 'vitest';

import { isUsageBudgetExhausted } from '#src/kb/curate/usage-budget.js';

describe('curate usage budget runtime isolation', () => {
  const usageBudgetExhausted = (data: { fiveHour?: number; weekly?: number }): boolean =>
    isUsageBudgetExhausted({
      claudeConfigDir: '/isolated-home/.claude',
      now: () => 1_000,
      storage: {
        readFileSync() {
          return JSON.stringify({
            claude: {
              ts: 900,
              data,
            },
          });
        },
      },
    });

  it('reads the usage cache from the injected home only', () => {
    let observedPath = '';

    const exhausted = isUsageBudgetExhausted({
      claudeConfigDir: '/isolated-home/.claude',
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

  it('allows curate below the five-hour and weekly guardrails', () => {
    expect(usageBudgetExhausted({ fiveHour: 49, weekly: 69 })).toBe(false);
  });

  it('blocks curate at the five-hour guardrail', () => {
    expect(usageBudgetExhausted({ fiveHour: 50, weekly: 10 })).toBe(true);
  });

  it('blocks curate at the weekly guardrail', () => {
    expect(usageBudgetExhausted({ fiveHour: 10, weekly: 70 })).toBe(true);
  });
});
