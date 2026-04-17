import { z } from 'zod';
import { terminalOutcomeSchema } from '../../shared/coral-fault.js';

const scenarioErrorSchema = z.union([
  z.string(),
  z.object({
    message: z.string(),
    name: z.string().optional(),
    code: z.string().optional(),
  }),
]);
export type ScenarioError = z.infer<typeof scenarioErrorSchema>;

const childOutputChunkSchema = z.object({
  delayMs: z.number().optional(),
  data: z.string(),
});

const mockKillActionSchema = z.object({
  signal: z.union([z.string(), z.literal(0)]).optional(),
  delayMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  exitSignal: z.string().nullable().optional(),
});

const outputChunksSchema = z.union([z.string(), z.array(childOutputChunkSchema)]);

const mockSpawnCloseSchema = z.object({
  delayMs: z.number().optional(),
  code: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
});

const mockSpawnErrorSchema = z.object({
  delayMs: z.number().optional(),
  error: scenarioErrorSchema,
});

const mockSpawnScriptSchema = z.object({
  pid: z.number().optional(),
  stdout: outputChunksSchema.optional(),
  stderr: outputChunksSchema.optional(),
  close: mockSpawnCloseSchema.nullable().optional(),
  error: mockSpawnErrorSchema.nullable().optional(),
  kills: z.array(mockKillActionSchema).optional(),
});

const durableCliRuntimeRecordSchema = z.object({
  transport: z.literal('durable-cli').optional(),
  pid: z.number(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  startTime: z.string(),
  providerMeta: z.record(z.unknown()).optional(),
  tailWatermark: z.number().optional(),
});

const mockDurableExitSchema = z.object({
  delayMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
});

const mockDurableScriptSchema = z.object({
  pid: z.number().optional(),
  runtimeDelayMs: z.number().optional(),
  stdout: outputChunksSchema.optional(),
  stderr: outputChunksSchema.optional(),
  runtimeRecord: durableCliRuntimeRecordSchema.partial().optional(),
  exit: mockDurableExitSchema.nullable().optional(),
  kills: z.array(mockKillActionSchema).optional(),
  waitForExitError: scenarioErrorSchema.optional(),
});

const fakeProviderCliSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  extraEnv: z.record(z.string()).optional(),
});

const fakeProviderProgressSchema = z.object({
  delayMs: z.number().optional(),
  message: z.string(),
});

const usageSummarySchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});

const fakeProviderResultSchema = z.object({
  content: z.string().optional(),
  conversationRef: z.string().optional(),
  model: z.string().optional(),
  durationMs: z.number().optional(),
  nonResumable: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  warnings: z.array(z.string()).optional(),
  usage: usageSummarySchema.optional(),
  outcome: terminalOutcomeSchema,
});

const fakeProviderSchema = z.object({
  name: z.string().optional(),
  cli: fakeProviderCliSchema.optional(),
  progress: z.array(fakeProviderProgressSchema).optional(),
  result: fakeProviderResultSchema.optional(),
  preflightError: scenarioErrorSchema.optional(),
});

const worldConfigSchema = z.object({
  epochMs: z.number().optional(),
  env: z.record(z.string()).optional(),
  pluginRoot: z.string().optional(),
  projectRoot: z.string().optional(),
  listen: z
    .object({
      host: z.string().optional(),
      port: z.number().optional(),
    })
    .optional(),
  spawn: z.array(mockSpawnScriptSchema).optional(),
  durable: z.array(mockDurableScriptSchema).optional(),
  fakeProvider: fakeProviderSchema.optional(),
});
export type WorldConfig = z.infer<typeof worldConfigSchema>;

const bootStepSchema = z.object({
  type: z.literal('boot'),
});

const launchStepSchema = z.object({
  type: z.literal('launch'),
  provider: z.string().default('fake-provider'),
  prompt: z.string().min(1),
  agent: z.string().optional(),
  projectRoot: z.string().optional(),
  coralEnv: z.record(z.string()).optional(),
});
export type LaunchStep = z.infer<typeof launchStepSchema>;

