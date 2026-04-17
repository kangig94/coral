import type { Command } from 'commander';

import { getBackendStatusFull, shutdownBackend } from '../../client/backend-helpers.js';
import {
  emitError,
  getOutputFormat,
  getPluginRoot,
} from '../command-helpers.js';
import { formatBackendStatus, formatShutdown } from '../format.js';

export function registerBackendCommands(program: Command): void {
  const backend = program.command('backend').description('Backend daemon control');

  const backendStatusCommand = backend.command('status');
  backendStatusCommand.description('Show backend daemon status').action(async () => {
    const outputFormat = getOutputFormat(backendStatusCommand);

    try {
      const status = await getBackendStatusFull(getPluginRoot());
      process.stdout.write((outputFormat === 'text' ? formatBackendStatus(status) : JSON.stringify(status)) + '\n');
    } catch (error) {
      emitError(error, outputFormat);
    }
  });

  const backendShutdownCommand = backend.command('shutdown');
  backendShutdownCommand.description('Gracefully shut down backend daemon').action(async () => {
    const outputFormat = getOutputFormat(backendShutdownCommand);

    try {
      const result = await shutdownBackend(getPluginRoot());
      const text = outputFormat === 'text' ? formatShutdown(result) : JSON.stringify(result);

      if (result.ok) {
        process.stdout.write(text + '\n');
        return;
      }

      process.stderr.write(text + '\n');
      process.exitCode = 1;
    } catch (error) {
      emitError(error, outputFormat);
    }
  });
}
