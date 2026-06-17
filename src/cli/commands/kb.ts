import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';

import { parseKbEntryId, vaultLinkToEntryId, type KbPromoteInput } from '../../kb/entry-types.js';
import { assertSourceSlug, assertWikiSlug } from '../../kb/validation.js';
import { assertOwnerId } from '../../infra/identifiers.js';
import { resolveProjectSource } from '../../infra/project-source.js';
import { UsageError } from '../errors.js';
import {
  makeClient,
  type KbMemoDeleteOptions,
  type KbMemoListOptions,
  type KbMemoPurgeOptions,
  type KbMemoWriteOptions,
  type KbPrinciplesOptions,
  type KbPromoteOptions,
  type KbReindexOptions,
  type KbSearchOptions,
  type KbSourceImportOptions,
  type KbUpdateOptions,
  type KbWikiAdoptOptions,
  type KbWikiCiteOptions,
  type KbWikiCreateOptions,
  type KbWikiRewriteOptions,
} from '../dispatch.js';
import { createOutputFormatOption, emit, emitError, emitText, getCliDisplayPrefix, getOutputFormat } from '../emit.js';
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
  formatKbWakeUp,
  formatKbWikiAdopt,
  formatKbWikiCite,
  formatKbWikiCreate,
  formatKbWikiDelete,
  formatKbWikiLink,
  formatKbWikiList,
  formatKbWikiRewrite,
  formatKbWikiUnlink,
} from '../format/kb.js';

const REF_FORMAT_HINT =
  'note:<slug>, source:<slug>, community:<slug>, wiki:<slug>, or [[notes/<slug>]] / [[sources/<slug>]] / [[communities/<slug>]] / [[wiki/<slug>]]';

function assertRefFormat(value: string, field: string): string {
  if (parseKbEntryId(value) === null && vaultLinkToEntryId(value) === null) {
    throw new UsageError(`Invalid ${field} "${value}". Use ${REF_FORMAT_HINT}.`);
  }
  return value;
}

function assertRefsFormat(values: readonly string[]): string[] {
  const refs: string[] = [];
  for (const value of values) {
    refs.push(assertRefFormat(value, 'ref'));
  }
  return refs;
}

function appendDelimitedOption(value: string, previous: string[] | undefined): string[] {
  const items = previous === undefined ? [] : [...previous];
  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      items.push(trimmed);
    }
  }
  return items;
}

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
      try {
        const client = makeClient(process.cwd(), kbSourceImportCommand);
        const result = await client.kbSourceImport({
          filePath: resolve(process.cwd(), resolveFilePath(file)),
          ...(opts.slug === undefined ? {} : { slug: opts.slug }),
          readiness: opts.ready ?? 'base-search',
          async: opts.async === true,
        });
        emitText(result, formatKbSourceImport);
      } catch (error) {
        emitError(error);
      }
    });

  const kbSourceListCommand = kbSourceCommand.command('list');
  kbSourceListCommand
    .description('List KB sources')
    .addOption(createOutputFormatOption())
    .action(async () => {
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
      try {
        const client = makeClient(process.cwd(), kbSourceDeleteCommand);
        const result = await client.kbSourceDelete({ slug: assertSourceSlug(slug, 'source') });
        emitText(result, formatKbSourceDelete);
      } catch (error) {
        emitError(error);
      }
    });
}