const waitUntilSchema = z
  .object({
    phase: z.string().optional(),
    runtimeRecorded: z.boolean().optional(),
    terminal: z.boolean().optional(),
    progressContains: z.string().optional(),
  })
  .refine((until) => Object.values(until).some((value) => value !== undefined), {
    message: 'wait.until requires at least one predicate',
  });
export type WaitUntil = z.infer<typeof waitUntilSchema>;

const waitStepObjectSchema = z.object({
  type: z.literal('wait'),
  jobId: z.string().optional(),
  until: waitUntilSchema,
  stepMs: z.number().positive(),
  maxSteps: z.number().int().positive().optional(),
  timeoutMs: z.number().positive().optional(),
});

const advanceStepSchema = z.object({
  type: z.literal('advance'),
  ms: z.number(),
});

const abortStepSchema = z.object({
  type: z.literal('abort'),
  jobId: z.string().optional(),
});

const killStepObjectSchema = z.object({
  type: z.literal('kill'),
  pid: z.number().optional(),
  jobId: z.string().optional(),
});
export type KillStep = z.infer<typeof killStepObjectSchema>;

export const cycleStepSchema = z.object({
  type: z.literal('cycle'),
});

/** @deprecated Use cycleStepSchema. */
export const restartStepSchema = z.object({
  type: z.literal('restart'),
});

const shutdownStepSchema = z.object({
  type: z.literal('shutdown'),
  reason: z.string().optional(),
});

const resultExpectationSchema = z.object({
  content: z.string().optional(),
  outcome: terminalOutcomeSchema,
});

const sessionCountExpectationSchema = z.object({
  provider: z.string(),
  count: z.number().int().nonnegative(),
  projectRoot: z.string().optional(),
});

const timingExpectationSchema = z.object({
  minMs: z.number().optional(),
  maxMs: z.number().optional(),
});

const expectStepObjectSchema = z.object({
  type: z.literal('expect'),
  jobId: z.string().optional(),
  phase: z.string().optional(),
  progress: z.string().optional(),
  result: resultExpectationSchema.optional(),
  runtimeRecorded: z.boolean().optional(),
  jobCount: z.number().int().nonnegative().optional(),
  sessionCount: sessionCountExpectationSchema.optional(),
  timing: timingExpectationSchema.optional(),
  noRealIO: z.boolean().optional(),
});
export type ExpectStep = z.infer<typeof expectStepObjectSchema>;

const hangStepSchema = z.object({
  type: z.literal('hang'),
  delayMs: z.number().optional(),
});

const crashStepSchema = z.object({
  type: z.literal('crash'),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  delayMs: z.number().optional(),
});

const corruptTargetSchema = z.enum(['status', 'runtime', 'exit']);
export type CorruptTarget = z.infer<typeof corruptTargetSchema>;

const corruptStepSchema = z.object({
  type: z.literal('corrupt'),
  jobId: z.string(),
  target: corruptTargetSchema,
});

const stepSchema = z
  .discriminatedUnion('type', [
    bootStepSchema,
    launchStepSchema,
    waitStepObjectSchema,
    advanceStepSchema,
    abortStepSchema,
    killStepObjectSchema,
    cycleStepSchema,
    restartStepSchema,
    shutdownStepSchema,
    expectStepObjectSchema,
    hangStepSchema,
    crashStepSchema,
    corruptStepSchema,
  ])
  .superRefine((step, ctx) => {
    if (step.type === 'wait' && (step.maxSteps === undefined) === (step.timeoutMs === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wait requires exactly one of maxSteps or timeoutMs',
      });
    }

    if (step.type === 'kill' && (step.pid === undefined) === (step.jobId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'kill requires exactly one of pid or jobId',
      });
    }

    if (
      step.type === 'expect' &&
      ![
        step.phase,
        step.progress,
        step.result,
        step.runtimeRecorded,
        step.jobCount,
        step.sessionCount,
        step.timing,
        step.noRealIO,
      ].some((value) => value !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expect requires at least one assertion field',
      });
    }
  });
export type Step = z.infer<typeof stepSchema>;

export const simulationDocumentSchema = z.object({
  world: worldConfigSchema,
  steps: z.array(stepSchema),
  continueOnFailure: z.boolean().optional(),
});
export type SimulationDocument = z.infer<typeof simulationDocumentSchema>;
