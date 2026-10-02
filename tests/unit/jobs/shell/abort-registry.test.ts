import { describe, expect, it } from 'vitest';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('prod');

describe('jobs AbortRegistry', () => {
  it('releases the captured permit from the settled callback, not from the abort handler', () => {
    const registry = new AbortRegistry(runtime.ids);
    const admission = new LaunchCoordinator({ runtime });
    let signalledStop = false;
    const signalStopWithoutWaiting = (): void => {
      signalledStop = true;
    };
    const launched = admission.requestLaunch(
      'stuck-carrier',
      'codex',
      { kind: 'provider-session', id: 'stuck-session' },
      'default',
    );
    if (launched === 'queue_full' || launched.type !== 'immediate') throw new Error('expected exact permit');
    registry.register(launched.permit.jobId, signalStopWithoutWaiting, () => admission.releaseLaunch(launched.permit));

    expect(registry.abort([launched.permit.jobId])).toEqual({ aborted: [launched.permit.jobId], notFound: [] });
    expect(signalledStop).toBe(true);
    expect(admission.reservationFor(launched.permit.jobId)).toBeNull();
    expect(admission.active).toBe(0);
  });
});
