import { describe, expect, it } from 'vitest';

import {
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  handoffRoutingStatusStoreSchema,
} from '#src/coordinator/handoff-routing/status.js';
import {
  HANDOFF_ROUTING_STATUS_GENERATION_BAND,
  handoffRoutingStatusGeneration,
} from '#src/store/handoff-routing-status-store.js';

describe('handoff routing status bounds', () => {
  it('keeps handwritten DDL bounds fitted to the widest legal records', () => {
    const { minimum, maximum, decimalWidth } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
    expect([minimum, maximum].map((generation) => String(generation).length)).toEqual([decimalWidth, decimalWidth]);
    const generation = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
    expect(generation).toBeGreaterThanOrEqual(minimum);
    expect(generation).toBeLessThanOrEqual(maximum);
    expect(MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES).toEqual(MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBe(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_LEGAL_CLOSING_RECORD_BYTES).toBe(
      Math.max(
        MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
        MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES['execution-failed'],
        MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES['continuation-finalized'],
      ),
    );
  });
});
