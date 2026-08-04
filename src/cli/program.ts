declare const __VERSION__: string;

import { Command } from 'commander';

import { runHandoff, type HandoffOutcome } from '../coordinator/handoff-runner.js';
import { assertNever } from '../infra/error-format.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
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

let cliHandoffPreflightPromise: Promise<HandoffOutcome | null> | null = null;

async function executeCliHandoffPreflight(argv: readonly string[]): Promise<HandoffOutcome | null> {
  const continuation = await runHandoff({ kind: 'cli-invocation', argv }, { pluginRoot: resolvePluginRoot() });
  switch (continuation.kind) {
    case 'run-current':
      return null;
    case 'delegated': {
      const { outcome } = continuation;
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
      return assertNever(continuation);
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
