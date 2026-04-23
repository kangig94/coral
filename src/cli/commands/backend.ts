import type { Command } from 'commander';

import { getBackendStatusFull, shutdownBackend } from '../../transport/http/backend-helpers.js';
import {
  emitError,
  getPluginRoot,
} from '../command-helpers.js';
import { formatBackendStatus, formatShutdown } from '../format.js';

export function registerBackendCommands(program: Command): void {
  const backend = program.command('backend').description('Backend daemon control');

  const backendStatusCommand = backend.command('status');
  backendStatusCommand.description('Show backend daemon status').action(async () => {
    try {
      const status = await getBackendStatusFull(getPluginRoot());
      process.stdout.write(formatBackendStatus(status) + '\n');
    } catch (error) {
      emitError(error);
    }
  });

  const backendShutdownCommand = backend.command('shutdown');
  backendShutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
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
}
