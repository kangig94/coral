import type { Command } from 'commander';

import {
  discussBidSchema,
  discussSeedSchema,
  discussSpeechSchema,
  discussStartSchema,
} from '../../discuss/command-schemas.js';
import {
  makeClient,
  type DiscussAbortOptions,
  type DiscussParticipateOptions,
  type DiscussSeedOptions,
  type DiscussStartOptions,
  type DiscussWatchOptions,
} from '../dispatch.js';
import { emitError } from '../emit.js';
import { normalizeUsageError } from '../errors.js';
import { parseIntegerFlag } from '../flags.js';
import {
  formatDiscussAbort,
  formatDiscussParticipate,
  formatDiscussStart,
  formatDiscussWatch,
  formatPersonaSeed,
} from '../format/discuss.js';
import { parseAgentSpec, parseAxisSpec, parseInputJson, type JsonObject } from '../parse.js';

export function registerDiscussCommands(program: Command): void {
  const discuss = program.command('discuss').description('Discussion operations');

  const discussSeedCommand = discuss.command('seed');
  discussSeedCommand
    .description('Generate discussion personas')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--axis <spec>', 'Controversy axis spec (repeatable)', (value: string, previous: string[] | undefined) => [
      ...(previous ?? []),
      value,
    ])
    .option('--count <n>', 'Number of personas')
    .option('--seed <n>', 'Random seed')
    .action(async (opts: DiscussSeedOptions) => {
      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const axes = opts.axis?.map(parseAxisSpec);
        const args = {
          ...stdinBase,
          ...(opts.count !== undefined ? { n: parseIntegerFlag('--count', opts.count) } : {}),
          ...(opts.seed !== undefined ? { seed: parseIntegerFlag('--seed', opts.seed) } : {}),
          ...(axes !== undefined ? { controversy_axes: axes } : {}),
        };
        discussSeedSchema.parse(args);
        const client = makeClient(process.cwd(), discussSeedCommand);
        const result = await client.discussSeed(args as Parameters<typeof client.discussSeed>[0]);
        process.stdout.write(formatPersonaSeed(result) + '\n');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });

  const discussStartCommand = discuss.command('start');
  discussStartCommand
    .description('Start a discussion; binds only the provider profiles used by its agents')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--agent <spec>', 'Agent spec (repeatable)', (value: string, previous: string[] | undefined) => [
      ...(previous ?? []),
      value,
    ])
    .option('--topic <text>', 'Discussion topic')
    .action(async (opts: DiscussStartOptions) => {
      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const agents = opts.agent?.map(parseAgentSpec);
        const args = {
          ...stdinBase,
          ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
          ...(agents !== undefined ? { agents } : {}),
        };
        discussStartSchema.parse(args);
        const client = makeClient(process.cwd(), discussStartCommand);
        const result = await client.discussStart(args as Parameters<typeof client.discussStart>[0]);
        process.stdout.write(formatDiscussStart(result) + '\n');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });

  const discussWatchCommand = discuss.command('watch');
  discussWatchCommand
    .description('Fetch discussion events since cursor (returns new events; increment cursor for next call)')
    .requiredOption('--session <id>', 'Session ID')
    .option('--cursor <seq>', 'Resume from sequence number (integer event offset)')
    .action(async (opts: DiscussWatchOptions) => {
      try {
        const cursor = opts.cursor !== undefined ? parseIntegerFlag('--cursor', opts.cursor) : undefined;
        const client = makeClient(process.cwd(), discussWatchCommand);
        const result = await client.discussWatch(opts.session, cursor);
        process.stdout.write(formatDiscussWatch(result) + '\n');
      } catch (error) {
        emitError(error);
      }
    });

  const discussParticipateCommand = discuss.command('participate');
  discussParticipateCommand
    .description('Submit bid or speech')
    .option('--input-json <source>', 'JSON payload from stdin (use -)')
    .option('--session <id>', 'Session ID')
    .option('--agent-name <name>', 'Agent name')
    .option('--score <n>', 'Bid score (0-100)')
    .option('--thought <text>', 'Bid thought')
    .option('--content <text>', 'Speech content')
    .action(async (opts: DiscussParticipateOptions) => {
      try {
        const stdinBase: JsonObject = await parseInputJson(opts.inputJson);
        const args = {
          ...stdinBase,
          ...(opts.session !== undefined ? { session: opts.session } : {}),
          ...(opts.agentName !== undefined ? { agent_name: opts.agentName } : {}),
          ...(opts.score !== undefined ? { score: parseIntegerFlag('--score', opts.score) } : {}),
          ...(opts.thought !== undefined ? { thought: opts.thought } : {}),
          ...(opts.content !== undefined ? { content: opts.content } : {}),
        };
        const isSpeech = 'content' in args;
        if (isSpeech) {
          discussSpeechSchema.parse(args);
        } else {
          discussBidSchema.parse(args);
        }
        const client = makeClient(process.cwd(), discussParticipateCommand);
        const result = isSpeech
          ? await client.discussSpeech(args as Parameters<typeof client.discussSpeech>[0])
          : await client.discussBid(args as Parameters<typeof client.discussBid>[0]);
        process.stdout.write(formatDiscussParticipate(result) + '\n');
      } catch (error) {
        emitError(normalizeUsageError(error));
      }
    });

  const discussAbortCommand = discuss.command('abort');
  discussAbortCommand
    .description('Abort a discussion session')
    .requiredOption('--session <id>', 'Session ID')
    .action(async (opts: DiscussAbortOptions) => {
      try {
        const client = makeClient(process.cwd(), discussAbortCommand);
        const result = await client.discussAbort(opts.session);
        process.stdout.write(formatDiscussAbort(result) + '\n');
      } catch (error) {
        emitError(error);
      }
    });
}
