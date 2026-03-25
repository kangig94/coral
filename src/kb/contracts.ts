import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { CallerContext } from '../execution/request-context.js';
import { isRecord } from '../shared/mcp-utils.js';
import { ensureKbIndex, getKbContext, setAutoRebuild } from './detect.js';
import { deleteFn } from './delete.js';
import { promote } from './promote.js';
import { rebuildMetadataAndOrama, reindex } from './reindex.js';
import { searchKb } from './search.js';
import { update } from './update.js';

// Auto-rebuild index when missing or stale — avoids circular import by using callback
setAutoRebuild(async (kb, startSeq) => { await rebuildMetadataAndOrama(kb, startSeq); });

// KB filenames allow mixed case for code identifiers (e.g., cuMemFree, applyExpel)
const slugSchema = z.string().regex(/^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/);
const noteNameSchema = slugSchema;
const nonEmptyTrimmedSchema = z.string().trim().min(1);
const titleSchema = nonEmptyTrimmedSchema;
const tagSchema = nonEmptyTrimmedSchema;

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

type KbToolContractMap = Record<string, KbToolContract<z.ZodTypeAny>>;

export const kbSearchSchema = z.object({
  query: nonEmptyTrimmedSchema,
  top_k: z.number().int().min(1).max(100).optional().default(20),
});
export type KbSearchInput = z.input<typeof kbSearchSchema>;

export const kbPromoteSchema = z.object({
  memo: z.string().describe('Memo filename (e.g. 20260325-topic.md), not a full path'),
  title: titleSchema,
  content: z.string(),
  tags: z.array(tagSchema),
  principles: z.array(z.string()),
  domain: slugSchema,
  topic: slugSchema,
});
export type KbPromoteInput = z.input<typeof kbPromoteSchema>;

export const kbUpdateSchema = z.object({
  note: noteNameSchema,
  title: titleSchema.optional(),
  content: z.string().optional(),
  tags: z.array(tagSchema).optional(),
  principles: z.array(z.string()).optional(),
});
export type KbUpdateInput = z.input<typeof kbUpdateSchema>;

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

export const kbToolContracts = defineKbToolContracts({
  kb_search: {
    description: 'Search the knowledge base.',
    schema: kbSearchSchema,
    handler: async (input, ctx) => {
      const kb = getKbContext(ctx);
      return searchKb(kb, input.query, input.top_k);
    },
  },
  kb_promote: {
    description: 'Promote a memo to a KB note.',
    schema: kbPromoteSchema,
    handler: async (input, ctx) => promote(getKbContext(ctx), input),
  },
  kb_update: {
    description: 'Update an existing KB note.',
    schema: kbUpdateSchema,
    handler: async (input, ctx) => update(getKbContext(ctx), input),
  },
  kb_delete: {
    description: 'Delete an existing KB note.',
    schema: kbDeleteSchema,
    handler: async (input, ctx) => deleteFn(getKbContext(ctx), input),
  },
  kb_reindex: {
    description: 'Rebuild the KB index from markdown files.',
    schema: kbReindexSchema,
    handler: async (_input, ctx) => reindex(getKbContext(ctx)),
  },
  kb_principles: {
    description: 'List KB principle names. Use to discover cross-domain decision patterns before searching.',
    schema: kbPrinciplesSchema,
    handler: async (input, ctx) => {
      const kb = getKbContext(ctx);
      const index = await ensureKbIndex(kb);
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
}) as unknown as KbToolContractMap;
