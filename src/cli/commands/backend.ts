import { InvalidArgumentError, type Command } from 'commander';

import { resolveBuildFlavor, type BuildFlavor } from '../../infra/build-flavor.js';
import { assertNever } from '../../infra/error-format.js';
import { createRealRuntime } from '../../runtime/real.js';
import {
  formatLegacyForeignGenerationNotice,
  inspectGenerationReadiness,
  type GenerationReadiness,
} from '../../store/generation-mutation-coordination.js';
import { currentCoralStoreFormat } from '../../store-format.js';
import { getBackendStatusFull, type BackendStatusFull } from '../../transport/http/backend/status.js';
import { shutdownBackend } from '../../transport/http/backend/shutdown.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { formatBackendStatus, formatShutdown } from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import { quarantineKbCommitLocal } from '../kb-commit-quarantine.js';
import { adoptLegacyStoreLocal } from '../store-adopt.js';
import {
  boundStoreResetCliError,
  discardStoreResetLocal,
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
  type StoreResetTarget,
} from '../store-reset.js';

export interface StoreResetCommandOperations {
  list(target: StoreResetTarget): ReturnType<typeof listStoreResetIncidentsLocal>;
  report(target: StoreResetTarget, incidentId: string): ReturnType<typeof reportStoreResetIncidentLocal>;
  discard(target: StoreResetTarget, flavor: BuildFlavor): ReturnType<typeof discardStoreResetLocal>;
}

export interface KbCommitCommandOperations {
  quarantine(
    flavor: BuildFlavor,
    commitId: string,
  ): Promise<{ readonly commitId: string; readonly quarantineDir: string }>;
}

export interface StoreAdoptCommandOperations {
  adopt: typeof adoptLegacyStoreLocal;
}

export interface BackendStatusCommandOperations {
  inspectReadiness(): GenerationReadiness;
  getStatus(): Promise<BackendStatusFull>;
}

export function registerBackendCommands(
  program: Command,
  storeReset: StoreResetCommandOperations = {
    list: listStoreResetIncidentsLocal,
    report: reportStoreResetIncidentLocal,
    discard: discardStoreResetLocal,
  },
  kbCommit: KbCommitCommandOperations = {
    quarantine: quarantineKbCommitLocal,
  },
  storeAdopt: StoreAdoptCommandOperations = {
    adopt: adoptLegacyStoreLocal,
  },
  backendStatus: BackendStatusCommandOperations = {
    inspectReadiness: () =>
      inspectGenerationReadiness(createRealRuntime(resolveBuildFlavor(process.env)), currentCoralStoreFormat()),
    getStatus: () => getBackendStatusFull(getPluginRoot()),
  },
): void {
  const backend = program.command('backend').description('Backend administration and local incident inspection');

  const statusCommand = backend.command('status');
  statusCommand.description('Show backend daemon status').action(async () => {
    try {
      const readiness = backendStatus.inspectReadiness();
      switch (readiness.kind) {
        case 'generated-ready':
        case 'no-legacy':
        case 'legacy-adoptable':
          break;
        case 'legacy-foreign':
          process.stderr.write(`${formatLegacyForeignGenerationNotice(readiness)}\n`);
          break;
        default:
          assertNever(readiness);
      }
      const status = await backendStatus.getStatus();
      process.stdout.write(formatBackendStatus(status) + '\n');
    } catch (error) {
      emitError(error);
    }
  });

  const shutdownCommand = backend.command('shutdown');
  shutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
    try {
      const result = await shutdownBackend(getPluginRoot());
      const text = formatShutdown(result);

      if (result.ok) {
        process.stdout.write(text + '\n');
        return;
      }

      process.stderr.write(text + '\n');
      process.exitCode = 1;
    } catch (error) {
      emitError(error);
    }
  });

  backend
    .command('store-adopt')
    .description('Adopt a same-generation legacy store into the generated state boundary')
    .requiredOption('--flavor <flavor>', 'Generated state flavor (prod or dev)', parseFlavor)
    .action(async (options: { flavor: BuildFlavor }) => {
      try {
        const result = await storeAdopt.adopt(options.flavor);
        if (result.kind === 'no-legacy-source') {
          process.stdout.write(`No legacy ${result.flavor} store exists at ${result.source}.\n`);
          return;
        }
        if (result.kind === 'already-adopted') {
          process.stdout.write(`Legacy ${result.flavor} store was already adopted at ${result.destination}.\n`);
          return;
        }
        process.stdout.write(`Adopted legacy ${result.flavor} store from ${result.source} to ${result.destination}.\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const storeResetCommand = backend.command('store-reset').description('Inspect retained store-reset incidents');
  storeResetCommand
    .command('list')
    .description('List retained store-reset incidents and reportability')
    .requiredOption('--target <target>', 'Store generation to inspect (legacy or gen2)', parseStoreResetTarget)
    .action((options: { target: StoreResetTarget }) => {
      try {
        process.stdout.write(`${formatStoreResetList(storeReset.list(options.target), options.target)}\n`);
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
  storeResetCommand
    .command('report')
    .description('Generate a public-safe store-reset incident report')
    .argument('<incident-id>', 'Canonical lowercase UUID shown by backend store-reset list')
    .requiredOption('--target <target>', 'Store generation to inspect (legacy or gen2)', parseStoreResetTarget)
    .action(async (incidentId: string, options: { target: StoreResetTarget }) => {
      try {
        process.stdout.write(formatStoreResetReport(await storeReset.report(options.target, incidentId)));
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
  storeResetCommand
    .command('discard')
    .description('Quarantine and replace an incompatible generated store under explicit operator control')
    .requiredOption('--target <target>', 'Store generation to discard (legacy or gen2)', parseStoreResetTarget)
    .requiredOption('--flavor <flavor>', 'Store flavor (prod or dev)', parseFlavor)
    .action(async (options: { target: StoreResetTarget; flavor: BuildFlavor }) => {
      try {
        const result = await storeReset.discard(options.target, options.flavor);
        if (result.incident === null) {
          process.stdout.write(`Initialized ${result.target} ${result.flavor} store at ${result.storeDbPath}.\n`);
          return;
        }
        const action = result.resumed ? 'Resumed' : 'Quarantined';
        process.stdout.write(
          `${action} store-reset incident '${result.incident.incidentId}' and initialized ${result.target} ${result.flavor} store at ${result.storeDbPath}.\n`,
        );
      } catch (error: unknown) {
        emitError(error);
      }
    });

  const kbCommitCommand = backend.command('kb-commit').description('Operate on retained blocking KB commit evidence');
  kbCommitCommand
    .command('quarantine')
    .description('Durably quarantine one blocking KB commit and its matching runtime evidence')
    .requiredOption('--flavor <flavor>', 'Generated state flavor (prod or dev)', parseFlavor)
    .requiredOption('--commit <id>', 'Blocking KB commit ID')
    .action(async (options: { flavor: BuildFlavor; commit: string }) => {
      try {
        const result = await kbCommit.quarantine(options.flavor, options.commit);
        process.stdout.write(`Quarantined KB commit '${result.commitId}' at ${result.quarantineDir}.\n`);
      } catch (error: unknown) {
        emitError(error);
      }
    });
}

function parseFlavor(value: string): BuildFlavor {
  if (value === 'prod' || value === 'dev') return value;
  throw new InvalidArgumentError("Flavor must be 'prod' or 'dev'.");
}

function parseStoreResetTarget(value: string): StoreResetTarget {
  if (value === 'legacy' || value === 'gen2') return value;
  throw new InvalidArgumentError("Target must be 'legacy' or 'gen2'.");
}
