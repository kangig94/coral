import { describe, expect, it } from 'vitest';

import {
  reduceHostServiceability,
  type HostServiceability,
  type HostServiceabilityState,
} from '#src/providers/host-serviceability.js';

function startInstance(instanceId: string): HostServiceabilityState {
  const state = reduceHostServiceability(undefined, { kind: 'instance-started', instanceId });
  if (state === undefined) throw new Error('Expected an instance-started input to create serviceability state.');
  return state;
}

function applyFinding(state: HostServiceabilityState, serviceability: HostServiceability): HostServiceabilityState {
  const next = reduceHostServiceability(state, {
    kind: 'finding',
    instanceId: state.instanceId,
    serviceability,
  });
  if (next === undefined) throw new Error('Expected a same-instance finding to preserve serviceability state.');
  return next;
}

describe('provider host serviceability reducer', () => {
  it('starts a concrete host instance at unknown and preserves knowledge across unknown findings', () => {
    const initial = startInstance('host-a');
    expect(initial).toEqual({ instanceId: 'host-a', serviceability: 'unknown' });

    const serviceable = applyFinding(initial, 'serviceable');
    expect(serviceable).toEqual({ instanceId: 'host-a', serviceability: 'serviceable' });
    expect(applyFinding(serviceable, 'unknown')).toBe(serviceable);
  });

  it('keeps unserviceable terminal for the same concrete host instance id', () => {
    const unserviceable = applyFinding(applyFinding(startInstance('host-a'), 'serviceable'), 'unserviceable');

    expect(
      applyFinding(unserviceable, 'serviceable'),
      'unserviceable must be terminal for the same concrete host instance id',
    ).toBe(unserviceable);
    expect(applyFinding(unserviceable, 'unknown')).toBe(unserviceable);
  });

  it('begins again at unknown only when the concrete host instance id changes', () => {
    const unserviceable = applyFinding(startInstance('host-a'), 'unserviceable');

    expect(reduceHostServiceability(unserviceable, { kind: 'instance-started', instanceId: 'host-a' })).toBe(
      unserviceable,
    );
    expect(reduceHostServiceability(unserviceable, { kind: 'instance-started', instanceId: 'host-b' })).toEqual({
      instanceId: 'host-b',
      serviceability: 'unknown',
    });
  });
});
