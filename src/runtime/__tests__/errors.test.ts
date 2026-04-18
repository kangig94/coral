import { describe, it, expect } from 'vitest';
import { CoralSetupError } from '../errors.js';

describe('CoralSetupError', () => {
  it('should construct with all fields', () => {
    const err = new CoralSetupError({
      code: 'E_TEST',
      userMessage: 'user-facing message',
      remediation: 'do this',
      context: { foo: 'bar' },
    });
    expect(err.code).toBe('E_TEST');
    expect(err.userMessage).toBe('user-facing message');
    expect(err.remediation).toBe('do this');
    expect(err.context).toEqual({ foo: 'bar' });
  });

  it('should set .name to "CoralSetupError"', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err.name).toBe('CoralSetupError');
  });

  it('should satisfy instanceof CoralSetupError and Error', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err instanceof CoralSetupError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('should accept undefined context', () => {
    const err = new CoralSetupError({ code: 'E', userMessage: 'u', remediation: 'r' });
    expect(err.context).toBeUndefined();
  });
});
