import { expect, it, vi } from 'vitest';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import type { DurableCliProcessSubject } from '#src/runtime/ports.js';
import { CONTAINMENT_DISAPPEARANCE_CONFIRM_MS } from '#src/infra/process-constants.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

it.each(
  (['populated', 'missing', 'unknown'] as const).flatMap((transition) =>
    (['during confirmation', 'after the last observation'] as const).map((interleaving) => ({
      transition,
      interleaving,
    })),
  ),
)(
  'keeps live durable settlement held when its job leaf becomes $transition $interleaving',
  async ({ transition, interleaving }) => {
    const runtime = new SimulationRuntime();
    runtime.spawner.enqueueDurable({ exit: { delayMs: 1, exitCode: 0 } });
    let observation: FailureDomainObservation = { kind: 'absent' };
    let changeAfterObservation = false;
    const changed: FailureDomainObservation =
      transition === 'unknown' ? { kind: 'unknown', reason: 'EACCES' } : { kind: transition };
    const observe = vi.fn(() => {
      if (changeAfterObservation && observation.kind === 'absent') {
        queueMicrotask(() => {
          observation = changed;
        });
      }
      return observation;
    });
    const lookup = vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
      observe,
      kill: () => ({ kind: 'refused', errno: 'EACCES' }),
    });
    const coordinator = new LaunchCoordinator({ runtime });
    coordinator.bindActiveEpochPath('/store/epoch-1');
    let completed = false;
    const identities: DurableCliProcessSubject[] = [];
    const result = coordinator.spawnDurableJob({
      provider: 'codex',
      command: 'fixture',
      args: [],
      jobDir: '/jobs/leaf-settlement',
      failureDomainName: 'job-test-1',
      onDurableProcessIdentity: (identity) => {
        if (!('kind' in identity)) identities.push(identity);
        return { kind: 'published' };
      },
    });
    void result.then(() => {
      completed = true;
    });
    await flushMicrotasks(64);
    runtime.time.tick(500);
    await flushMicrotasks(64);
    expect(observe).toHaveBeenCalled();
    const subject = identities.at(-1);
    if (subject === undefined || subject.childRoot === null)
      throw new Error('Expected the ready durable process identity');
    expect(runtime.process.observeLiveness(subject.pid)).toBe('absent');
    expect(runtime.process.observeLiveness(subject.childRoot.pid)).toBe('absent');
    expect(runtime.process.observeLiveness(-subject.processGroupId)).toBe('absent');

    if (interleaving === 'during confirmation') observation = changed;
    else changeAfterObservation = true;
    runtime.time.tick(CONTAINMENT_DISAPPEARANCE_CONFIRM_MS);
    await flushMicrotasks(64);
    expect(completed).toBe(false);
    expect(lookup).toHaveBeenCalledWith('job-test-1');
    expect(observe.mock.results.some((result) => result.type === 'return' && result.value.kind === transition)).toBe(
      true,
    );

    changeAfterObservation = false;
    observation = { kind: 'absent' };
    for (let step = 0; step < 10 && !completed; step += 1) {
      runtime.time.tick(500);
      await flushMicrotasks(64);
    }
    expect(completed).toBe(true);
    await expect(result).resolves.toMatchObject({ code: 0 });
  },
);
