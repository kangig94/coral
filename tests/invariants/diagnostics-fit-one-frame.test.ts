import { describe, expect, it } from 'vitest';

import {
  PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET,
  PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_FACT_BUDGET,
} from '#src/providers/host-admission.js';
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
   * An inventory response carries every owner's live hosts alongside the retained tombstones, so the sum is
   * what actually has to fit — not either budget alone. The live path has no total of its own today; this
   * states the exposure in the one place that would notice it growing, and names the host count the current
   * numbers survive.
   */
  it('survives a plausible fleet of live hosts alongside the retained tombstones', () => {
    const PLAUSIBLE_LIVE_HOSTS = 4;
    const worstCaseResponseBytes =
      PLAUSIBLE_LIVE_HOSTS * PROVIDER_HOST_LOG_MAX_BYTES + PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_BYTE_BUDGET;
    expect(worstCaseResponseBytes).toBeLessThan(MAX_FRAME_BYTES);
  });

  it('bounds retained facts as well as bytes, so neither alone can fill a frame', () => {
    expect(PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_FACT_BUDGET).toBeGreaterThan(0);
    expect(Number.isSafeInteger(PROVIDER_HOST_TOMBSTONE_DIAGNOSTIC_FACT_BUDGET)).toBe(true);
  });
});
