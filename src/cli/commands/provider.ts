import type { Command } from 'commander';

import type { ProviderRegistry } from '../../providers/registry.js';
import { UsageError } from '../errors.js';
import {
  emitError,
  getOutputFormat,
  getProviderNames,
  handleLaunchResult,
  makeClient,
  resolveInput,
  type ProviderRunOptions,
} from '../command-helpers.js';

export function registerProviderCommands(program: Command, providerRegistry: ProviderRegistry): void {
  for (const providerName of getProviderNames(providerRegistry)) {
    const provider = program.command(providerName).description(`${providerName} provider operations`);
    provider
      .argument('[agent]', 'Agent name (omit for raw execution)')
      .option('-i, --input <text-or-file...>', 'Prompt text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)')
      .option('-s, --session <id>', 'Session ID')
      .option('-w, --work-dir <path>', 'Working directory')
      .option('-m, --model <model>', 'Model override')
      .option('-o, --owner <id>', 'Owner ID for memo isolation')
      .option('-b, --bypass-permissions', 'Bypass permission checks')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (agent: string | undefined, opts: ProviderRunOptions) => {
        const outputFormat = getOutputFormat(provider);

        try {
          if (opts.input === undefined) {
            throw new UsageError('input is required (-i, --input)');
          }

          const prompt = resolveInput(opts.input);
          const client = makeClient(process.cwd());
          const requestOptions = {
            ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
            ...(opts.bypassPermissions !== undefined ? { bypassPermissions: opts.bypassPermissions } : {}),
          };
          const result = opts.session
            ? await client.sendMessage(opts.session, prompt, { ...requestOptions, provider: providerName })
            : await client.createSession(
                providerName,
                prompt,
                agent ? { agent, ...requestOptions } : requestOptions,
              );
          await handleLaunchResult(result, opts.detach, outputFormat, client);
        } catch (error) {
          emitError(error, outputFormat);
        }
      });
  }
}
