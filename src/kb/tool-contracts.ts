import { z } from 'zod';

import { parseBooleanQuery } from '../infra/json.js';
import { networkEnvSchema } from '../infra/network-env.js';

// Local schema duplicate of `src/jobs/launch.ts` sourceImportReadinessSchema —
// kept inline to avoid a `kb -> jobs` runtime edge that would form a
// `jobs <-> kb <-> providers` cycle (jobs -> providers, providers -> kb both
// already exist). Two ~30-byte enum schemas are cheaper than restructuring
// the cross-domain dependency graph.
const sourceImportReadinessSchema = z.enum(['commit', 'base-search', 'active-vector', 'all-equipped']);

export const KB_SEARCH_QUERY_MAX_CODE_POINTS = 512;
export const KB_SEARCH_QUERY_MAX_BYTES = 2 * 1024;
export const KB_TEXT_FILTER_MAX_CODE_POINTS = 512;
export const KB_TEXT_FILTER_MAX_BYTES = 2 * 1024;
export const KB_SLUG_MAX_BYTES = 512;

function hasAtMostCodePoints(value: string, max: number): boolean {
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > max) {
      return false;
    }
  }
  return true;
}

function boundedString(
  schema: z.ZodString,
  label: string,
  limits: { maxCodePoints?: number; maxBytes: number },
): z.ZodEffects<z.ZodString, string, string> {
  return schema.superRefine((value, ctx) => {
    const byteLength = Buffer.byteLength(value, 'utf-8');
    if (byteLength > limits.maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be at most ${limits.maxBytes} UTF-8 bytes`,
      });
      return;
    }
    if (limits.maxCodePoints !== undefined && !hasAtMostCodePoints(value, limits.maxCodePoints)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must be at most ${limits.maxCodePoints} characters`,
      });
    }
  });
}

const searchQueryTextSchema = boundedString(z.string().min(1), 'Search query', {
  maxCodePoints: KB_SEARCH_QUERY_MAX_CODE_POINTS,
  maxBytes: KB_SEARCH_QUERY_MAX_BYTES,
});
const optionalSearchQueryTextSchema = boundedString(z.string(), 'Search query', {
  maxCodePoints: KB_SEARCH_QUERY_MAX_CODE_POINTS,
  maxBytes: KB_SEARCH_QUERY_MAX_BYTES,
}).optional();
const textFilterSchema = boundedString(z.string().min(1), 'Text filter', {
  maxCodePoints: KB_TEXT_FILTER_MAX_CODE_POINTS,
  maxBytes: KB_TEXT_FILTER_MAX_BYTES,
});
const optionalTextFilterSchema = boundedString(z.string(), 'Text filter', {
  maxCodePoints: KB_TEXT_FILTER_MAX_CODE_POINTS,
  maxBytes: KB_TEXT_FILTER_MAX_BYTES,
}).optional();
const slugSchema = boundedString(z.string().min(1), 'Slug', { maxBytes: KB_SLUG_MAX_BYTES });
const projectRootSchema = z.string().min(1, 'Project root is required');
const sourceImportFilePathSchema = z.string().min(1);
const transportContextFieldsShape = {
  projectRoot: projectRootSchema,
  owner: optionalTextFilterSchema,
  effort: z.string().optional(),
  claudeModelCap: z.string().optional(),
  claudeTransport: z.string().optional(),
  jobId: z.string().optional(),
  sessionId: z.string().optional(),
  networkEnv: networkEnvSchema.optional(),
} satisfies z.ZodRawShape;
const optionalTransportContextFieldsShape = {
  projectRoot: projectRootSchema.optional(),
  owner: optionalTextFilterSchema,
  effort: z.string().optional(),
  claudeModelCap: z.string().optional(),
  claudeTransport: z.string().optional(),
  jobId: z.string().optional(),
  sessionId: z.string().optional(),
  networkEnv: networkEnvSchema.optional(),
} satisfies z.ZodRawShape;

