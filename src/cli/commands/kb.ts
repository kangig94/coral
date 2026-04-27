import { readFileSync } from 'node:fs';
import { Option } from 'commander';
import type { Command } from 'commander';

import type { KbPromoteInput } from '../../kb/entry-types.js';
import { assertSourceSlug } from '../../kb/validation.js';
import { assertOwnerId } from '../../infra/identifiers.js';
import { UsageError } from '../errors.js';
import {
  makeClient,
  type KbMemoDeleteOptions,
  type KbMemoListOptions,
  type KbMemoPurgeOptions,
  type KbMemoWriteOptions,
  type KbPrinciplesOptions,
  type KbPromoteOptions,
  type KbSearchOptions,
  type KbSourceImportOptions,
  type KbUpdateOptions,
} from '../dispatch.js';
import { emit, emitError, getCliDisplayPrefix, getOutputFormat } from '../emit.js';
import { parseIntegerFlag, resolveFilePath } from '../flags.js';
import {
  formatKbDelete,
  formatKbDiagnose,
  formatKbMemo,
  formatKbMemoDelete,
  formatKbMemoList,
  formatKbMemoPurge,
  formatKbPrinciples,
  formatKbPromote,
  formatKbRead,
  formatKbReindex,
  formatKbSearch,
  formatKbSourceDelete,
  formatKbSourceImport,
  formatKbSourceList,
  formatKbUpdate,
} from '../format/kb.js';

function registerKbSourceCommands(kb: Command): void {
  const kbSourceCommand = kb.command('source').description('Manage KB sources');

  const kbSourceImportCommand = kbSourceCommand.command('import');
  kbSourceImportCommand
    .description('Import a source file into the KB')
    .argument('<file>', 'File to import')
    .option('--slug <slug>', 'Override source slug')
    .addOption(
      new Option('--ready <readiness>', 'Readiness to wait for')
        .choices(['commit', 'base-search', 'active-vector', 'all-equipped'])
        .default('base-search'),
    )
    .option('--async', 'Return after launching the import job')
    .action(async (file: string, opts: KbSourceImportOptions) => {
      const outputFormat = getOutputFormat(kbSourceImportCommand);

      try {
        const client = makeClient(process.cwd(), kbSourceImportCommand);
        const result = await client.kbSourceImport({
          filePath: resolveFilePath(file),
          ...(opts.slug === undefined ? {} : { slug: opts.slug }),
          readiness: opts.ready ?? 'base-search',
          async: opts.async === true,
        });
        emit(result, outputFormat, formatKbSourceImport);
      } catch (error) {
        emitError(error);
      }
    });

  const kbSourceListCommand = kbSourceCommand.command('list');
  kbSourceListCommand.description('List KB sources').action(async () => {
    const outputFormat = getOutputFormat(kbSourceListCommand);

    try {
      const client = makeClient(process.cwd(), kbSourceListCommand);
      const result = await client.kbSourceList();
      emit(result, outputFormat, formatKbSourceList);
    } catch (error) {
      emitError(error);
    }
  });

  const kbSourceDeleteCommand = kbSourceCommand.command('delete');
  kbSourceDeleteCommand
    .description('Delete a KB source')
    .argument('<slug>', 'Source slug without extension')
    .action(async (slug: string) => {
      const outputFormat = getOutputFormat(kbSourceDeleteCommand);

      try {
        const client = makeClient(process.cwd(), kbSourceDeleteCommand);
        const result = await client.kbSourceDelete({ slug: assertSourceSlug(slug, 'source') });
        emit(result, outputFormat, formatKbSourceDelete);
      } catch (error) {
        emitError(error);
      }
    });
}

