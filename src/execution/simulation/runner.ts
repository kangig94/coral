import { extractRuntimePid, SimulationWorld, type WaitDetail } from './world.js';
import type { ExpectStep, KillStep, SimulationDocument, Step } from './schema.js';

export type StepResult = {
  stepIndex: number;
  type: Step['type'];
  ok: boolean;
  elapsedMs: number;
  expected?: unknown;
  actual?: unknown;
  detail?: unknown;
};

export type ScenarioResult = {
  steps: StepResult[];
  passed: boolean;
  durationMs: number;
};

export type ScenarioRun = {
  result: ScenarioResult;
  world: SimulationWorld;
};

type FailureDetail = {
  failureKind: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
  [key: string]: unknown;
};

type RunnerCursor = {
  generation: number;
  currentJobId: string | null;
  launchedJobIds: Set<string>;
};

type ResolvedJobTarget =
  | { ok: true; jobId: string }
  | { ok: false; detail: FailureDetail };

function createRunnerCursor(): RunnerCursor {
  return {
    generation: 0,
    currentJobId: null,
    launchedJobIds: new Set<string>(),
  };
}

function asErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function resolveJobTarget(jobId: string | undefined, cursor: RunnerCursor, action: string): ResolvedJobTarget {
  if (jobId) {
    return { ok: true, jobId };
  }

  if (cursor.currentJobId) {
    return { ok: true, jobId: cursor.currentJobId };
  }

  if (cursor.launchedJobIds.size === 0) {
    return {
      ok: false,
      detail: {
        failureKind: 'missing_target',
        message: `${action} requires a jobId because the current world generation has no accepted launch target`,
        actual: {
          generation: cursor.generation,
          launchedJobIds: [],
        },
      },
    };
  }

  if (cursor.launchedJobIds.size === 1) {
    return {
      ok: true,
      jobId: [...cursor.launchedJobIds][0] as string,
    };
  }

  return {
    ok: false,
    detail: {
      failureKind: 'ambiguous_target',
      message: `${action} requires an explicit jobId because multiple jobs exist in the current world generation`,
      actual: {
        generation: cursor.generation,
        launchedJobIds: [...cursor.launchedJobIds],
      },
    },
  };
}

function resetCursor(cursor: RunnerCursor): void {
  cursor.generation += 1;
  cursor.currentJobId = null;
  cursor.launchedJobIds.clear();
}

function captureExpectedAssertions(step: ExpectStep): Record<string, unknown> {
  const expected: Record<string, unknown> = {};

  if (step.jobId !== undefined) expected.jobId = step.jobId;
  if (step.phase !== undefined) expected.phase = step.phase;
  if (step.progress !== undefined) expected.progress = step.progress;
  if (step.result !== undefined) expected.result = step.result;
  if (step.runtimeRecorded !== undefined) expected.runtimeRecorded = step.runtimeRecorded;
  if (step.jobCount !== undefined) expected.jobCount = step.jobCount;
  if (step.sessionCount !== undefined) expected.sessionCount = step.sessionCount;
  if (step.timing !== undefined) expected.timing = step.timing;
  if (step.noRealIO !== undefined) expected.noRealIO = step.noRealIO;

  return expected;
}

function buildStepResult(
  world: SimulationWorld,
  step: Step,
  stepIndex: number,
  startedAt: number,
  outcome: Omit<StepResult, 'stepIndex' | 'type' | 'elapsedMs'>,
): StepResult {
  return {
    stepIndex,
    type: step.type,
    elapsedMs: world.getVirtualElapsedMs() - startedAt,
    ...outcome,
  };
}

