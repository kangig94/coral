import type {
  ChildOutputChunk,
  FakeProviderScenario,
  MockDurableScript,
  MockKillAction,
  MockSpawnScript,
  SimulationScenario,
} from './core/backend.js';
import type { TerminalOutcome } from '../../src/providers/contract.js';
import { toError } from './core/constants.js';
import type { ScenarioError, WorldConfig } from './scenario-schema.js';

function toRuntimeError(value: ScenarioError | Error | string): Error {
  if (value instanceof Error || typeof value === 'string') {
    return toError(value);
  }

  const error = new Error(value.message);
  if (value.name) {
    error.name = value.name;
  }
  if (value.code) {
    (error as Error & { code?: string }).code = value.code;
  }
  return error;
}

function cloneOutputChunks(value: string | ChildOutputChunk[] | undefined): string | ChildOutputChunk[] | undefined {
  if (value === undefined || typeof value === 'string') {
    return value;
  }
  return value.map((chunk) => ({ ...chunk }));
}

function cloneKillActions(
  kills:
    | Array<{
        signal?: string | 0;
        delayMs?: number;
        exitCode?: number | null;
        exitSignal?: string | null;
      }>
    | undefined,
): MockKillAction[] | undefined {
  return kills?.map((entry) => ({
    ...entry,
    signal: entry.signal as MockKillAction['signal'],
  }));
}

export function normalizeSpawnScripts(scripts: WorldConfig['spawn']): MockSpawnScript[] | undefined {
  return scripts?.map((script) => ({
    pid: script.pid,
    stdout: cloneOutputChunks(script.stdout),
    stderr: cloneOutputChunks(script.stderr),
    close: script.close === undefined ? undefined : script.close === null ? null : { ...script.close },
    error:
      script.error === undefined
        ? undefined
        : script.error === null
          ? null
          : {
              delayMs: script.error.delayMs,
              error: toRuntimeError(script.error.error),
            },
    kills: cloneKillActions(script.kills),
  }));
}

export function normalizeDurableScripts(scripts: WorldConfig['durable']): MockDurableScript[] | undefined {
  return scripts?.map((script) => ({
    pid: script.pid,
    runtimeDelayMs: script.runtimeDelayMs,
    stdout: cloneOutputChunks(script.stdout),
    stderr: cloneOutputChunks(script.stderr),
    runtimeRecord: script.runtimeRecord ? { ...script.runtimeRecord } : undefined,
    exit: script.exit === undefined ? undefined : script.exit === null ? null : { ...script.exit },
    kills: cloneKillActions(script.kills),
    waitForExitError: script.waitForExitError === undefined ? undefined : toRuntimeError(script.waitForExitError),
  }));
}

export function normalizeFakeProvider(config: WorldConfig['fakeProvider']): FakeProviderScenario | undefined {
  if (!config) {
    return undefined;
  }

  return {
    name: config.name,
    faultProvider: config.faultProvider,
    cli: config.cli
      ? {
          command: config.cli.command,
          args: config.cli.args ? [...config.cli.args] : undefined,
          extraEnv: config.cli.extraEnv ? { ...config.cli.extraEnv } : undefined,
        }
      : undefined,
    progress: config.progress?.map((entry) => ({ ...entry })),
    result: config.result
      ? {
          ...config.result,
          warnings: config.result.warnings ? [...config.result.warnings] : undefined,
          usage: config.result.usage ? { ...config.result.usage } : undefined,
          outcome: { ...config.result.outcome } as TerminalOutcome,
        }
      : undefined,
    preflightError: config.preflightError === undefined ? undefined : toRuntimeError(config.preflightError),
  };
}

export function normalizeWorldConfig(config: WorldConfig): SimulationScenario {
  return {
    epochMs: config.epochMs,
    env: config.env ? { ...config.env } : undefined,
    pluginRoot: config.pluginRoot,
    projectRoot: config.projectRoot,
    listen: config.listen ? { ...config.listen } : undefined,
    spawn: normalizeSpawnScripts(config.spawn),
    durable: normalizeDurableScripts(config.durable),
    fakeProvider: normalizeFakeProvider(config.fakeProvider),
  };
}
