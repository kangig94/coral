import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenario } from '#tools/simulation/runner.js';
import { simulationDocumentSchema, type SimulationDocument } from '#tools/simulation/scenario-schema.js';
import type { SimulationWorld } from '#tools/simulation/adversarial.js';

const SCENARIO_DIR = join(process.cwd(), 'tools/simulation/scenarios');
const worlds: SimulationWorld[] = [];

const EXPECTED_FAILURE_SCENARIOS: Record<string, { stepIndex: number; failureKind: string }> = {
  'adversarial-kill-before-runtime': { stepIndex: 2, failureKind: 'missing_runtime_pid' },
};

afterEach(async () => {
  while (worlds.length > 0) {
    const world = worlds.pop();
    if (!world) {
      continue;
    }
    await world.teardown();
  }
});

function loadAdversarialScenarios(): Array<{ name: string; doc: SimulationDocument }> {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.startsWith('adversarial-') && f.endsWith('.yaml'))
    .sort()
    .map((f) => ({
      name: f.replace('.yaml', ''),
      doc: simulationDocumentSchema.parse(yaml.parse(readFileSync(join(SCENARIO_DIR, f), 'utf8'))),
    }));
}

describe('adversarial simulation scenarios', () => {
  const scenarios = loadAdversarialScenarios();

  for (const { name, doc } of scenarios) {
    const expectedFailure = EXPECTED_FAILURE_SCENARIOS[name];

    if (expectedFailure) {
      it(`${name} (expected failure)`, async () => {
        const { result, world } = await runScenario(doc);
        worlds.push(world);

        const failedStep = result.steps.find((s) => !s.ok);
        expect(failedStep).toBeDefined();
        expect(failedStep!.stepIndex).toBe(expectedFailure.stepIndex);
        expect(failedStep!.detail).toMatchObject({ failureKind: expectedFailure.failureKind });
      });
    } else {
      it(`${name}`, async () => {
        const { result, world } = await runScenario(doc);
        worlds.push(world);

        const failures = result.steps.filter((s) => !s.ok);
        if (failures.length > 0) {
          const report = failures.map((f) => `  step ${f.stepIndex} (${f.type}): ${JSON.stringify(f.detail, null, 2)}`);
          console.log(`\n[${name}] ${failures.length} failed step(s):\n${report.join('\n')}`);
        }

        expect(result.passed).toBe(true);
      });
    }
  }
});
