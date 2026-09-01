declare const __VERSION__: string;

import { Command } from 'commander';

import {
  HandoffRunError,
  consumeHandoffRunResult,
  runHandoff,
  type HandoffOutcome,
  type HandoffPublicationIncident,
  type HandoffRunResult,
  type LiveHandoffResult,
} from '../coordinator/handoff-routing/runner.js';
import { assertNever } from '../infra/error-format.js';
import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { assertCommandClassCoverage } from './classify.js';
import {
  createBackendStatusCommandOperations,
  createRecoveryQuarantineCommandOperations,
  handoffPublicationIncidentsExitContribution,
  registerBackendCommands,
} from './commands/backend.js';
import { createStoreResetCommandOperations } from './store-reset.js';
import { errorCodeToExit } from './errors.js';
import { formatHandoffStartupObservationAborted } from './format/backend.js';
import { registerDiscussCommands } from './commands/discuss.js';
import { registerExpansionCommands } from './commands/expansion.js';
import { registerKbCommands } from './commands/kb.js';
import { registerProviderCommands } from './commands/provider.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { renderHandoffNotice, renderHandoffPublicationIncidents } from './handoff-notice.js';
import { resolvePluginRoot } from './plugin-root.js';

type CliHandoffOutcome = Exclude<HandoffOutcome, { kind: 'handoff-startup-observation-aborted' }>;

let cliHandoffPreflightPromise: Promise<CliHandoffOutcome | null> | null = null;
let cliHandoffPreflightResult: LiveHandoffResult | null = null;

async function executeCliHandoffPreflight(argv: readonly string[]): Promise<CliHandoffOutcome | null> {
  const statusInvocation = argv[2] === 'backend' && argv[3] === 'status';
  let result: HandoffRunResult;
  try {
    result = await runHandoff(
      { kind: 'cli-invocation', argv },
      {
        pluginRoot: resolvePluginRoot(),
        ...(statusInvocation
          ? {}
          : { onSelectionPublicationIncident: (incident) => renderHandoffPublicationIncidents([incident]) }),
      },
    );
  } catch (error: unknown) {
    if (!(error instanceof HandoffRunError)) throw error;
    renderHandoffPublicationIncidents(
      statusInvocation ? error.incidents : error.incidents.filter((incident) => incident.phase === 'terminal'),
    );
    throw error.originalError;
  }

  let publicationIncidents: readonly HandoffPublicationIncident[] = [];
  const continuation = consumeHandoffRunResult(result, (incidents) => {
    publicationIncidents = incidents;
    renderHandoffPublicationIncidents(
      statusInvocation ? incidents : incidents.filter((incident) => incident.phase === 'terminal'),
    );
  });

  switch (continuation.kind) {
    case 'run-current':
      cliHandoffPreflightResult = { continuation, publicationIncidents };
      return null;
    case 'delegated': {
      const { outcome } = continuation;
      switch (outcome.kind) {
        case 'handoff-success':
          renderHandoffNotice(outcome);
          return statusInvocation && publicationIncidents.length > 0
            ? { kind: 'handoff-exit', exitCode: handoffPublicationIncidentsExitContribution(publicationIncidents) }
            : outcome;
        case 'handoff-startup-observation-aborted':
          process.stderr.write(`${formatHandoffStartupObservationAborted(outcome)}\n`);
          return { kind: 'handoff-exit', exitCode: errorCodeToExit('transient') };
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

export function runCliHandoffPreflight(argv: readonly string[] = process.argv): Promise<CliHandoffOutcome | null> {
  cliHandoffPreflightPromise ??= executeCliHandoffPreflight(argv);
  return cliHandoffPreflightPromise;
}

export function peekCliHandoffPreflightResult(): LiveHandoffResult | null {
  return cliHandoffPreflightResult;
}

export async function parseProgramWithHandoff(
  program: Command,
  argv: readonly string[] = process.argv,
): Promise<CliHandoffOutcome | null> {
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
    backendStatus: createBackendStatusCommandOperations(() => peekCliHandoffPreflightResult()),
    recoveryQuarantine: createRecoveryQuarantineCommandOperations(options.shutdownSignal),
  });
  registerDiscussCommands(program);
  registerKbCommands(program);
  registerExpansionCommands(program);
  assertCommandClassCoverage(program);

  return program;
}
