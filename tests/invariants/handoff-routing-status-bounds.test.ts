import { describe, expect, it } from 'vitest';

import {
  HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION,
  MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES,
  MAX_HANDOFF_ROUTING_STATUS_BYTES,
  MAX_LEGAL_CLOSING_RECORD_BYTES,
  MAX_LEGAL_DIRECT_HANDOFF_ROUTING_TERMINAL_BYTES,
  MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES,
  MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
  MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES,
  handoffRoutingStatusStoreSchema,
} from '#src/coordinator/handoff-routing/status.js';
import { MAX_PROCESS_INCARNATION_LENGTH } from '#src/infra/node-process.js';
import {
  HANDOFF_ROUTING_STATUS_GENERATION_BAND,
  handoffRoutingStatusFingerprint,
  handoffRoutingStatusGeneration,
} from '#src/store/handoff-routing-status-store/index.js';

describe('handoff routing status bounds', () => {
  it('pins the operational store byte ceiling', () => {
    expect(MAX_HANDOFF_ROUTING_STATUS_BYTES).toBe(1_048_576);
  });

  it('derives the maximum-body incarnation from its canonical bound', () => {
    expect(MAX_LEGAL_ROUTING_SELECTED_TRANSITION.owner.incarnation).toHaveLength(MAX_PROCESS_INCARNATION_LENGTH);
  });

  it('keeps handwritten DDL bounds fitted to the widest legal records', () => {
    const { minimum, maximum, decimalWidth } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;
    expect(String(minimum).length).toBe(decimalWidth);
    expect(String(maximum).length).toBe(decimalWidth);
    const generation = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
    expect(generation).toBeGreaterThanOrEqual(minimum);
    expect(generation).toBeLessThanOrEqual(maximum);
    expect(MAX_LEGAL_HANDOFF_ROUTING_EVENT_BYTES).toEqual(MAX_ENCODED_HANDOFF_ROUTING_EVENT_BYTES);
    expect(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES).toBe(MAX_ENCODED_RETIREMENT_TOMBSTONE_BYTES);
    expect(MAX_LEGAL_CLOSING_RECORD_BYTES).toBeGreaterThanOrEqual(
      Math.max(MAX_LEGAL_RETIREMENT_TOMBSTONE_BYTES, MAX_LEGAL_DIRECT_HANDOFF_ROUTING_TERMINAL_BYTES),
    );
  });

  it('should pin the full durable fingerprint independently from its generation projection', () => {
    const schema = handoffRoutingStatusStoreSchema();
    const fingerprint = handoffRoutingStatusFingerprint(schema);
    const generation = handoffRoutingStatusGeneration(schema);
    const { minimum, maximum } = HANDOFF_ROUTING_STATUS_GENERATION_BAND;

    expect(fingerprint.toString('hex')).toBe('2b1df7466714d0a345c0e242c5e4b9f0913ee44b069c2683b1b4f8529d9a55d9');
    expect(fingerprint.length).toBe(32);
    expect(generation).toBe(1723384134);
    expect(generation).toBe((fingerprint.readUInt32BE(0) % (maximum - minimum + 1)) + minimum);
    expect(HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION).toBe(0);
    expect(
      HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION < minimum || HANDOFF_ROUTING_STATUS_SENTINEL_GENERATION > maximum,
    ).toBe(true);
  });
});
