import { readFileSync } from 'node:fs';
import yaml from 'yaml';
import { ZodError } from 'zod';
import type { ScenarioResult, StepResult } from './runner.js';
import { simulationDocumentSchema } from './scenario-schema.js';
import type { SimulationWorld } from './adversarial.js';

process.env.CORAL_TEST_TIER ??= 'simulation';

function summarizeStep(step: StepResult): string | null {
  if (step.type === 'launch' && step.detail && typeof step.detail === 'object') {
    const detail = step.detail as {
      decision?: { status?: string };
      jobId?: string;
      sessionId?: string;
    };
    if (detail.decision?.status && detail.jobId && detail.sessionId) {
      return `${detail.decision.status} job=${detail.jobId} session=${detail.sessionId}`;
    }
    if (detail.decision?.status) {
      return detail.decision.status;
    }
  }

  if (step.type === 'wait' && step.ok && step.detail && typeof step.detail === 'object') {
    const detail = step.detail as { jobId?: string; elapsedMs?: number; steps?: number };
    if (detail.jobId) {
      return `job=${detail.jobId} elapsed=${detail.elapsedMs ?? step.elapsedMs}ms polls=${detail.steps ?? 0}`;
    }
  }

  if (step.type === 'expect' && step.ok) {
    return 'matched';
  }

  if (!step.ok && step.detail && typeof step.detail === 'object' && 'message' in step.detail) {
    const message = (step.detail as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  }

  return null;
}

function formatScenarioResult(result: ScenarioResult): string {
  const lines: string[] = [];

  for (const step of result.steps) {
    const summary = summarizeStep(step);
    lines.push(
      `${step.ok ? 'PASS' : 'FAIL'} ${step.stepIndex} ${step.type} (${step.elapsedMs}ms)${summary ? ` ${summary}` : ''}`,
    );

    if (!step.ok) {
      if (step.expected !== undefined) {
        lines.push(`  expected: ${JSON.stringify(step.expected)}`);
      }
      if (step.actual !== undefined) {
        lines.push(`  actual: ${JSON.stringify(step.actual)}`);
      }
      if (step.detail !== undefined) {
        lines.push(`  detail: ${JSON.stringify(step.detail)}`);
      }
    }
  }

  lines.push(`Scenario ${result.passed ? 'passed' : 'failed'} in ${result.durationMs}ms`);
  return lines.join('\n');
}

function normalizeSimulateError(error: unknown): unknown {
  if (!(error instanceof ZodError)) {
    return error;
  }

  const message = error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ');
  return new Error(`Simulation document validation failed: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withMutedStderr<T>(fn: () => Promise<T>): Promise<T> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stderr.write = originalWrite;
  }
}

export async function runSimulationCli(argv = process.argv.slice(2)): Promise<void> {
  const file = argv[0];
  if (!file || argv.length !== 1 || file === '--help' || file === '-h') {
    process.stdout.write('Usage: npm run simulate -- tools/simulation/scenarios/<scenario.yaml>\n');
    process.exitCode = file === '--help' || file === '-h' ? 0 : 2;
    return;
  }

  let world: SimulationWorld | null = null;

  try {
    const raw = readFileSync(file, 'utf8');
    const doc = simulationDocumentSchema.parse(yaml.parse(raw));
    const { runScenario } = await import('./runner.js');
    const run = await runScenario(doc);
    world = run.world;

    process.stdout.write(formatScenarioResult(run.result) + '\n');
    process.exitCode = run.result.passed ? 0 : 1;
  } catch (error: unknown) {
    process.stderr.write(`${errorMessage(normalizeSimulateError(error))}\n`);
    process.exitCode = 1;
  } finally {
    if (world) {
      const worldToCleanup = world;
      try {
        await withMutedStderr(() => worldToCleanup.teardown());
      } catch (cleanupError: unknown) {
        process.stderr.write(`Simulation cleanup failed: ${errorMessage(cleanupError)}\n`);
        process.exitCode = 1;
      }
    }
  }
}

void runSimulationCli();