function registerKbMemoCommands(kb: Command): void {
  const kbMemoCommand = kb.command('memo').description('Manage project memos');

  const kbMemoWriteCommand = kbMemoCommand.command('write');
  kbMemoWriteCommand
    .description('Write a memo with auto-generated timestamp and frontmatter')
    .requiredOption('--topic <slug>', 'Kebab-case topic slug (e.g. orama-threshold)')
    .option('--content <text>', 'Memo body text')
    .option('--content-file <path>', 'Read memo body from file')
    .option('--owner <id>', 'Session owner ID (falls back to CORAL_OWNER env var)')
    .action(async (opts: KbMemoWriteOptions) => {
      const outputFormat = getOutputFormat(kbMemoWriteCommand);

      try {
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : opts.content;
        if (content === undefined) {
          throw new UsageError('Either --content or --content-file is required');
        }
        const rawOwner = opts.owner ?? process.env.CORAL_OWNER;
        if (!rawOwner) {
          throw new UsageError('--owner is required (or set CORAL_OWNER env var)');
        }
        const owner = assertOwnerId(rawOwner, 'owner');
        const client = makeClient(process.cwd(), kbMemoWriteCommand);
        const result = await client.kbMemo({ topic: opts.topic, content, owner });
        emit(result, outputFormat, formatKbMemo);
      } catch (error) {
        emitError(error);
      }
    });

  const kbMemoListCommand = kbMemoCommand.command('list');
  kbMemoListCommand
    .description('List project memos')
    .option('--owner <id>', 'Filter by owner session ID')
    .action(async (opts: KbMemoListOptions) => {
      const outputFormat = getOutputFormat(kbMemoListCommand);

      try {
        const client = makeClient(process.cwd(), kbMemoListCommand);
        const result = await client.kbMemoList({ owner: opts.owner });
        emit(result, outputFormat, formatKbMemoList);
      } catch (error) {
        emitError(error);
      }
    });

  const kbMemoDeleteCommand = kbMemoCommand.command('delete');
  kbMemoDeleteCommand
    .description('Delete project memos by simple glob pattern')
    .argument('<pattern>', 'Simple glob pattern (supports * and ?)')
    .option('--owner <id>', 'Only delete memos owned by this session ID')
    .action(async (pattern: string, opts: KbMemoDeleteOptions) => {
      const outputFormat = getOutputFormat(kbMemoDeleteCommand);

      try {
        const client = makeClient(process.cwd(), kbMemoDeleteCommand);
        const result = await client.kbMemoDelete({ pattern, owner: opts.owner });
        emit(result, outputFormat, formatKbMemoDelete);
      } catch (error) {
        emitError(error);
      }
    });

  const kbMemoPurgeCommand = kbMemoCommand.command('purge');
  kbMemoPurgeCommand
    .description('Delete all project memos')
    .option('--owner <owner>', 'Only purge memos owned by this session')
    .action(async (opts: KbMemoPurgeOptions) => {
      const outputFormat = getOutputFormat(kbMemoPurgeCommand);

      try {
        const client = makeClient(process.cwd(), kbMemoPurgeCommand);
        const result = await client.kbMemoPurge(opts.owner ? { owner: opts.owner } : {});
        emit(result, outputFormat, formatKbMemoPurge);
      } catch (error) {
        emitError(error);
      }
    });
}