async function runExpectStep(
  world: SimulationWorld,
  step: ExpectStep,
  cursor: RunnerCursor,
): Promise<{ ok: boolean; expected: Record<string, unknown>; actual: Record<string, unknown>; detail?: FailureDetail }> {
  const expected = captureExpectedAssertions(step);
  const actual: Record<string, unknown> = {};
  const mismatches: string[] = [];

  const needsJobScopedTarget =
    step.phase !== undefined ||
    step.progress !== undefined ||
    step.result !== undefined ||
    step.runtimeRecorded !== undefined;

  if (needsJobScopedTarget) {
    const resolved = resolveJobTarget(step.jobId, cursor, 'expect');
    if (!resolved.ok) {
      return {
        ok: false,
        expected,
        actual,
        detail: resolved.detail,
      };
    }

    const jobId = resolved.jobId;
    const status = world.getJobStatus(jobId);
    const progress = world.getProgress(jobId);
    actual.jobId = jobId;

    if (step.phase !== undefined) {
      actual.phase = status?.phase ?? null;
      if (actual.phase !== step.phase) {
        mismatches.push(`expected phase ${step.phase}, received ${String(actual.phase)}`);
      }
    }

    if (step.progress !== undefined) {
      const expectedProgress = step.progress;
      actual.progress = progress;
      if (!progress.some((entry) => entry.includes(expectedProgress))) {
        mismatches.push(`expected progress containing "${expectedProgress}"`);
      }
    }

    if (step.result !== undefined) {
      actual.result = status?.result ?? null;
      if (step.result.content !== undefined && status?.result?.content !== step.result.content) {
        mismatches.push('expected result.content to match');
      }
      if (step.result.aborted !== undefined && status?.result?.aborted !== step.result.aborted) {
        mismatches.push('expected result.aborted to match');
      }
    }

    if (step.runtimeRecorded !== undefined) {
      const runtimeRecorded = world.readArtifact(jobId, 'runtime', { freshness: 'cached' }) !== null;
      actual.runtimeRecorded = runtimeRecorded;
      if (runtimeRecorded !== step.runtimeRecorded) {
        mismatches.push(`expected runtimeRecorded=${step.runtimeRecorded}`);
      }
    }
  }

  if (step.jobCount !== undefined) {
    actual.jobCount = world.listJobIds().length;
    if (actual.jobCount !== step.jobCount) {
      mismatches.push(`expected jobCount=${step.jobCount}, received ${String(actual.jobCount)}`);
    }
  }

  if (step.sessionCount !== undefined) {
    actual.sessionCount = world.listSessions(step.sessionCount.provider, step.sessionCount.projectRoot).length;
    if (actual.sessionCount !== step.sessionCount.count) {
      mismatches.push(`expected sessionCount=${step.sessionCount.count}, received ${String(actual.sessionCount)}`);
    }
  }

  if (step.timing !== undefined) {
    const timing = world.getVirtualElapsedMs();
    actual.timing = timing;
    if (step.timing.minMs !== undefined && timing < step.timing.minMs) {
      mismatches.push(`expected timing >= ${step.timing.minMs}, received ${timing}`);
    }
    if (step.timing.maxMs !== undefined && timing > step.timing.maxMs) {
      mismatches.push(`expected timing <= ${step.timing.maxMs}, received ${timing}`);
    }
  }

  if (step.noRealIO !== undefined) {
    const report = world.getNoRealIoReport();
    const noRealIo =
      report.realFetchCalls === 0 && report.realKillCalls === 0 && report.violations.length === 0;
    actual.noRealIO = report;
    if (noRealIo !== step.noRealIO) {
      mismatches.push(`expected noRealIO=${step.noRealIO}`);
    }
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      expected,
      actual,
      detail: {
        failureKind: 'expectation_failed',
        message: mismatches.join('; '),
        expected,
        actual,
      },
    };
  }

  return {
    ok: true,
    expected,
    actual,
  };
}

async function runKillStep(
  world: SimulationWorld,
  step: KillStep,
  cursor: RunnerCursor,
): Promise<{ ok: boolean; actual?: unknown; detail?: FailureDetail }> {
  if (step.pid !== undefined) {
    await world.kill({ pid: step.pid });
    return {
      ok: true,
      actual: { pid: step.pid },
    };
  }

  const resolved = resolveJobTarget(step.jobId, cursor, 'kill');
  if (!resolved.ok) {
    return { ok: false, detail: resolved.detail };
  }

  const runtime = world.readArtifact(resolved.jobId, 'runtime', { freshness: 'cached' });
  const pid = extractRuntimePid(runtime);
  if (pid === null) {
    return {
      ok: false,
      detail: {
        failureKind: 'missing_runtime_pid',
        message: `kill could not resolve a runtime pid for ${resolved.jobId}`,
        actual: runtime,
      },
    };
  }

  await world.kill({ jobId: resolved.jobId });
  return {
    ok: true,
    actual: { jobId: resolved.jobId, pid },
  };
}

