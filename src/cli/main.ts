declare const __VERSION__: string;

import { Command } from 'commander';

import { createBuiltInProviderRegistry } from '../providers/bootstrap.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { assertCommandClassCoverage } from './command-class-map.js';
import { registerBackendCommands } from './commands/backend.js';
import { registerDiscussCommands } from './commands/discuss.js';
import { registerExpansionCommands } from './commands/expansion.js';
import { registerKbCommands } from './commands/kb.js';
import { registerProviderCommands } from './commands/provider.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { emitError } from './command-output.js';

export { emitAcceptedLaunchResponse, emitError, getOutputFormat, isAcceptedLaunchResponse } from './command-output.js';

export function buildProgram(providerRegistry: ProviderRegistry = createBuiltInProviderRegistry()): Command {
  const program = new Command();
  program.exitOverride();

  program
    .name('coral-cli')
    .version(typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0')
    .description('Coral CLI — invoke providers, monitor jobs, and manage discuss sessions');

  registerProviderCommands(program, providerRegistry);
  registerSessionCommands(program, providerRegistry);
  registerWorkflowCommands(program);
  registerBackendCommands(program);
  registerDiscussCommands(program);
  registerKbCommands(program);
  registerExpansionCommands(program);
  assertCommandClassCoverage(program);

  return program;
}
