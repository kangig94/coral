import type { Command } from 'commander';

import { getBackendStatusFull } from '../../transport/http/backend/status.js';
import { shutdownBackend } from '../../transport/http/backend/shutdown.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { formatBackendStatus, formatShutdown } from '../format/backend.js';

export function registerBackendCommands(program: Command): void {
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
}