async function executeStep(
  world: SimulationWorld,
  step: Step,
  stepIndex: number,
  cursor: RunnerCursor,
): Promise<StepResult> {
  const startedAt = world.getVirtualElapsedMs();

  try {
    switch (step.type) {
      case 'boot': {
        const info = await world.boot();
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          detail: { info },
        });
      }

      case 'launch': {
        const decision = await world.launchJob(step);
        const detail =
          decision.status === 'rejected'
            ? { decision }
            : {
                decision,
                jobId: decision.job,
                sessionId: decision.session,
              };

        if (decision.status === 'running' || decision.status === 'queued') {
          cursor.currentJobId = decision.job;
          cursor.launchedJobIds.add(decision.job);
          return buildStepResult(world, step, stepIndex, startedAt, {
            ok: true,
            detail,
            actual: detail,
          });
        }

        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: false,
          actual: decision,
          detail: {
            failureKind: 'launch_rejected',
            message: decision.message,
            actual: decision,
            decision,
          },
        });
      }

      case 'advance': {
        await world.advance(step.ms);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: { advancedMs: step.ms },
        });
      }

      case 'wait': {
        const resolved = resolveJobTarget(step.jobId, cursor, 'wait');
        if (!resolved.ok) {
          return buildStepResult(world, step, stepIndex, startedAt, {
            ok: false,
            detail: resolved.detail,
          });
        }

        const waitDetail: WaitDetail = await world.waitUntil(resolved.jobId, step.until, step.stepMs, {
          maxSteps: step.maxSteps,
          timeoutMs: step.timeoutMs,
        });
        if (waitDetail.ok) {
          return buildStepResult(world, step, stepIndex, startedAt, {
            ok: true,
            actual: waitDetail.actual,
            detail: waitDetail,
          });
        }

        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: false,
          expected: waitDetail.expected,
          actual: {
            elapsedMs: waitDetail.elapsedMs,
            steps: waitDetail.steps,
            observation: waitDetail.actual,
          },
          detail: {
            failureKind: 'timeout',
            message: `Timed out waiting for ${resolved.jobId}`,
            expected: waitDetail.expected,
            actual: {
              elapsedMs: waitDetail.elapsedMs,
              steps: waitDetail.steps,
              observation: waitDetail.actual,
            },
            wait: waitDetail,
          },
        });
      }

      case 'abort': {
        const resolved = resolveJobTarget(step.jobId, cursor, 'abort');
        if (!resolved.ok) {
          return buildStepResult(world, step, stepIndex, startedAt, {
            ok: false,
            detail: resolved.detail,
          });
        }

        await world.abort(resolved.jobId);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: { jobId: resolved.jobId },
        });
      }

      case 'kill': {
        const outcome = await runKillStep(world, step, cursor);
        return buildStepResult(world, step, stepIndex, startedAt, outcome.ok ? {
          ok: true,
          actual: outcome.actual,
        } : {
          ok: false,
          actual: outcome.actual,
          detail: outcome.detail,
        });
      }

      case 'restart': {
        const info = await world.restart();
        resetCursor(cursor);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          detail: { info, generation: cursor.generation },
        });
      }

      case 'shutdown': {
        await world.shutdown(step.reason);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: { reason: step.reason ?? 'simulation-shutdown' },
        });
      }

      case 'expect': {
        const outcome = await runExpectStep(world, step, cursor);
        return buildStepResult(world, step, stepIndex, startedAt, outcome.ok ? {
          ok: true,
          expected: outcome.expected,
          actual: outcome.actual,
          detail: { actual: outcome.actual },
        } : {
          ok: false,
          expected: outcome.expected,
          actual: outcome.actual,
          detail: outcome.detail,
        });
      }

      case 'hang': {
        world.enqueueHang(step.delayMs);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: {
            runtimeDelayMs: step.delayMs ?? 0,
            exit: null,
          },
        });
      }

      case 'crash': {
        const exitCode = step.exitCode ?? (step.signal === undefined ? 1 : null);
        world.enqueueCrash(step.exitCode, step.signal, step.delayMs);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: {
            delayMs: step.delayMs ?? 0,
            exitCode,
            signal: step.signal ?? null,
          },
        });
      }

      case 'corrupt': {
        world.corrupt(step.jobId, step.target);
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: true,
          actual: {
            jobId: step.jobId,
            target: step.target,
          },
        });
      }

      default: {
        const unhandledStep: never = step;
        return buildStepResult(world, step, stepIndex, startedAt, {
          ok: false,
          detail: {
            failureKind: 'unsupported_step',
            message: `Unsupported step`,
            actual: unhandledStep,
          },
        });
      }
    }
  } catch (error: unknown) {
    return buildStepResult(world, step, stepIndex, startedAt, {
      ok: false,
      detail: {
        failureKind: 'exception',
        message: asErrorMessage(error),
        actual: error instanceof Error ? { name: error.name, message: error.message } : error,
      },
    });
  }
}

export async function runScenario(doc: SimulationDocument): Promise<ScenarioRun> {
  const world = new SimulationWorld(doc.world);
  const cursor = createRunnerCursor();
  const steps: StepResult[] = [];

  for (const [stepIndex, step] of doc.steps.entries()) {
    const result = await executeStep(world, step, stepIndex, cursor);
    steps.push(result);
    if (!result.ok && !doc.continueOnFailure) {
      break;
    }
  }

  return {
    world,
    result: {
      steps,
      passed: steps.every((step) => step.ok),
      durationMs: world.getVirtualElapsedMs(),
    },
  };
}