function registerKbWikiCommands(kb: Command): void {
  const kbWikiCommand = kb.command('wiki').description('Manage KB wikis');

  const kbWikiCreateCommand = kbWikiCommand.command('create');
  kbWikiCreateCommand
    .description('Create an empty wiki. Populate it with rewrite/link afterwards.')
    .argument('<slug>', 'Wiki slug (kebab-case, no extension)')
    .option('--title <text>', 'H1 title (defaults to slug)')
    .option('--tag <name>', 'Tag (repeatable)', appendDelimitedOption)
    .action(async (slug: string, opts: KbWikiCreateOptions) => {
      try {
        const client = makeClient(process.cwd(), kbWikiCreateCommand);
        const result = await client.kbWikiCreate({
          slug: assertWikiSlug(slug, 'wiki'),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.tag !== undefined ? { tags: opts.tag } : {}),
        });
        emitText(result, formatKbWikiCreate);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiRewriteCommand = kbWikiCommand.command('rewrite');
  kbWikiRewriteCommand
    .description('Replace the Understanding section with the contents of a file.')
    .argument('<slug>', 'Wiki slug')
    .requiredOption('--from <path>', 'File whose contents become the new Understanding')
    .action(async (slug: string, opts: KbWikiRewriteOptions) => {
      try {
        const client = makeClient(process.cwd(), kbWikiRewriteCommand);
        const result = await client.kbWikiRewrite({
          slug: assertWikiSlug(slug, 'wiki'),
          understandingFile: resolveFilePath(opts.from),
        });
        emitText(result, formatKbWikiRewrite);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiLinkCommand = kbWikiCommand.command('link');
  kbWikiLinkCommand
    .description(
      'Append references to Knowledge. Existing links are ignored (idempotent). Refs accept [[notes/<slug>]] / [[sources/<slug>]] / [[communities/<slug>]] / [[wiki/<slug>]] or note:<slug> / source:<slug> / community:<slug> / wiki:<slug>.',
    )
    .argument('<slug>', 'Wiki slug')
    .argument('<refs...>', 'One or more refs (space-separated)')
    .action(async (slug: string, refs: string[]) => {
      try {
        const client = makeClient(process.cwd(), kbWikiLinkCommand);
        const result = await client.kbWikiLink({
          slug: assertWikiSlug(slug, 'wiki'),
          refs: assertRefsFormat(refs),
        });
        emitText(result, formatKbWikiLink);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiUnlinkCommand = kbWikiCommand.command('unlink');
  kbWikiUnlinkCommand
    .description(
      'Remove references from Knowledge. Their evidence sub-bullets are removed with them. Missing refs are ignored.',
    )
    .argument('<slug>', 'Wiki slug')
    .argument('<refs...>', 'One or more refs (space-separated)')
    .action(async (slug: string, refs: string[]) => {
      try {
        const client = makeClient(process.cwd(), kbWikiUnlinkCommand);
        const result = await client.kbWikiUnlink({
          slug: assertWikiSlug(slug, 'wiki'),
          refs: assertRefsFormat(refs),
        });
        emitText(result, formatKbWikiUnlink);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiCiteCommand = kbWikiCommand.command('cite');
  kbWikiCiteCommand
    .description('Append an evidence sub-bullet under <ref> in Knowledge. <ref> must already be linked.')
    .argument('<slug>', 'Wiki slug')
    .argument('<ref>', `The Knowledge entry to nest under: ${REF_FORMAT_HINT}`)
    .requiredOption('--from <path>', 'File whose contents become the evidence text')
    .action(async (slug: string, ref: string, opts: KbWikiCiteOptions) => {
      try {
        const client = makeClient(process.cwd(), kbWikiCiteCommand);
        const result = await client.kbWikiCite({
          slug: assertWikiSlug(slug, 'wiki'),
          ref: assertRefFormat(ref, 'ref'),
          evidenceFile: resolveFilePath(opts.from),
        });
        emitText(result, formatKbWikiCite);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiAdoptCommand = kbWikiCommand.command('adopt');
  kbWikiAdoptCommand
    .description(
      "Promote a memo to a note and link it at the front of <slug>'s Knowledge in one atomic operation. All --memo/--title/--content-file/--domain/--topic are required.",
    )
    .argument('<slug>', 'Wiki slug to adopt the new note into')
    .requiredOption('--memo <filename>', '(required) Memo filename (e.g. 20260325-topic.md)')
    .requiredOption('--title <text>', '(required) Note title')
    .requiredOption('--content-file <path>', '(required) Read note content from file')
    .requiredOption('--domain <slug>', '(required) Note domain')
    .requiredOption('--topic <slug>', '(required) Note topic')
    .action(async (slug: string, opts: KbWikiAdoptOptions) => {
      try {
        const content = readFileSync(resolveFilePath(opts.contentFile), 'utf8');
        const client = makeClient(process.cwd(), kbWikiAdoptCommand);
        const result = await client.kbWikiAdopt({
          slug: assertWikiSlug(slug, 'wiki'),
          memo: opts.memo,
          title: opts.title,
          content,
          domain: opts.domain,
          topic: opts.topic,
        });
        emitText(result, formatKbWikiAdopt);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiDeleteCommand = kbWikiCommand.command('delete');
  kbWikiDeleteCommand
    .description('Delete a KB wiki')
    .argument('<slug>', 'Wiki slug without extension')
    .action(async (slug: string) => {
      try {
        const client = makeClient(process.cwd(), kbWikiDeleteCommand);
        const result = await client.kbWikiDelete({ slug: assertWikiSlug(slug, 'wiki') });
        emitText(result, formatKbWikiDelete);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWikiListCommand = kbWikiCommand.command('list');
  kbWikiListCommand
    .description('List KB wikis')
    .addOption(createOutputFormatOption())
    .action(async () => {
      const outputFormat = getOutputFormat(kbWikiListCommand);

      try {
        const client = makeClient(process.cwd(), kbWikiListCommand);
        const result = await client.kbWikiList();
        emit(result, outputFormat, formatKbWikiList);
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
        emitText(result, formatKbMemo);
      } catch (error) {
        emitError(error);
      }
    });

  const kbMemoListCommand = kbMemoCommand.command('list');
  kbMemoListCommand
    .description('List project memos')
    .option('--owner <id>', 'Filter by owner session ID')
    .addOption(createOutputFormatOption())
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
      try {
        const client = makeClient(process.cwd(), kbMemoDeleteCommand);
        const result = await client.kbMemoDelete({ pattern, owner: opts.owner });
        emitText(result, formatKbMemoDelete);
      } catch (error) {
        emitError(error);
      }
    });

  const kbMemoPurgeCommand = kbMemoCommand.command('purge');
  kbMemoPurgeCommand
    .description('Delete all project memos')
    .option('--owner <owner>', 'Only purge memos owned by this session')
    .action(async (opts: KbMemoPurgeOptions) => {
      try {
        const client = makeClient(process.cwd(), kbMemoPurgeCommand);
        const result = await client.kbMemoPurge(opts.owner ? { owner: opts.owner } : {});
        emitText(result, formatKbMemoPurge);
      } catch (error) {
        emitError(error);
      }
    });
}

export function registerKbCommands(program: Command): void {
  const cliPrefix = getCliDisplayPrefix();
  const kb = program.command('kb').description('Knowledge base operations');
  // --output-format is intentionally NOT registered on the kb parent. Adding it
  // here would silently extend JSON support to every subcommand, including
  // mutate ops whose response shape leaks internal `path` fields. Each read
  // command that genuinely needs JSON output registers it locally via
  // createOutputFormatOption() — see below.

  const kbSearchCommand = kb.command('search');
  kbSearchCommand
    .description('Search KB entries')
    .argument('<query>', 'Search query')
    .option('--top-k <n>', 'Maximum results (default: 20)')
    .option('--vector', 'Force vector-only search (requires embedding backend)')
    .option('--hybrid', 'Force hybrid search (requires embedding backend)')
    .addOption(
      new Option('--scope <scope>', 'Limit results to notes, communities, sources, wiki, or all').choices([
        'notes',
        'communities',
        'sources',
        'wiki',
        'all',
      ]),
    )
    .addOption(createOutputFormatOption())
    .action(async (query: string, opts: KbSearchOptions) => {
      const outputFormat = getOutputFormat(kbSearchCommand);

      try {
        const selectedModes = Number(opts.vector === true) + Number(opts.hybrid === true);
        if (selectedModes > 1) {
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
    .addOption(createOutputFormatOption())
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
    .addOption(createOutputFormatOption())
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
  registerKbWikiCommands(kb);
  registerKbMemoCommands(kb);

  const kbReadCommand = kb.command('read');
  kbReadCommand
    .description('Read a KB entry by slug or explicit selector')
    .argument(
      '<note>',
      'Bare reads resolve memo -> note -> wiki -> community -> source -> principle; use wiki:<slug>, communities:<slug>, or sources:<slug> to force a kind',
    )
    .addOption(createOutputFormatOption())
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
    .description('Promote a memo into a KB note. To attach the new note to a wiki, use `kb wiki adopt`.')
    .requiredOption('--memo <filename>', '(required) Memo filename (e.g. 20260325-topic.md)')
    .requiredOption('--title <text>', '(required) Note title')
    .requiredOption('--content-file <path>', '(required) Read content from file')
    .requiredOption('--domain <slug>', '(required) Note domain')
    .requiredOption('--topic <slug>', '(required) Note topic')
    .action(async (opts: KbPromoteOptions) => {
      try {
        const content = readFileSync(resolveFilePath(opts.contentFile), 'utf8');
        const args: KbPromoteInput = {
          memo: opts.memo,
          title: opts.title,
          content,
          domain: opts.domain,
          topic: opts.topic,
        };
        const client = makeClient(process.cwd(), kbPromoteCommand);
        const result = await client.kbPromote(args);
        emitText(result, formatKbPromote);
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
        emitText(result, formatKbUpdate);
      } catch (error) {
        emitError(error);
      }
    });

  const kbDeleteCommand = kb.command('delete');
  kbDeleteCommand
    .description('Delete a KB note')
    .argument('<note>', 'Note slug without extension (e.g. rendering-guiding-contracts)')
    .action(async (note: string) => {
      try {
        const client = makeClient(process.cwd(), kbDeleteCommand);
        const result = await client.kbDelete({ note });
        emitText(result, formatKbDelete);
      } catch (error) {
        emitError(error);
      }
    });

  const kbWakeUpCommand = kb.command('wake-up');
  kbWakeUpCommand.description('Generate the KB wake-up packet').action(async () => {
    try {
      const client = makeClient(process.cwd(), kbWakeUpCommand);
      const result = await client.kbWakeUp({ project: resolveProjectSource(process.cwd()).replace(/\//g, '-') });
      emitText(result, formatKbWakeUp);
    } catch (error) {
      emitError(error);
    }
  });

  const kbReindexCommand = kb.command('reindex');
  kbReindexCommand
    .description('Rebuild the KB index')
    .option('--async', 'Return after launching the reindex job')
    .action(async (opts: KbReindexOptions) => {
      try {
        const client = makeClient(process.cwd(), kbReindexCommand);
        const result = await client.kbReindex({ async: opts.async === true });
        emitText(result, (data) => formatKbReindex(data, cliPrefix));
      } catch (error) {
        emitError(error);
      }
    });
}
