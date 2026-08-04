declare const __VERSION__: string;

import { Command } from 'commander';
import { z } from 'zod';

import { resolveCliHandoffPreflightRouting, runHandoff, type HandoffOutcome } from '../coordinator/handoff-runner.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import { assertNever } from '../infra/error-format.js';
import { UsageError } from './errors.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { createRealRuntime } from '../runtime/real.js';
import { assertCommandClassCoverage } from './classify.js';
import { createRecoveryQuarantineCommandOperations, registerBackendCommands } from './commands/backend.js';
import { createStoreResetCommandOperations } from './store-reset.js';
import { registerDiscussCommands } from './commands/discuss.js';
import { registerExpansionCommands } from './commands/expansion.js';
import { registerKbCommands } from './commands/kb.js';
import { registerProviderCommands } from './commands/provider.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { renderHandoffNotice } from './handoff-notice.js';
import { resolvePluginRoot } from './plugin-root.js';

export const CLI_HANDOFF_GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';

const cliHandoffGuardSchema = z.enum(['0', '1']).optional();

/**
 * Display-only invocations produce no backend work, so delegating them buys nothing and costs an incumbent
 * health probe on the path users expect to be instant. Sniffing argv is the only option: Commander has not
 * parsed yet at pre-flight time.
 */
function isDisplayOnlyInvocation(argv: readonly string[]): boolean {
  return argv.slice(2).some((argument) => argument === '--help' || argument === '-h' || argument === '--version');
}

function readCliHandoffGuard(): '0' | '1' | undefined {
  const raw = process.env[CLI_HANDOFF_GUARD_ENV];
  const parsed = cliHandoffGuardSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  // A raw ZodError here reaches the user as a `code=internal` dump of issue JSON that never names the
  // variable — and `export CORAL_CLI_HANDOFF_DELEGATED=` (declared but empty) is enough to trigger it.
  throw new UsageError(
    `${CLI_HANDOFF_GUARD_ENV} must be "0", "1", or unset (got ${JSON.stringify(raw)}). ` +
      `Coral sets it itself when it delegates to a newer build; unset it or set it to 0.`,
  );
}

let cliHandoffPreflightPromise: Promise<HandoffOutcome | null> | null = null;

async function executeCliHandoffPreflight(argv: readonly string[]): Promise<HandoffOutcome | null> {
  const guard = readCliHandoffGuard();
  if (isDisplayOnlyInvocation(argv)) {
    return null;
  }

  const routing = await resolveCliHandoffPreflightRouting(resolvePluginRoot());

  switch (routing.kind) {
    case 'use-current':
    case 'reset-newer-invalid':
      return null;
    case 'handoff': {
      if (guard === '1') {
        // Genuinely internal — two builds pointing at each other — so `code=internal` and exit 70 are right.
        // The guidance lives in the message because that envelope carries no remediation field.
        throw new Error(
          'This Coral build already delegated once and refuses a second delegation, which means two builds ' +
            "are handing off to each other. Run 'coral-cli backend status' and report that output; unsetting " +
            `${CLI_HANDOFF_GUARD_ENV} lets this invocation retry once.`,
        );
      }

      const outcome = await runHandoff({
        runtime: createRealRuntime(resolveBuildFlavor(process.env)),
        target: routing.target,
        operation: {
          entrypoint: 'cli',
          args: argv.slice(2),
          envAdditions: { [CLI_HANDOFF_GUARD_ENV]: '1' },
        },
      });

      switch (outcome.kind) {
        case 'handoff-success':
          renderHandoffNotice(outcome);
          return outcome;
        case 'handoff-exit':
        case 'handoff-signal':
          return outcome;
        default:
          return assertNever(outcome);
      }
    }
    default:
      return assertNever(routing);
  }
}

export function runCliHandoffPreflight(argv: readonly string[] = process.argv): Promise<HandoffOutcome | null> {
  cliHandoffPreflightPromise ??= executeCliHandoffPreflight(argv);
  return cliHandoffPreflightPromise;
}

export async function parseProgramWithHandoff(
  program: Command,
  argv: readonly string[] = process.argv,
): Promise<HandoffOutcome | null> {
  const handoff = await runCliHandoffPreflight(argv);
  if (handoff !== null) {
    return handoff;
  }

  await program.parseAsync([...argv]);
  return null;
}

export function buildProgram(
  providerRegistry: ProviderRegistry = createBuiltInProviderRegistry(),
  options: { readonly shutdownSignal?: AbortSignal } = {},
): Command {
  const program = new Command();
  program.exitOverride();

  program
    .name('coral-cli')
    .version(typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0')
    .description('Coral CLI — invoke providers, monitor jobs, and manage discuss sessions');

  registerProviderCommands(program, providerRegistry);
  registerSessionCommands(program, providerRegistry);
  registerWorkflowCommands(program);
  registerBackendCommands(program, {
    storeReset: createStoreResetCommandOperations(options.shutdownSignal),
    recoveryQuarantine: createRecoveryQuarantineCommandOperations(options.shutdownSignal),
  });
  registerDiscussCommands(program);
  registerKbCommands(program);
  registerExpansionCommands(program);
  assertCommandClassCoverage(program);

  return program;
}
