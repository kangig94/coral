import { InvalidArgumentError, type Command } from 'commander';

import type { BuildFlavor } from '../../infra/build-flavor.js';
import { getBackendStatusFull } from '../../transport/http/backend/status.js';
import { shutdownBackend } from '../../transport/http/backend/shutdown.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { formatBackendStatus, formatShutdown } from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import { quarantineKbCommitLocal } from '../kb-commit-quarantine.js';
import { adoptLegacyStoreLocal } from '../store-adopt.js';
import {
  boundStoreResetCliError,
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
} from '../store-reset.js';

export interface StoreResetCommandOperations {
  list(): ReturnType<typeof listStoreResetIncidentsLocal>;
  report(incidentId: string): ReturnType<typeof reportStoreResetIncidentLocal>;
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

export function registerBackendCommands(
  program: Command,
  storeReset: StoreResetCommandOperations = {
    list: listStoreResetIncidentsLocal,
    report: reportStoreResetIncidentLocal,
  },
  kbCommit: KbCommitCommandOperations = {
    quarantine: quarantineKbCommitLocal,
  },
  storeAdopt: StoreAdoptCommandOperations = {
    adopt: adoptLegacyStoreLocal,
  },
): void {
  const backend = program.command('backend').description('Backend administration and local incident inspection');

  const statusCommand = backend.command('status');
  statusCommand.description('Show backend daemon status').action(async () => {
    try {
      const status = await getBackendStatusFull(getPluginRoot());
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
    .action(() => {
      try {
        process.stdout.write(`${formatStoreResetList(storeReset.list())}\n`);
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
  storeResetCommand
    .command('report')
    .description('Generate a public-safe store-reset incident report')
    .argument('<incident-id>', 'Canonical lowercase UUID shown by backend store-reset list')
    .action(async (incidentId: string) => {
      try {
        process.stdout.write(formatStoreResetReport(await storeReset.report(incidentId)));
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
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
