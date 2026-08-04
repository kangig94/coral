import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderHandoffNotice } from '#src/cli/handoff-notice.js';
import type { HandoffSuccess } from '#src/coordinator/handoff-runner.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handoff-notice', () => {
  // One case, because the once-per-process latch is module state: a second case in this file would find the
  // notice already rendered and assert nothing. Both properties are asserted against the same single render.
  it('should render the exact notice once, on stderr, leaving stdout untouched', () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    const stdoutWrite = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as typeof process.stdout.write);
    const success = { kind: 'handoff-success', version: '2.3.4' } as HandoffSuccess;

    renderHandoffNotice(success);
    renderHandoffNotice(success);

    expectTypeOf(renderHandoffNotice).parameter(0).toEqualTypeOf<HandoffSuccess>();
    expect(stderr).toBe('handed off to 2.3.4; use that version from now on\n');
    expect(process.stderr.write).toHaveBeenCalledOnce();
    // Stdout carries the delegated child's real answer; a notice appended there would break `-f json`.
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
