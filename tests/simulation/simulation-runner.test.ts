import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenario } from '#tools/simulation/runner.js';
import { simulationDocumentSchema, type SimulationDocument } from '#tools/simulation/scenario-schema.js';
import type { SimulationWorld } from '#tools/simulation/adversarial.js';

const FIRST_BOOTED_SESSION_ID = '00000000-0000-0000-0000-000000000002';
const FIRST_BOOTED_JOB_ID = '00000000-0000-0000-0000-000000000003';
const SECOND_BOOTED_SESSION_ID = '00000000-0000-0000-0000-000000000004';
const SECOND_BOOTED_JOB_ID = '00000000-0000-0000-0000-000000000005';

const SCENARIO_DIR = join(process.cwd(), 'tools/simulation/scenarios');

// Discovers every yaml in `scenarios/` except `adversarial-*`, which has its
// own dedicated test (`simulation-adversarial.test.ts`) with expected-failure
// handling per scenario name. Any future prefix lands in this loop
// automatically — no manual list maintenance.
function loadGeneralScenarios(): Array<{ name: string; doc: SimulationDocument }> {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('adversarial-'))
    .sort()
    .map((f) => ({
      name: f.replace('.yaml', ''),
      doc: simulationDocumentSchema.parse(yaml.parse(readFileSync(join(SCENARIO_DIR, f), 'utf8'))),
    }));
}

const worlds: SimulationWorld[] = [];

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (!world) {
      continue;
    }
    await world.teardown();
  }
});

