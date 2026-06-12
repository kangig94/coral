import { describe, expect, it } from 'vitest';

import { sessionAdapterUnparseableFaultSchema } from '#src/sessions/fault.js';

describe('session fault schemas', () => {
  it('rejects non-finite adapter exit codes while preserving nullable exits', () => {
    const base = {
      provider: 'claude',
      stdout: 'stdout',
      stderr: 'stderr',
      parseError: 'invalid json',
    };

    expect(sessionAdapterUnparseableFaultSchema.safeParse({ ...base, exitCode: 1 }).success).toBe(true);
    expect(sessionAdapterUnparseableFaultSchema.safeParse({ ...base, exitCode: null }).success).toBe(true);
    expect(sessionAdapterUnparseableFaultSchema.safeParse({ ...base, exitCode: Infinity }).success).toBe(false);
    expect(sessionAdapterUnparseableFaultSchema.safeParse({ ...base, exitCode: Number.NaN }).success).toBe(false);
  });
});
