import { type Command, CommanderError } from 'commander';
import { z } from 'zod';

import { expansionArgsSchema, encodeInstallError, type ExpansionArgs } from '../expansion/contract.js';
import {
  installErrorSchema,
  installResultSchema,
  type InstallError,
  type InstallResponse,
  type InstallResult,
} from '../../expansion/rpc-contract.js';
import { createCliExpansionActivation } from '../expansion/index.js';

const EXPANSION_COMMAND_NAME = 'expansion';

const namedExpansionArgsSchema = expansionArgsSchema.extend({
  name: z.string().min(1),
});

type NamedExpansionArgs = z.infer<typeof namedExpansionArgsSchema>;

const COMMANDER_DISPLAY_ONLY_CODES = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

export class UserInputError extends Error {
  static fromZod(error: z.ZodError): UserInputError {
    return new UserInputError('Expansion command validation failed.', { cause: error });
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UserInputError';
    Object.setPrototypeOf(this, UserInputError.prototype);
  }
}

function expansionExitCode(result: InstallResult | InstallError): number {
  if (result.status !== 'error') {
    return 0;
  }

  return result.code === 'invalid_usage' ? 2 : 1;
}

function writeJsonLineAndExit(line: string, exitCode: number): void {
  if (process.stdout.write(line + '\n')) {
    process.exit(exitCode);
    return;
  }

  process.stdout.once('drain', () => process.exit(exitCode));
}

function emitExpansionJsonLine(result: InstallResult | InstallError): void {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = expansionExitCode(result);
}

function emitExpansionJsonLineAndExit(result: InstallResult | InstallError): void {
  writeJsonLineAndExit(JSON.stringify(result), expansionExitCode(result));
}

function normalizeExpansionResult(result: InstallResponse): InstallResult | InstallError {
  if (result.status === 'error') {
    return installErrorSchema.parse(result);
  }

  return installResultSchema.parse(result);
}

async function runExpansionCommand<TArgs extends ExpansionArgs>(
  rawArgs: TArgs,
  schema: z.ZodType<TArgs>,
  execute: (args: TArgs) => Promise<InstallResponse>,
): Promise<void> {
  try {
    let parsed: TArgs;
    try {
      parsed = schema.parse(rawArgs);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        throw UserInputError.fromZod(error);
      }

      throw error;
    }

    const result = await execute(parsed);
    emitExpansionJsonLine(normalizeExpansionResult(result));
  } catch (error: unknown) {
    emitExpansionJsonLine(encodeInstallError(error));
  }
}

function isExpansionInvocation(argv: readonly string[]): boolean {
  return argv[2] === EXPANSION_COMMAND_NAME;
}

export function isCommanderDisplayOnlyError(error: unknown): error is CommanderError {
  return error instanceof CommanderError && COMMANDER_DISPLAY_ONLY_CODES.has(error.code);
}

export function handleExpansionCommanderFailure(
  error: unknown,
  argv: readonly string[],
  options: { exit?: boolean } = {},
): boolean {
  if (!(error instanceof CommanderError) || isCommanderDisplayOnlyError(error) || !isExpansionInvocation(argv)) {
    return false;
  }

  const encoded = encodeInstallError(error);
  if (options.exit === true) {
    emitExpansionJsonLineAndExit(encoded);
  } else {
    emitExpansionJsonLine(encoded);
  }

  return true;
}

export function registerExpansionCommands(program: Command): void {
  const expansion = program.command(EXPANSION_COMMAND_NAME).description('Manage expansion packages');
  expansion.configureOutput({
    writeErr: () => {},
  });

  expansion
    .command('list')
    .description('List installed and available expansions')
    .action(async () => {
      const activation = createCliExpansionActivation();
      await runExpansionCommand({}, expansionArgsSchema, async () => activation.list());
    });

  expansion
    .command('equip <name>')
    .description('Install or activate an expansion')
    .action(async (name: string) => {
      const activation = createCliExpansionActivation();
      await runExpansionCommand({ name }, namedExpansionArgsSchema, async ({ name: parsedName }: NamedExpansionArgs) =>
        activation.equip(parsedName),
      );
    });

  expansion
    .command('unequip <name>')
    .description('Deactivate and uninstall an expansion')
    .action(async (name: string) => {
      const activation = createCliExpansionActivation();
      await runExpansionCommand({ name }, namedExpansionArgsSchema, async ({ name: parsedName }: NamedExpansionArgs) =>
        activation.unequip(parsedName),
      );
    });

  expansion
    .command('update <name>')
    .description('Update an installed expansion')
    .action(async (name: string) => {
      const activation = createCliExpansionActivation();
      await runExpansionCommand({ name }, namedExpansionArgsSchema, async ({ name: parsedName }: NamedExpansionArgs) =>
        activation.update(parsedName),
      );
    });

  expansion
    .command('info <name>')
    .description('Show expansion metadata and install state')
    .action(async (name: string) => {
      const activation = createCliExpansionActivation();
      await runExpansionCommand({ name }, namedExpansionArgsSchema, async ({ name: parsedName }: NamedExpansionArgs) =>
        activation.info(parsedName),
      );
    });
}
