import { describe, expect, it } from 'vitest';

import { classifyExecOutcome, type ExecResult } from '#src/infra/port-types.js';

describe('classifyExecOutcome', () => {
  it('reads a non-zero exit as an answer', () => {
    const result: ExecResult = { stdout: '', stderr: 'outside a work tree', status: 128 };

    expect(classifyExecOutcome(result)).toEqual({ kind: 'answered', status: 128 });
  });

  it('reads a missing binary as a standing refusal', () => {
    const result: ExecResult = {
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('missing executable'), { code: 'ENOENT' }),
    };

    expect(classifyExecOutcome(result)).toEqual({ kind: 'launch-refused', code: 'ENOENT' });
  });

  it('reads a timeout as no answer', () => {
    const result: ExecResult = {
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' }),
    };

    expect(classifyExecOutcome(result)).toEqual({ kind: 'no-answer', detail: 'ETIMEDOUT' });
  });

  it('reads a child killed from outside as no answer despite partial output', () => {
    const result: ExecResult = { stdout: 'fixt', stderr: '', status: null };

    expect(classifyExecOutcome(result)).toEqual({ kind: 'no-answer', detail: 'killed before it exited' });
  });
});
