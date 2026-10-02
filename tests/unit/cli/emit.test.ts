import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitError } from '#src/cli/emit.js';
import { StoreResetCliError } from '#src/cli/errors.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('store-reset error emission', () => {
  it('writes only the fixed envelope to stderr and leaves stdout empty', () => {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);

    emitError(new StoreResetCliError('store_reset_reporting_failed'));

    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Store-reset reporting failed. [code=store_reset_reporting_failed]\n' +
        'remediation: Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.\n',
    );
    expect(process.exitCode).toBe(70);
  });
});
