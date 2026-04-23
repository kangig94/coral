/**
 * Two-backend isolation test (architect recommendation R1).
 * Verifies that shutting down one backend does not affect the other's
 * children, discuss sessions, event delivery, or provider registry.
 */
import { describe, expect, it } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createDiscussContextRegistry } from '#src/discuss/shell/live-registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { registerBuiltInProviders } from '#src/providers/bootstrap.js';
import { streamProviderTerminal } from '#src/providers/stream.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { toProviderSpec } from '#tests/helpers/scripted-provider.js';
import type { JobTerminal } from '#src/jobs/records.js';

const terminalResult: JobTerminal = { content: '', durationMs: 100, exitCode: 0, outcome: { kind: 'completed' } };

describe('backend isolation', () => {
  it('two coordinators track children independently', () => {
    const coordA = new LaunchCoordinator({ runtime: createRealRuntime() });
    const coordB = new LaunchCoordinator({ runtime: createRealRuntime() });

    const admitA = coordA.requestLaunch('job-a1', 'codex');
    const admitB = coordB.requestLaunch('job-b1', 'codex');
    expect(admitA).toMatchObject({ outcome: 'admitted', type: 'immediate' });
    expect(admitB).toMatchObject({ outcome: 'admitted', type: 'immediate' });

    // Coordinator A sees only its own active job
    expect(coordA.getActiveJobIds()).toEqual(['job-a1']);
    expect(coordB.getActiveJobIds()).toEqual(['job-b1']);

    // Kill all children on A — B's state is unaffected
    coordA.terminateAll();
    coordA.releaseLaunch('job-a1');
    expect(coordA.getActiveJobIds()).toEqual([]);
    expect(coordB.getActiveJobIds()).toEqual(['job-b1']);
  });

  it('two event buses deliver events independently', () => {
    const busA = new TypedEventBus();
    const busB = new TypedEventBus();

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    busA.on('job:completed', (e) => eventsA.push(e.jobId));
    busB.on('job:completed', (e) => eventsB.push(e.jobId));

    busA.emit('job:completed', { jobId: 'a1', result: terminalResult });
    busB.emit('job:completed', { jobId: 'b1', result: terminalResult });

    expect(eventsA).toEqual(['a1']);
    expect(eventsB).toEqual(['b1']);

    // Shutdown bus A — bus B still delivers
    busA.removeAllListeners();
    busA.emit('job:completed', { jobId: 'a2', result: terminalResult });
    busB.emit('job:completed', { jobId: 'b2', result: terminalResult });

    expect(eventsA).toEqual(['a1']); // no new events after shutdown
    expect(eventsB).toEqual(['b1', 'b2']); // still receiving
  });

  it('two discuss registries track sessions independently', () => {
    const regA = createDiscussContextRegistry();
    const regB = createDiscussContextRegistry();

    // Simulate session creation in each registry
    regA.contexts.set('project-a', {
      projectRoot: 'project-a',
      sessions: new Map([['sess-a1', {} as any]]),
    } as any);
    regB.contexts.set('project-b', {
      projectRoot: 'project-b',
      sessions: new Map([['sess-b1', {} as any]]),
    } as any);

    // Clear registry A — B's sessions survive
    regA.contexts.clear();
    expect(regA.contexts.size).toBe(0);
    expect(regB.contexts.size).toBe(1);
    expect(regB.contexts.get('project-b')?.sessions.has('sess-b1')).toBe(true);
  });

  it('two provider registries register independently', () => {
    const regA = new ProviderRegistry();
    const regB = new ProviderRegistry();

    regA.register(
      toProviderSpec({
        name: 'provider-a',
        execute: () => streamProviderTerminal({ content: '', outcome: { kind: 'completed' } }),
      })!,
    );
    regB.register(
      toProviderSpec({
        name: 'provider-b',
        execute: () => streamProviderTerminal({ content: '', outcome: { kind: 'completed' } }),
      })!,
    );

    expect(regA.get('provider-a')).toBeDefined();
    expect(regA.get('provider-b')).toBeUndefined();
    expect(regB.get('provider-b')).toBeDefined();
    expect(regB.get('provider-a')).toBeUndefined();

    // Register built-ins in A only — B stays clean
    registerBuiltInProviders(regA);
    expect(regA.get('codex')).toBeDefined();
    expect(regB.get('codex')).toBeUndefined();
  });

  it('shutdown of backend A does not interfere with backend B event delivery', () => {
    const coordA = new LaunchCoordinator({ runtime: createRealRuntime() });
    const busA = new TypedEventBus();
    const regA = createDiscussContextRegistry();

    const coordB = new LaunchCoordinator({ runtime: createRealRuntime() });
    const busB = new TypedEventBus();
    const regB = createDiscussContextRegistry();

    // Both backends active
    coordA.requestLaunch('job-a', 'codex');
    coordB.requestLaunch('job-b', 'codex');

    const createdJobIdsB: string[] = [];
    busB.on('job:created', (e) => createdJobIdsB.push(e.jobId));

    regA.contexts.set('proj', { projectRoot: 'proj', sessions: new Map() } as any);
    regB.contexts.set('proj', { projectRoot: 'proj', sessions: new Map() } as any);

    // Simulate full shutdown of backend A
    coordA.terminateAll();
    coordA.releaseLaunch('job-a');
    busA.removeAllListeners();
    regA.contexts.clear();

    // Backend B is fully unaffected
    expect(coordB.getActiveJobIds()).toEqual(['job-b']);
    expect(regB.contexts.has('proj')).toBe(true);

    busB.emit('job:created', {
      jobId: 'job-b2',
      sessionId: 's1',
      provider: 'codex',
      projectRoot: 'proj',
    });
    expect(createdJobIdsB).toEqual(['job-b2']);
  });
});
