export type HostProcessState = 'open' | 'closed';
export type HostServiceability = 'serviceable' | 'unserviceable' | 'unknown';
export type HostAdmission = 'candidate' | 'blocked';

export type HostServiceabilityState = Readonly<{
  instanceId: string;
  serviceability: HostServiceability;
}>;

export type HostServiceabilityInput =
  | Readonly<{
      kind: 'instance-started';
      instanceId: string;
    }>
  | Readonly<{
      kind: 'finding';
      instanceId: string;
      serviceability: HostServiceability;
    }>;

export function reduceHostServiceability(
  state: HostServiceabilityState | undefined,
  input: HostServiceabilityInput,
): HostServiceabilityState | undefined {
  if (input.kind === 'instance-started') {
    if (state?.instanceId === input.instanceId) return state;
    return Object.freeze({ instanceId: input.instanceId, serviceability: 'unknown' });
  }

  if (state === undefined || state.instanceId !== input.instanceId) return state;
  if (state.serviceability === 'unserviceable' || input.serviceability === 'unknown') return state;
  if (state.serviceability === input.serviceability) return state;

  return Object.freeze({ instanceId: state.instanceId, serviceability: input.serviceability });
}
