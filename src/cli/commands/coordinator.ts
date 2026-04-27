import type { Command } from 'commander';

import { getCoordinatorStatusFull } from '../../transport/http/coordinator/status.js';
import { shutdownCoordinator } from '../../transport/http/coordinator/shutdown.js';
import { getPluginRoot } from '../dispatch.js';
import { emitError } from '../emit.js';
import { formatCoordinatorStatus, formatShutdown } from '../format.js';

export function registerCoordinatorCommands(program: Command): void {
  const coordinator = program.command('coordinator').description('Coordinator daemon control');

  const statusCommand = coordinator.command('status');
  statusCommand.description('Show coordinator daemon status').action(async () => {
    try {
      const status = await getCoordinatorStatusFull(getPluginRoot());
      process.stdout.write(formatCoordinatorStatus(status) + '\n');
    } catch (error) {
      emitError(error);
    }
  });

  const shutdownCommand = coordinator.command('shutdown');
  shutdownCommand.description('Gracefully shut down coordinator daemon').action(async () => {
    try {
      const result = await shutdownCoordinator(getPluginRoot());
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
