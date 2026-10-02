import { describe, expect, it } from 'vitest';

import { KB_DAEMON_EXIT_DIAGNOSTIC_MAX_CHARS } from '#src/coordinator/live/kb-daemon-supervisor/index.js';
import { PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET } from '#src/providers/host-admission.js';
import { PROVIDER_HOST_LOG_MAX_BYTES } from '#src/providers/host-diagnostics.js';
import { MAX_FRAME_BYTES } from '#src/transport/line-framing.js';

/**
 * Provider-host diagnostics are retained by one budget and delivered under another. The transport frame cap
 * exists to stop an unterminated write from exhausting coordinator memory, not to bound legitimate payloads —
 * so a payload that fills its own retention budget must still fit inside a frame, with room for the JSON
 * envelope carrying it.
 *
 * Those two numbers were once both ten mebibytes, set independently in files that never referenced each
 * other. A host that filled its log then produced a frame that overflowed by about the size of its own
 * envelope, and the operator surface failed with `frame_too_large` on a payload nothing was wrong with.
 *
 * Equality is the specific defect, so the assertions below demand a margin rather than an ordering: a budget
 * that merely fits is a budget that breaks the first time a field is added to the record around it.
 */
describe('provider-host diagnostics fit one IPC frame', () => {
  const ENVELOPE_HEADROOM_RATIO = 0.5;

  it('keeps a single host log well under the transport frame cap', () => {
    expect(PROVIDER_HOST_LOG_MAX_BYTES).toBeLessThan(MAX_FRAME_BYTES * ENVELOPE_HEADROOM_RATIO);
  });

  it('keeps the retained tombstone budget well under the transport frame cap', () => {
    expect(PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET).toBeLessThan(MAX_FRAME_BYTES * ENVELOPE_HEADROOM_RATIO);
  });

  /**
   * The provider host log was not the only place this equality lived. A dead KB daemon's whole retained
   * stderr — capped at `MAX_BUFFER`, which is also ten mebibytes — became its `lastError`, so the health
   * response overflowed a frame by exactly its own envelope and every operator command that reads daemon
   * health failed at the moment the diagnostic mattered. Budgeted in characters rather than bytes, so the
   * headroom has to absorb multi-byte output too.
   */
  it('keeps a dead daemon’s exit diagnostic well under the transport frame cap', () => {
    const WORST_CASE_UTF8_BYTES_PER_CHAR = 4;
    expect(KB_DAEMON_EXIT_DIAGNOSTIC_MAX_CHARS * WORST_CASE_UTF8_BYTES_PER_CHAR).toBeLessThan(
      MAX_FRAME_BYTES * ENVELOPE_HEADROOM_RATIO,
    );
  });
});