describe('scenario runner', () => {
  it('records a launch-before-boot exception as a failed step', async () => {
    const run = await runScenario({
      world: {},
      steps: [{ type: 'launch', provider: 'fake-provider', prompt: 'launch before boot' }],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(false);
    expect(run.result.steps[0]).toMatchObject({
      ok: false,
      detail: {
        failureKind: 'exception',
        message: 'Simulation world must be booted before launch',
      },
    });
  });

  it('rejects invalid scenario documents with schema diagnostics', () => {
    const invalidExpect = simulationDocumentSchema.safeParse({
      world: {},
      steps: [{ type: 'expect' }],
    });
    expect(invalidExpect.success).toBe(false);
    expect(invalidExpect.error?.issues.map((issue) => issue.message)).toContain(
      'expect requires at least one assertion field',
    );

    const invalidWait = simulationDocumentSchema.safeParse({
      world: {},
      steps: [
        {
          type: 'wait',
          until: { terminal: true },
          stepMs: 5,
          maxSteps: 1,
          timeoutMs: 5,
        },
      ],
    });
    expect(invalidWait.success).toBe(false);
    expect(invalidWait.error?.issues.map((issue) => issue.message)).toContain(
      'wait requires exactly one of maxSteps or timeoutMs',
    );

    const invalidKill = simulationDocumentSchema.safeParse({
      world: {},
      steps: [{ type: 'kill', pid: 12, jobId: 'job-1' }],
    });
    expect(invalidKill.success).toBe(false);
    expect(invalidKill.error?.issues.map((issue) => issue.message)).toContain(
      'kill requires exactly one of pid or jobId',
    );
  });

  it('normalizes missing targets and launch rejections into structured step failures', async () => {
    const missingTargetRun = await runScenario({
      world: {},
      steps: [
        {
          type: 'wait',
          until: { terminal: true },
          stepMs: 5,
          maxSteps: 1,
        },
      ],
    });
    worlds.push(missingTargetRun.world);

    expect(missingTargetRun.result.passed).toBe(false);
    expect(missingTargetRun.result.steps[0]).toMatchObject({
      ok: false,
      detail: {
        failureKind: 'missing_target',
      },
    });

    const rejectedRun = await runScenario({
      world: {
        fakeProvider: {
          preflightError: 'simulated preflight failure',
        },
      },
      steps: [{ type: 'boot' }, { type: 'launch', provider: 'fake-provider', prompt: 'reject this launch' }],
    });
    worlds.push(rejectedRun.world);

    expect(rejectedRun.result.passed).toBe(false);
    expect(rejectedRun.result.steps[1]).toMatchObject({
      ok: false,
      detail: {
        failureKind: 'launch_rejected',
        message: 'simulated preflight failure',
        decision: {
          status: 'rejected',
          code: 'preflight_failed',
        },
      },
    });
    expect(rejectedRun.world.listJobIds()).toEqual([]);
  });

  it('resolves omitted targets through the current cursor, including queued launches, and reports wait timeouts', async () => {
    const run = await runScenario({
      world: {
        env: {
          CORAL_MAX_WORKERS: '1',
        },
      },
      steps: [
        { type: 'boot' },
        { type: 'hang' },
        { type: 'launch', provider: 'fake-provider', prompt: 'occupy the only worker' },
        { type: 'launch', provider: 'fake-provider', prompt: 'become queued behind the current worker' },
        { type: 'expect', phase: 'queued', progress: 'queued (position 1)' },
        { type: 'wait', until: { terminal: true }, stepMs: 5, maxSteps: 2 },
      ],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(false);
    expect(run.result.steps[2]).toMatchObject({
      ok: true,
      detail: {
        decision: { status: 'running' },
        jobId: FIRST_BOOTED_JOB_ID,
        sessionId: FIRST_BOOTED_SESSION_ID,
      },
    });
    expect(run.result.steps[3]).toMatchObject({
      ok: true,
      detail: {
        decision: { status: 'queued' },
        jobId: SECOND_BOOTED_JOB_ID,
        sessionId: SECOND_BOOTED_SESSION_ID,
      },
    });
    expect(run.result.steps[4]).toMatchObject({
      ok: true,
      actual: {
        jobId: SECOND_BOOTED_JOB_ID,
        phase: 'queued',
      },
    });
    expect(run.result.steps[5]).toMatchObject({
      ok: false,
      detail: {
        failureKind: 'timeout',
      },
      actual: {
        observation: {
          phase: 'queued',
          runtimeRecorded: false,
          terminal: false,
        },
      },
    });

    expect(run.world.getJobStatus(FIRST_BOOTED_JOB_ID)?.phase).toBe('running');
    expect(run.world.getJobStatus(SECOND_BOOTED_JOB_ID)?.phase).toBe('queued');
  });

  it('supports crash fault injection with Journal-backed runtime and exit reads', async () => {
    const run = await runScenario({
      world: {},
      steps: [
        { type: 'boot' },
        { type: 'crash', exitCode: 9, delayMs: 15 },
        { type: 'launch', provider: 'fake-provider', prompt: 'crash after launch' },
        { type: 'wait', until: { runtimeRecorded: true }, stepMs: 5, maxSteps: 5 },
        { type: 'wait', until: { terminal: true }, stepMs: 500, maxSteps: 4 },
        { type: 'expect', runtimeRecorded: true },
      ],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(true);
    expect(run.result.steps[1]).toMatchObject({
      ok: true,
      actual: {
        delayMs: 15,
        exitCode: 9,
        signal: null,
      },
    });
    expect(run.result.steps[2]).toMatchObject({
      ok: true,
      detail: {
        decision: { status: 'running' },
        jobId: FIRST_BOOTED_JOB_ID,
        sessionId: FIRST_BOOTED_SESSION_ID,
      },
    });
    expect(run.result.steps[5]).toMatchObject({
      ok: true,
      actual: {
        jobId: FIRST_BOOTED_JOB_ID,
        runtimeRecorded: true,
      },
    });
    expect(run.world.getJobStatus(FIRST_BOOTED_JOB_ID)).toMatchObject({
      phase: 'error',
      result: {
        outcome: {
          kind: 'failed',
        },
      },
    });
    expect(run.world.readArtifact(FIRST_BOOTED_JOB_ID, 'exit')).toMatchObject({
      exitCode: 9,
      signal: null,
    });
    expect(run.world.readArtifact(FIRST_BOOTED_JOB_ID, 'runtime')).toMatchObject({
      pid: expect.any(Number),
    });
  });

  it('advances virtual time by the specified milliseconds', async () => {
    const run = await runScenario({
      world: {},
      steps: [{ type: 'boot' }, { type: 'advance', ms: 500 }, { type: 'advance', ms: 1000 }],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(true);
    expect(run.result.steps[1]).toMatchObject({
      ok: true,
      type: 'advance',
      actual: { advancedMs: 500 },
    });
    expect(run.result.steps[2]).toMatchObject({
      ok: true,
      type: 'advance',
      actual: { advancedMs: 1000 },
    });
  });

  it('shuts down the backend and reports the reason', async () => {
    const run = await runScenario({
      world: {},
      steps: [{ type: 'boot' }, { type: 'shutdown', reason: 'test-shutdown' }],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(true);
    expect(run.result.steps[1]).toMatchObject({
      ok: true,
      type: 'shutdown',
      actual: { reason: 'test-shutdown' },
    });
  });

  it('cycles the simulation world to the next generation', async () => {
    const run = await runScenario({
      world: {},
      steps: [{ type: 'boot' }, { type: 'cycle' }],
    });
    worlds.push(run.world);

    expect(run.result.passed).toBe(true);
    expect(run.result.steps[1]).toMatchObject({
      ok: true,
      type: 'cycle',
      detail: {
        generation: 1,
      },
    });
    expect(run.world.generation()).toMatchObject({
      index: 1,
    });
  });

  it('kills a running job by resolved cursor target', async () => {
    const run = await runScenario({
      world: {},
      steps: [
        { type: 'boot' },
        { type: 'launch', provider: 'fake-provider', prompt: 'launch then kill' },
        { type: 'wait', until: { runtimeRecorded: true }, stepMs: 5, maxSteps: 10 },
        { type: 'kill', jobId: FIRST_BOOTED_JOB_ID },
        { type: 'wait', until: { terminal: true }, stepMs: 100, maxSteps: 20 },
      ],
    });
    worlds.push(run.world);

    expect(run.result.steps[3]).toMatchObject({
      ok: true,
      type: 'kill',
      actual: { jobId: FIRST_BOOTED_JOB_ID },
    });
    expect(run.result.passed).toBe(true);
    expect(run.world.getJobStatus(FIRST_BOOTED_JOB_ID)?.phase).toBe('completed');
  });

  describe('auto-discovered scenarios (non-adversarial)', () => {
    const scenarios = loadGeneralScenarios();

    it('discovery surfaces at least one scenario', () => {
      expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const { name, doc } of scenarios) {
      it(`${name} round-trips through parse, validate, and re-serialize`, () => {
        const reparsed = simulationDocumentSchema.parse(yaml.parse(yaml.stringify(doc)));
        expect(reparsed).toEqual(doc);
      });

      it(`${name} runs to completion with all steps passing`, async () => {
        const { result, world } = await runScenario(doc);
        worlds.push(world);

        const failures = result.steps.filter((s) => !s.ok);
        if (failures.length > 0) {
          const report = failures.map(
            (f) => `  step ${f.stepIndex} (${f.type}): ${JSON.stringify(f.detail, null, 2)}`,
          );
          console.log(`\n[${name}] ${failures.length} failed step(s):\n${report.join('\n')}`);
        }

        expect(result.passed).toBe(true);
      });
    }
  });
});
