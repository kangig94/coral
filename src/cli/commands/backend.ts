import type { Command } from 'commander';

import { getBackendStatusFull } from '../../transport/http/backend/status.js';
import { shutdownBackend } from '../../transport/http/backend/shutdown.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { formatBackendStatus, formatShutdown } from '../format/backend.js';
import { formatStoreResetList, formatStoreResetReport } from '../format/store-reset.js';
import {
  boundStoreResetCliError,
  listStoreResetIncidentsLocal,
  reportStoreResetIncidentLocal,
} from '../store-reset.js';

export interface StoreResetCommandOperations {
  list(): ReturnType<typeof listStoreResetIncidentsLocal>;
  report(incidentId: string): ReturnType<typeof reportStoreResetIncidentLocal>;
}

export function registerBackendCommands(
  program: Command,
  storeReset: StoreResetCommandOperations = {
    list: listStoreResetIncidentsLocal,
    report: reportStoreResetIncidentLocal,
  },
): void {
  const backend = program.command('backend').description('Backend daemon control');

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

  const storeResetCommand = backend.command('store-reset').description('Inspect retained store-reset incidents');
  storeResetCommand
    .command('list')
    .description('List current-build store-reset incidents')
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
    .argument('<incident-id>')
    .action(async (incidentId: string) => {
      try {
        process.stdout.write(formatStoreResetReport(await storeReset.report(incidentId)));
      } catch (error: unknown) {
        emitError(boundStoreResetCliError(error));
      }
    });
}
