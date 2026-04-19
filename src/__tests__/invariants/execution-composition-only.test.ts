import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { scanExecutionResidue } from '../__helpers__/execution-residue-ast.js';

interface ResidueContract {
  nextHome: string;
  retirementTrigger: string;
  allowedImports: string[];
  forbiddenIdentifiers: string[];
  forbiddenDiscriminants: string[];
  forbiddenCallees: string[];
  forbiddenConstructionPatterns?: Array<{ keys: string[] }>;
}

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EXECUTION_SCAN = scanExecutionResidue('src/execution');

function globToRegExp(pattern: string): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }

    if (char === '*') {
      source += '[^/]*';
      continue;
    }

    source += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }

  source += '$';
  return new RegExp(source);
}

function matchesPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function contract(
  nextHome: string,
  retirementTrigger: string,
  allowedImports: string[],
  overrides: Partial<Omit<ResidueContract, 'nextHome' | 'retirementTrigger' | 'allowedImports'>> = {},
): ResidueContract {
  return {
    nextHome,
    retirementTrigger,
    allowedImports,
    forbiddenIdentifiers: [],
    forbiddenDiscriminants: [],
    forbiddenCallees: [],
    ...overrides,
  };
}

function entries(files: string[], value: ResidueContract): Record<string, ResidueContract> {
  return Object.fromEntries(files.map((file) => [file, value]));
}

const NODE_AND_VENDOR = ['node:*', 'better-sqlite3', 'zod'];
const COORDINATOR_ALLOWED = [
  ...NODE_AND_VENDOR,
  'src/shared/**',
  'src/runtime/**',
  'src/providers/**',
  'src/execution/**',
  'src/jobs/**',
  'src/sessions/**',
  'src/discuss/**',
  'src/workflow/**',
  'src/store/**',
  'src/infra/**',
  'src/coordinator/**',
  'src/kb/subsystem.ts',
  'src/transport/http/contracts.ts',
  'src/transport/http/handler.ts',
  'src/transport/http/kb-tools.ts',
];
const SESSION_ALLOWED = [
  ...NODE_AND_VENDOR,
  'src/shared/**',
  'src/runtime/**',
  'src/execution/**',
  'src/sessions/**',
  'src/store/**',
  'src/infra/**',
];

const EXECUTION_RESIDUE: Record<string, ResidueContract> = {
  ...entries(
    [
      'src/execution/server.ts',
      'src/execution/backend-core.ts',
      'src/execution/backend-core-types.ts',
      'src/execution/server-types.ts',
      'src/execution/smoke-open-store.ts',
      'src/execution/composition/backend-control.ts',
      'src/execution/composition/backend-defaults.ts',
      'src/execution/composition/backend-world.ts',
      'src/execution/composition/create-backend-core.ts',
      'src/execution/composition/execution-services.ts',
      'src/execution/composition/runtime-state.ts',
    ],
    contract('src/coordinator/**', 'N/A (permanent composition shell)', COORDINATOR_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault'],
    }),
  ),
  'src/execution/service.ts': contract(
    'src/coordinator/** and domain facades',
    'Phase 3 coordinator + Phase 4 transport',
    COORDINATOR_ALLOWED,
    {
      forbiddenDiscriminants: ['coral_fault'],
      forbiddenCallees: ['rebuildProjections'],
    },
  ),
  ...entries(
    [
      'src/execution/lifecycle.ts',
      'src/execution/recovery-registry.ts',
    ],
    contract('src/coordinator/live/**', 'Phase 3 coordinator/live handoff', COORDINATOR_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault'],
      forbiddenCallees: ['recoveryCoordinator.runStartupRecovery'],
    }),
  ),
  'src/execution/backend-lock.ts': contract(
    'src/coordinator/live/lock',
    'Phase 3 coordinator/live/lock',
    COORDINATOR_ALLOWED,
  ),
  ...entries(
    ['src/execution/job-lifecycle.ts', 'src/execution/job-lifecycle-contracts.ts'],
    contract('src/jobs/**', 'Phase 3 coordinator/jobs handoff', COORDINATOR_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault'],
    }),
  ),
  'src/execution/session-manager.ts': contract(
    'src/sessions/**',
    'Phase 3 coordinator/sessions handoff',
    SESSION_ALLOWED,
  ),
  'src/execution/progress-store.ts': contract(
    'removed',
    'Phase 4 transport reads Journal directly',
    COORDINATOR_ALLOWED,
    {
      forbiddenIdentifiers: ['Workflow' + 'Checkpoint'],
      forbiddenDiscriminants: ['coral_fault'],
    },
  ),
};

describe('execution composition-only invariant (AC5)', () => {
  it('documents every non-test src/execution production file', () => {
    expect([...EXECUTION_SCAN.keys()].sort()).toEqual(Object.keys(EXECUTION_RESIDUE).sort());
  });

  for (const [file, residueContract] of Object.entries(EXECUTION_RESIDUE)) {
    it(`${file} honors its residue contract`, () => {
      const residue = EXECUTION_SCAN.get(file);
      expect(residue).toBeDefined();

      for (const imported of residue!.imports) {
        expect(
          matchesPattern(imported, residueContract.allowedImports),
          `${file} imported disallowed module ${imported}`,
        ).toBe(true);
      }

      for (const identifier of residueContract.forbiddenIdentifiers) {
        expect(residue!.identifiers, `${file} referenced forbidden identifier ${identifier}`).not.toContain(identifier);
      }

      for (const literal of residueContract.forbiddenDiscriminants) {
        expect(residue!.literalStrings, `${file} used forbidden discriminant ${literal}`).not.toContain(literal);
      }

      for (const callee of residueContract.forbiddenCallees) {
        expect(
          [...residue!.callees, ...residue!.memberCallees],
          `${file} called forbidden callee ${callee}`,
        ).not.toContain(callee);
      }

      for (const pattern of residueContract.forbiddenConstructionPatterns ?? []) {
        const hasMatch = residue!.objectLiterals.some((literal) => pattern.keys.every((key) => literal.keys.includes(key)));
        expect(
          hasMatch,
          `${file} constructed a forbidden object literal with keys ${pattern.keys.join(', ')}`,
        ).toBe(false);
      }
    });
  }

  it('uses coordinator consumer freshness before startup reconcile/resume ordering', () => {
    const coordinatorSource = readFileSync(join(ROOT, 'src/coordinator/coordinator.ts'), 'utf-8');
    const markers = [
      "registerJobsConsumer(driver, db);",
      "registerSessionsConsumer(driver, db);",
      "registerDiscussConsumer(driver, db);",
      "registerWorkflowConsumer(driver, db);",
      "driver.notify('journal', currentMaxSeq);",
      "driver.waitFreshUntil(currentMaxSeq, consumerId, bootFreshnessTimeoutMs);",
      'jobsReconcile.runStartup(',
      'const recoveredDiscussResumes = await recoverPersistedDiscussFn({',
      'workflowRecover.resumeAll(',
    ];

    let previousIndex = -1;
    for (const marker of markers) {
      const index = coordinatorSource.indexOf(marker);
      expect(index, `Missing coordinator startup marker: ${marker}`).toBeGreaterThan(-1);
      expect(index, `Coordinator startup order regressed around ${marker}`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
