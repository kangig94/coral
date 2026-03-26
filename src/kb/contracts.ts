import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CallerContext } from '../execution/request-context.js';
import { isRecord } from '../shared/mcp-utils.js';
import { deleteFn } from './delete.js';
import { writeMemo } from './memo.js';
import { promote } from './promote.js';
import { reindex } from './reindex.js';
import { searchKb } from './search.js';
import { readNote } from './read.js';
import { update } from './update.js';
import type { CurateHandle } from './curate.js';
import type { KbRuntime } from './runtime.js';
import { LOWERCASE_SLUG_PATTERN, NOTE_SLUG_PATTERN } from './validation.js';

const noteSlugSchema = z.string().regex(NOTE_SLUG_PATTERN);
const lowercaseSlugSchema = z.string().regex(LOWERCASE_SLUG_PATTERN);
const noteNameSchema = noteSlugSchema.describe('Note slug without path or extension (e.g. rendering-guiding-contracts)');
const nonEmptyTrimmedSchema = z.string().trim().min(1);
const titleSchema = nonEmptyTrimmedSchema;

type KbToolDefinition<TSchema extends z.ZodTypeAny> = {
  description: string;
  schema: TSchema;
  handler: (input: z.infer<TSchema>, ctx: CallerContext) => Promise<unknown>;
};

export type KbToolContract<TSchema extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: TSchema;
  inputSchema: Record<string, unknown>;
  handler: (input: z.infer<TSchema>, ctx: CallerContext) => Promise<unknown>;
};

export type KbToolContractMap = Record<string, KbToolContract<z.ZodTypeAny>>;

export const kbSearchSchema = z.object({
  query: nonEmptyTrimmedSchema,
  top_k: z.number().int().min(1).max(100).optional().default(20),
});
export type KbSearchInput = z.input<typeof kbSearchSchema>;

export const kbPromoteSchema = z.object({
  memo: z.string().describe('Memo filename (e.g. 20260325-topic.md), not a full path'),
  title: titleSchema,
  content: z.string(),
  domain: lowercaseSlugSchema,
  topic: noteSlugSchema,
});
export type KbPromoteInput = z.input<typeof kbPromoteSchema>;

export const kbUpdateSchema = z.object({
  note: noteNameSchema,
  title: titleSchema.optional(),
  content: z.string().optional(),
});
export type KbUpdateInput = z.input<typeof kbUpdateSchema>;

export const kbReadSchema = z.object({
  note: noteNameSchema,
});
export type KbReadInput = z.input<typeof kbReadSchema>;

export const kbDeleteSchema = z.object({
  note: noteNameSchema,
});
export type KbDeleteInput = z.input<typeof kbDeleteSchema>;

export const kbReindexSchema = z.object({});
export type KbReindexInput = z.input<typeof kbReindexSchema>;

export const kbPrinciplesSchema = z.object({
  query: nonEmptyTrimmedSchema.optional(),
  top_k: z.number().int().min(1).max(100).optional().default(100),
});
export type KbPrinciplesInput = z.input<typeof kbPrinciplesSchema>;

const memoTopicSlugSchema = lowercaseSlugSchema.describe('Kebab-case topic slug (e.g. orama-threshold)');

export const kbMemoSchema = z.object({
  topic: memoTopicSlugSchema,
  content: nonEmptyTrimmedSchema.describe('Memo body text (one paragraph + context)'),
});
export type KbMemoInput = z.input<typeof kbMemoSchema>;

function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const inputSchema = zodToJsonSchema(schema, { $refStrategy: 'none' });
  if (!isRecord(inputSchema)) {
    throw new Error('KB tool schema must serialize to an object');
  }
  return inputSchema;
}

export function defineKbToolContracts<TDefs extends Record<string, KbToolDefinition<z.ZodTypeAny>>>(
  defs: TDefs,
): { [K in keyof TDefs]: KbToolContract<TDefs[K]['schema']> } {
  const contracts = {} as { [K in keyof TDefs]: KbToolContract<TDefs[K]['schema']> };

  for (const name of Object.keys(defs) as Array<keyof TDefs>) {
    const definition = defs[name];
    contracts[name] = {
      name: String(name),
      description: definition.description,
      schema: definition.schema,
      inputSchema: toInputSchema(definition.schema),
      handler: definition.handler,
    };
  }

  return contracts;
}

export function createKbToolContracts({
  kb,
  curate,
}: {
  kb: KbRuntime;
  curate: CurateHandle;
}): KbToolContractMap {
  return defineKbToolContracts({
    kb_search: {
      description: 'Search the knowledge base.',
      schema: kbSearchSchema,
      handler: async (input) => searchKb(kb, input.query, input.top_k),
    },
    kb_read: {
      description: 'Read a KB note by slug.',
      schema: kbReadSchema,
      handler: async (input) => readNote(input),
    },
    kb_promote: {
      description: 'Promote a memo to a KB note.',
      schema: kbPromoteSchema,
      handler: async (input, ctx) => promote(kb, ctx.projectRoot, input, () => { curate.schedule(); }),
    },
    kb_update: {
      description: 'Update an existing KB note.',
      schema: kbUpdateSchema,
      handler: async (input) => update(kb, input),
    },
    kb_delete: {
      description: 'Delete an existing KB note.',
      schema: kbDeleteSchema,
      handler: async (input) => deleteFn(kb, input),
    },
    kb_reindex: {
      description: 'Rebuild the KB index from markdown files.',
      schema: kbReindexSchema,
      handler: async () => reindex(kb),
    },
    kb_principles: {
      description: 'List KB principle names. Use to discover cross-domain decision patterns before searching.',
      schema: kbPrinciplesSchema,
      handler: async (input) => {
        const index = await kb.ensureIndex();
        let names = Object.keys(index.principles);
        const total = names.length;
        if (input.query) {
          const q = input.query.toLowerCase();
          names = names.filter(n => n.includes(q));
        }
        names.sort();
        return { principles: names.slice(0, input.top_k), total };
      },
    },
    kb_memo: {
      description: 'Write a memo. Timestamps and frontmatter are generated automatically.',
      schema: kbMemoSchema,
      handler: async (input, ctx) => writeMemo(ctx.projectRoot, input),
    },
  }) as unknown as KbToolContractMap;
}
