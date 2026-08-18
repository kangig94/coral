// The rule three modules now delegate to, driven by real subprocesses through the real port.
//
// It exists because the same derivation was written four times against the same four `ExecResult` fields, in
// modules that do not own them, and the copies disagreed — one read a codeless error as "the command answered"
// and cached a KB out of version control for the daemon's lifetime. Consolidating it removed the disagreement
// and created a new risk in its place: a single wrong classification is now wrong everywhere at once.
//
// So this file asks the operating system rather than a fixture. Every hand-built `ExecResult` elsewhere in the
// suite is only trustworthy while these four rows keep matching what Node actually produces.

import { describe, expect, it } from 'vitest';

import { classifyExecOutcome } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('prod');

describe('classifyExecOutcome', () => {
  it('reads a clean exit as an answer', () => {
    expect(classifyExecOutcome(runtime.process.execSync('true', []))).toEqual({ kind: 'answered', status: 0 });
  });

  it('reads a non-zero exit as an answer, not as a failure to obtain one', () => {
    // `git rev-parse --is-inside-work-tree` outside a work tree is the canonical case: the command ran and
    // said no. Every site that treats this as "could not check" re-opens the defect this type closed.
    const outcome = classifyExecOutcome(
      runtime.process.execSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: '/tmp' }),
    );

    expect(outcome.kind).toBe('answered');
    expect(outcome.kind === 'answered' && outcome.status).not.toBe(0);
  });

  it('reads a missing binary as a standing refusal, so callers may cache it', () => {
    expect(classifyExecOutcome(runtime.process.execSync('definitely-not-a-binary-xyz', []))).toEqual({
      kind: 'launch-refused',
      code: 'ENOENT',
    });
  });

  it('reads a real timeout as no answer at all', () => {
    // The port replaces `spawnSync`'s error with one of its own here; this is the assertion that the
    // replacement still carries a code, which is the only thing separating a timeout from an exit.
    expect(classifyExecOutcome(runtime.process.execSync('sleep', ['5'], { timeout: 250 }))).toEqual({
      kind: 'no-answer',
      detail: 'ETIMEDOUT',
    });
  });

  // Not reproducible through the port without a second process racing a kill, so the shape is asserted
  // directly — measured, not imagined: `spawn`'s `close` gives `(null, 'SIGKILL')` for a child killed from
  // outside, and `exec-builder` maps that to `status: null` with no error, because it only synthesises an
  // error for *its own* timeout. That is the one case where output exists and means nothing, and reading it
  // as success is how a killed `--version` probe mints a version out of a truncated line.
  it('reads a child killed from outside as no answer, though it left output behind', () => {
    const outcome = classifyExecOutcome({ stdout: 'fixt', stderr: '', status: null });

    expect(outcome).toEqual({ kind: 'no-answer', detail: 'killed before it exited' });
  });

  it.each([
    ['an errno nobody enumerated', { code: 'EWOULDBLOCKX' }],
    ['no recognisable code at all', {}],
  ])('reads a launch failure with %s as no answer, not as a standing fact', (_label, props) => {
    // The default direction, and a choice rather than a consequence: a wrong `no-answer` costs a repeated
    // command, a wrong `answered` is a durable claim nobody made.
    const outcome = classifyExecOutcome({
      stdout: '',
      stderr: '',
      status: null,
      error: Object.assign(new Error('boom'), props),
    });

    expect(outcome.kind).toBe('no-answer');
  });
});
