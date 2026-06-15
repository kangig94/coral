import type { Command } from 'commander';

import type { ProviderRegistry } from '../../providers/registry.js';
import { markProviderCommand } from '../classify.js';
import { UsageError } from '../errors.js';
import { getProviderNames, makeClient, type ProviderRunOptions } from '../dispatch.js';
import { emitError, handleLaunchResult } from '../emit.js';
import { resolveInput } from '../flags.js';

export function registerProviderCommands(program: Command, providerRegistry: ProviderRegistry): void {
  for (const providerName of getProviderNames(providerRegistry)) {
    const provider = program.command(providerName).description(`Run a prompt via ${providerName}`);
    markProviderCommand(provider);
    provider
      .argument('[agent]', 'Agent name (optional; omit for a raw prompt run)')
      .option(
        '-i, --input <text-or-file...>',
        'Prompt text or file path (multiple tokens are joined with spaces; a single existing path is read as a file)',
      )
      .option('-w, --work-dir <path>', 'Working directory')
      .option('-m, --model <model>', 'Model override')
      .option('-o, --owner <id>', 'Owner ID for memo isolation')
      .option('-b, --bypass-permissions', 'Bypass permission checks')
      .option('-d, --detach', 'Return launch decision without waiting')
      .action(async (agent: string | undefined, opts: ProviderRunOptions) => {
        try {
          if (opts.input === undefined) {
            throw new UsageError('input is required (-i, --input)');
          }

          const prompt = resolveInput(opts.input);
          const client = makeClient(process.cwd(), provider);
          const requestOptions = {
            ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
            ...(opts.bypassPermissions !== undefined ? { bypassPermissions: opts.bypassPermissions } : {}),
          };
          const result = await client.createSession(providerName, prompt, {
            retention: 'discard_provider_artifacts_on_terminal',
            ...(agent !== undefined ? { agent } : {}),
            ...requestOptions,
          });
          await handleLaunchResult(result, opts.detach, client);
        } catch (error) {
          emitError(error);
        }
      });
  }
}