export function registerKbCommands(program: Command): void {
  const cliPrefix = getCliDisplayPrefix();
  const kb = program.command('kb').description('Knowledge base operations');
  kb.addOption(
    new Option('-f, --output-format <format>', 'Output format').choices(['text', 'json']).default('text'),
  );

  const kbSearchCommand = kb.command('search');
  kbSearchCommand
    .description('Search KB entries')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Maximum results (default: 20)')
    .option('--vector', 'Force vector-only search (requires embedding backend)')
    .option('--hybrid', 'Force hybrid search (requires embedding backend)')
    .addOption(
      new Option('--scope <scope>', 'Limit results to notes, communities, sources, or all').choices([
        'notes',
        'communities',
        'sources',
        'all',
      ]),
    )
    .action(async (query: string, opts: KbSearchOptions) => {
      const outputFormat = getOutputFormat(kbSearchCommand);

      try {
        if (opts.vector === true && opts.hybrid === true) {
          throw new UsageError('Choose at most one of --vector or --hybrid');
        }

        const args = {
          query,
          ...(opts.topK !== undefined ? { top_k: parseIntegerFlag('--top-k', opts.topK) } : {}),
          ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
          ...(opts.vector === true ? { mode: 'vector' as const } : {}),
          ...(opts.hybrid === true ? { mode: 'hybrid' as const } : {}),
        };
        const client = makeClient(process.cwd(), kbSearchCommand);
        const result = await client.kbSearch(args);
        emit(result, outputFormat, (data) => formatKbSearch(data, cliPrefix));
      } catch (error) {
        emitError(error);
      }
    });

  const kbDiagnoseCommand = kb.command('diagnose');
  kbDiagnoseCommand
    .description('Show KB entries with pending manual repair actions')
    .action(async () => {
      const outputFormat = getOutputFormat(kbDiagnoseCommand);

      try {
        const client = makeClient(process.cwd(), kbDiagnoseCommand);
        const result = await client.kbDiagnose({});
        emit(result, outputFormat, formatKbDiagnose);
      } catch (error) {
        emitError(error);
      }
    });

  const kbPrinciplesCommand = kb.command('principles');
  kbPrinciplesCommand
    .description('List KB principles')
    .option('--query <text>', 'Filter principle names')
    .option('--top-k <n>', 'Maximum results')
    .option('--verbose', 'Include canonical statements and referring note slugs')
    .action(async (opts: KbPrinciplesOptions) => {
      const outputFormat = getOutputFormat(kbPrinciplesCommand);

      try {
        const args = {
          ...(opts.query !== undefined ? { query: opts.query } : {}),
          ...(opts.topK !== undefined ? { top_k: parseIntegerFlag('--top-k', opts.topK) } : {}),
          ...(opts.verbose === true ? { verbose: true } : {}),
        };
        const client = makeClient(process.cwd(), kbPrinciplesCommand);
        const result = await client.kbPrinciples(args);
        emit(result, outputFormat, (data) => formatKbPrinciples(data, cliPrefix));
      } catch (error) {
        emitError(error);
      }
    });

  registerKbSourceCommands(kb);
  registerKbMemoCommands(kb);

  const kbReadCommand = kb.command('read');
  kbReadCommand
    .description('Read a KB entry by slug or explicit selector')
    .argument(
      '<note>',
      'Bare reads resolve memo -> note -> community -> source -> principle; use communities:<slug> or sources:<slug> to force a kind',
    )
    .action(async (note: string) => {
      const outputFormat = getOutputFormat(kbReadCommand);

      try {
        const client = makeClient(process.cwd(), kbReadCommand);
        const result = await client.kbRead({ note });
        emit(result, outputFormat, formatKbRead);
      } catch (error) {
        emitError(error);
      }
    });

  const kbPromoteCommand = kb.command('promote');
  kbPromoteCommand
    .description('Promote a memo into a KB note')
    .option('--memo <filename>', 'Memo filename (e.g. 20260325-topic.md)')
    .option('--title <text>', 'Note title')
    .option('--content-file <path>', 'Read content from file')
    .option('--domain <slug>', 'Note domain')
    .option('--topic <slug>', 'Note topic')
    .action(async (opts: KbPromoteOptions) => {
      const outputFormat = getOutputFormat(kbPromoteCommand);

      try {
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : undefined;
        const args = {
          ...(opts.memo !== undefined ? { memo: opts.memo } : {}),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(content !== undefined ? { content } : {}),
          ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
          ...(opts.topic !== undefined ? { topic: opts.topic } : {}),
        };
        const client = makeClient(process.cwd(), kbPromoteCommand);
        const result = await client.kbPromote(args as KbPromoteInput);
        emit(result, outputFormat, formatKbPromote);
      } catch (error) {
        emitError(error);
      }
    });

  const kbUpdateCommand = kb.command('update');
  kbUpdateCommand
    .description('Update an existing KB note')
    .argument('<note>', 'Note slug without extension (e.g. rendering-guiding-contracts)')
    .option('--title <text>', 'Updated title')
    .option('--content-file <path>', 'Read content from file')
    .action(async (note: string, opts: KbUpdateOptions) => {
      const outputFormat = getOutputFormat(kbUpdateCommand);

      try {
        const content =
          opts.contentFile !== undefined ? readFileSync(resolveFilePath(opts.contentFile), 'utf8') : undefined;
        const args = {
          note,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(content !== undefined ? { content } : {}),
        };
        const client = makeClient(process.cwd(), kbUpdateCommand);
        const result = await client.kbUpdate(args);
        emit(result, outputFormat, formatKbUpdate);
      } catch (error) {
        emitError(error);
      }
    });

  const kbDeleteCommand = kb.command('delete');
  kbDeleteCommand
    .description('Delete a KB note')
    .argument('<note>', 'Note slug without extension (e.g. rendering-guiding-contracts)')
    .action(async (note: string) => {
      const outputFormat = getOutputFormat(kbDeleteCommand);

      try {
        const client = makeClient(process.cwd(), kbDeleteCommand);
        const result = await client.kbDelete({ note });
        emit(result, outputFormat, formatKbDelete);
      } catch (error) {
        emitError(error);
      }
    });

  const kbReindexCommand = kb.command('reindex');
  kbReindexCommand.description('Rebuild the KB index').action(async () => {
    const outputFormat = getOutputFormat(kbReindexCommand);

    try {
      const client = makeClient(process.cwd(), kbReindexCommand);
      const result = await client.kbReindex({});
      emit(result, outputFormat, (data) => formatKbReindex(data, cliPrefix));
    } catch (error) {
      emitError(error);
    }
  });
}
