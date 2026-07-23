declare const __VERSION__: string;

import { Command } from 'commander';

import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { assertCommandClassCoverage } from './classify.js';
import { registerBackendCommands } from './commands/backend.js';
import { createStoreResetCommandOperations } from './store-reset.js';
import { registerDiscussCommands } from './commands/discuss.js';
import { registerExpansionCommands } from './commands/expansion.js';
import { registerKbCommands } from './commands/kb.js';
import { registerProviderCommands } from './commands/provider.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkflowCommands } from './commands/workflow.js';

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
  registerBackendCommands(program, createStoreResetCommandOperations(options.shutdownSignal));
  registerDiscussCommands(program);
  registerKbCommands(program);
  registerExpansionCommands(program);
  assertCommandClassCoverage(program);

  return program;
}
