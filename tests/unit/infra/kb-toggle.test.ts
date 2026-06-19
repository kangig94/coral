import { describe, expect, it } from 'vitest';
import { CORAL_KB_ENABLE_ENV, KB_DISABLED_REASON, resolveKbEnabled } from '#src/infra/kb-toggle.js';

describe('resolveKbEnabled', () => {
  it('disables only on the explicit "0"', () => {
    expect(resolveKbEnabled('0')).toBe(false);
  });

  it('enables on "1"', () => {
    expect(resolveKbEnabled('1')).toBe(true);
  });

  it('enables when unset', () => {
    expect(resolveKbEnabled(undefined)).toBe(true);
  });

  it('fails open to enabled on a malformed value', () => {
    expect(resolveKbEnabled('true')).toBe(true);
    expect(resolveKbEnabled('')).toBe(true);
    expect(resolveKbEnabled('00')).toBe(true);
  });

  it('exposes stable env-key and disabled-reason constants', () => {
    expect(CORAL_KB_ENABLE_ENV).toBe('CORAL_KB_ENABLE');
    // Exact value: the CLI reconcile does `s.reason === KB_DISABLED_REASON`, so
    // any wording change must move in lockstep with that identity comparison.
    expect(KB_DISABLED_REASON).toBe('disabled (CORAL_KB_ENABLE=0)');
  });
});
