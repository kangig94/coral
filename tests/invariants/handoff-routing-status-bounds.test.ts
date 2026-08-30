import { describe, expect, it } from 'vitest';

import {
  HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION,
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  handoffRoutingStatusStoreSchema,
} from '#src/coordinator/handoff-routing/status.js';
import {
  HANDOFF_ROUTING_STATUS_GENERATION_BAND,
  handoffRoutingStatusFingerprint,
  handoffRoutingStatusGeneration,
} from '#src/store/handoff-routing-status-store.js';

describe('handoff routing status bounds', () => {
  it('keeps handwritten DDL bounds fitted to the widest legal records', () => {
    const { minimum, maximum, decimalWidth } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
    expect(String(minimum).length).toBe(decimalWidth);
    expect(String(maximum).length).toBe(decimalWidth);
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

  it('should pin the full durable fingerprint independently from its generation projection', () => {
    const schema = handoffRoutingStatusStoreSchema();
    const fingerprint = handoffRoutingStatusFingerprint(schema);
    const generation = handoffRoutingStatusGeneration(schema);
    const { minimum, maximum } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;

    expect(fingerprint.toString('hex')).toBe('0a00377bda1e0d4fd969f33d636d8c3b9ae6c4d298e4ebee589d5ce5c94dda60');
    expect(fingerprint.length).toBe(32);
    expect(generation).toBe(1167786363);
    expect(generation).toBe((fingerprint.readUInt32BE(0) % (maximum - minimum + 1)) + minimum);
    expect(HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION).toBe(0);
    expect(
      HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION < minimum || HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION > maximum,
    ).toBe(true);
  });
});
