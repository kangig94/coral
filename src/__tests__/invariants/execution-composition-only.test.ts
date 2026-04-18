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
];
const TRANSPORT_ALLOWED = [...COORDINATOR_ALLOWED, 'src/client/**', 'src/kb/**'];
const SIMULATION_ALLOWED = [
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
  'src/simulation/**',
  'src/coordinator/**',
  'src/kb/**',
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
const ENGINE_ALLOWED = [...NODE_AND_VENDOR, 'src/shared/**', 'src/runtime/**', 'src/execution/**', 'src/providers/**'];
const KB_ALLOWED = [...TRANSPORT_ALLOWED, 'src/kb/**'];

const EXECUTION_RESIDUE: Record<string, ResidueContract> = {
  ...entries(
    [
      'src/execution/server.ts',
      'src/execution/backend-core.ts',
      'src/execution/backend-core-types.ts',
      'src/execution/server-types.ts',
      'src/execution/event-bus.ts',
      'src/execution/idle-timer.ts',
      'src/execution/recording-observer.ts',
      'src/execution/smoke-open-store.ts',
      'src/execution/composition/backend-control.ts',
      'src/execution/composition/backend-defaults.ts',
      'src/execution/composition/backend-world.ts',
      'src/execution/composition/create-backend-core.ts',
      'src/execution/composition/discuss-runtime.ts',
      'src/execution/composition/execution-services.ts',
      'src/execution/composition/runtime-state.ts',
    ],
    contract('src/coordinator/**', 'N/A (permanent composition shell)', COORDINATOR_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault'],
    }),
  ),
  ...entries(
    [
      'src/execution/http-handler.ts',
      'src/execution/query-coerce.ts',
      'src/execution/tool-response.ts',
      'src/execution/backend-contracts.ts',
    ],
    contract('src/transport/**', 'Phase 4 transport cutover', TRANSPORT_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault'],
    }),
  ),
  'src/execution/service.ts': contract(
    'src/coordinator/** and domain facades',
    'Phase 3 coordinator + Phase 4 transport',
    COORDINATOR_ALLOWED,
    {
      forbiddenDiscriminants: ['coral_fault'],
      forbiddenCallees: ['appendEvents', 'rebuildProjections'],
    },
  ),
  ...entries(
    ['src/execution/engine.ts', 'src/execution/host-manager.ts'],
    contract('src/coordinator/live/**', 'Phase 3 coordinator/live handoff', ENGINE_ALLOWED, {
      forbiddenDiscriminants: ['coral_fault', 'legacy_fault'],
      forbiddenCallees: ['appendEvents', 'appendJobEvents', 'appendWorkflowEvents'],
      forbiddenConstructionPatterns: [
        { keys: ['kind', 'causeRef'] },
        { keys: ['kind', 'fault'] },
      ],
    }),
  ),
  ...entries(
    [
      'src/execution/lifecycle.ts',
      'src/execution/lifecycle/network.ts',
      'src/execution/lifecycle/shutdown-mode.ts',
      'src/execution/lifecycle/shutdown-sequence.ts',
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
  'src/execution/kb-tools.ts': contract(
    'src/kb/**',
    'Phase 5 KB migration',
    KB_ALLOWED,
  ),
  ...entries(
    [
      'src/execution/simulation/index.ts',
      'src/execution/simulation/no-real-io.ts',
      'src/execution/simulation/normalize.ts',
      'src/execution/simulation/recording.ts',
      'src/execution/simulation/runner.ts',
      'src/execution/simulation/scenario-http.ts',
      'src/execution/simulation/schema.ts',
      'src/execution/simulation/world.ts',
      'src/execution/simulation/core/constants.ts',
      'src/execution/simulation/core/index.ts',
      'src/execution/simulation/core/memory-storage.ts',
      'src/execution/simulation/core/mock-app-server.ts',
      'src/execution/simulation/core/mock-app.ts',
      'src/execution/simulation/core/mock-process.ts',
      'src/execution/simulation/core/runtime-doubles.ts',
      'src/execution/simulation/core/virtual-time.ts',
    ],
    contract('src/simulation/**', 'Phase 7 simulation-scenario migration', SIMULATION_ALLOWED),
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

  it('rebuilds projections before startup reconcile/resume ordering in lifecycle.ts', () => {
    const lifecycleSource = readFileSync(join(ROOT, 'src/execution/lifecycle.ts'), 'utf-8');
    const markers = [
      'const cutoffSeq =',
      'rebuildProjections(',
      'jobsReconcile.runStartup(',
      'recoveredDiscussResumes = await (recoverPersistedDiscussFn ?? discussReconcile.runStartup)({',
      'workflowRecover.resumeAll(',
    ];

    let previousIndex = -1;
    for (const marker of markers) {
      const index = lifecycleSource.indexOf(marker);
      expect(index, `Missing lifecycle startup marker: ${marker}`).toBeGreaterThan(-1);
      expect(index, `Lifecycle startup order regressed around ${marker}`).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });
});
