import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIMULATION_CLI = resolve(REPO_ROOT, 'tools/simulation/cli.ts');

describe('standalone simulation tier', () => {
  it('establishes the simulation tier before entry-point work', () => {
    const source = ts.createSourceFile(
      SIMULATION_CLI,
      readFileSync(SIMULATION_CLI, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const statements = source.statements.map((statement) => statement.getText(source));
    const tierStamp = statements.indexOf("process.env.CORAL_TEST_TIER = 'simulation';");
    const entryPointRun = statements.indexOf('void runSimulationCli();');

    expect(tierStamp).toBeGreaterThan(-1);
    expect(entryPointRun).toBeGreaterThan(tierStamp);
  });
});