export const kbSearchSchema = z
  .object({
    query: searchQueryTextSchema,
    scope: z.enum(['notes', 'sources', 'communities', 'wiki', 'all']).optional(),
    top_k: z.number().int().positive().optional(),
    mode: z.enum(['text', 'vector', 'hybrid']).optional(),
  })
  .strict();

export const kbSearchQuerySchema = z
  .object({
    q: searchQueryTextSchema,
    scope: z.enum(['notes', 'sources', 'communities', 'wiki', 'all']).optional(),
    top_k: z.coerce.number().int().positive().optional(),
    mode: z.enum(['text', 'vector', 'hybrid']).optional(),
  })
  .strict();

export const kbReadSchema = z
  .object({
    note: slugSchema,
  })
  .strict();

export const kbPromoteSchema = z
  .object({
    memo: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    domain: z.string().min(1),
    topic: z.string().min(1),
  })
  .strict();

export const kbUpdateSchema = z
  .object({
    note: slugSchema,
    title: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();

export const kbDeleteSchema = z
  .object({
    note: slugSchema,
  })
  .strict();

const kbWikiRefListSchema = z.array(z.string().min(1)).min(1);

export const kbWikiCreateSchema = z
  .object({
    slug: slugSchema,
    title: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const kbWikiRewriteSchema = z
  .object({
    slug: slugSchema,
    understandingFile: z.string().min(1),
  })
  .strict();

export const kbWikiLinkSchema = z
  .object({
    slug: slugSchema,
    refs: kbWikiRefListSchema,
  })
  .strict();

export const kbWikiUnlinkSchema = kbWikiLinkSchema;

export const kbWikiCiteSchema = z
  .object({
    slug: slugSchema,
    ref: z.string().min(1),
    evidenceFile: z.string().min(1),
  })
  .strict();

export const kbWikiAdoptSchema = z
  .object({
    slug: slugSchema,
    memo: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    domain: z.string().min(1),
    topic: z.string().min(1),
  })
  .strict();

export const kbWikiDeleteSchema = z.object({ slug: slugSchema }).strict();
export const kbWikiListSchema = z.object({}).strict();
export const kbWikiReadSchema = z.object({ slug: slugSchema }).strict();
export const kbWakeUpSchema = z
  .object({
    project: z.string().min(1).optional(),
  })
  .strict();

export const kbSourceImportSchema = z
  .object({
    filePath: sourceImportFilePathSchema,
    slug: slugSchema.optional(),
    readiness: sourceImportReadinessSchema.default('base-search'),
    async: z.boolean().default(false),
  })
  .strict();

export const kbSourceListSchema = z.object({}).strict();

export const kbSourceDeleteSchema = z
  .object({
    slug: slugSchema,
  })
  .strict();

export const kbMemoSchema = z
  .object({
    topic: z.string().min(1),
    content: z.string(),
    owner: textFilterSchema,
  })
  .strict();

export const kbMemoListSchema = z
  .object({
    owner: optionalTextFilterSchema,
  })
  .strict();

export const kbMemoListQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
    owner: optionalTextFilterSchema,
  })
  .strict();

export const kbMemoDeleteSchema = z
  .object({
    pattern: textFilterSchema,
    owner: optionalTextFilterSchema,
  })
  .strict();

export const kbMemoPurgeSchema = z
  .object({
    owner: optionalTextFilterSchema,
  })
  .strict();

export const kbMemoDeleteConsolidatedSchema = z
  .object({
    pattern: textFilterSchema.optional(),
    owner: optionalTextFilterSchema,
    all: z.boolean().optional(),
  })
  .strict();

export const kbMemoDeleteQuerySchema = z
  .object({
    ...transportContextFieldsShape,
    pattern: optionalTextFilterSchema,
    all: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .strict()
  .refine((data) => (data.pattern !== undefined) !== (data.all === true), {
    message: 'Exactly one of pattern or all=true must be provided',
  });

export const kbPrinciplesSchema = z
  .object({
    query: optionalSearchQueryTextSchema,
    verbose: z.boolean().optional(),
    top_k: z.number().int().positive().optional(),
  })
  .strict();

export const kbPrinciplesQuerySchema = z
  .object({
    q: optionalSearchQueryTextSchema,
    top_k: z.coerce.number().int().positive().optional(),
    verbose: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .strict();

export const kbEntriesRequestSchema = kbSearchQuerySchema;
export const kbNoteReadRequestSchema = z.object({ slug: slugSchema }).strict();
export const kbSourceListRequestSchema = z.object({}).strict();
export const kbSourceReadRequestSchema = z.object({ slug: slugSchema }).strict();
export const kbCommunityReadRequestSchema = z.object({ slug: slugSchema }).strict();
export const kbCommunityListStaleRequestSchema = z.object({}).strict();
export const kbCommunitySummaryInputRequestSchema = z.object({ slug: slugSchema }).strict();
export const kbCommunitySetSummarySchema = z
  .object({ slug: slugSchema, summary: z.string().min(1, 'summary must not be empty') })
  .strict();
export const kbCommunitySetSummaryRequestSchema = kbCommunitySetSummarySchema
  .extend(optionalTransportContextFieldsShape)
  .strict();
export const kbMemoReadRequestSchema = z
  .object({
    slug: slugSchema,
    projectRoot: projectRootSchema,
  })
  .strict();
export const kbPrinciplesListRequestSchema = kbPrinciplesQuerySchema;
export const kbPrincipleReadRequestSchema = z.object({ slug: slugSchema }).strict();
export const kbNoteCreateRequestSchema = kbPromoteSchema.extend(transportContextFieldsShape).strict();
export const kbWikiCreateRequestSchema = kbWikiCreateSchema.extend(transportContextFieldsShape).strict();
export const kbWikiRewriteRequestSchema = kbWikiRewriteSchema.extend(transportContextFieldsShape).strict();
export const kbWikiLinkRequestSchema = kbWikiLinkSchema.extend(transportContextFieldsShape).strict();
export const kbWikiUnlinkRequestSchema = kbWikiUnlinkSchema.extend(transportContextFieldsShape).strict();
export const kbWikiCiteRequestSchema = kbWikiCiteSchema.extend(transportContextFieldsShape).strict();
export const kbWikiAdoptRequestSchema = kbWikiAdoptSchema.extend(transportContextFieldsShape).strict();
export const kbSourceCreateRequestSchema = kbSourceImportSchema.extend(transportContextFieldsShape).strict();
export const kbMemoCreateRequestSchema = kbMemoSchema
  .omit({ owner: true })
  .extend(transportContextFieldsShape)
  .strict();
export const kbReindexRequestSchema = z
  .object({
    async: z.boolean().default(false),
    ...transportContextFieldsShape,
  })
  .strict();
export const kbNoteUpdateRequestSchema = kbUpdateSchema
  .omit({ note: true })
  .extend({
    slug: slugSchema,
    ...transportContextFieldsShape,
  })
  .strict();
export const kbNoteDeleteRequestSchema = z
  .object({ slug: slugSchema, ...optionalTransportContextFieldsShape })
  .strict();
export const kbWikiDeleteRequestSchema = kbWikiDeleteSchema.extend(optionalTransportContextFieldsShape).strict();
export const kbWikiListRequestSchema = kbWikiListSchema;
export const kbWikiReadRequestSchema = kbWikiReadSchema;
export const kbWakeUpRequestSchema = kbWakeUpSchema;
export const kbSourceDeleteRequestSchema = z
  .object({ slug: slugSchema, ...optionalTransportContextFieldsShape })
  .strict();
export const kbMemoDeleteRequestSchema = kbMemoDeleteQuerySchema;
export const kbDiagnoseSchema = z.object({}).strict();
export const kbDiagnoseRequestSchema = kbDiagnoseSchema;
