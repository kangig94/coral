import { z } from 'zod';

import { parseBooleanQuery } from '../infra/json.js';
import { networkEnvSchema } from '../infra/network-env.js';

// Local schema duplicate of `src/jobs/launch.ts` sourceImportReadinessSchema —
// kept inline to avoid a `kb -> jobs` runtime edge that would form a
// `jobs <-> kb <-> providers` cycle (jobs -> providers, providers -> kb both
// already exist). Two ~30-byte enum schemas are cheaper than restructuring
// the cross-domain dependency graph.
const sourceImportReadinessSchema = z.enum(['commit', 'base-search', 'active-vector', 'all-equipped']);

const projectRootSchema = z.string().min(1, 'Project root is required');
const slugSchema = z.string().min(1);
const sourceImportFilePathSchema = z.string().min(1);
const transportContextFieldsShape = {
  projectRoot: projectRootSchema,
  owner: z.string().optional(),
  effort: z.string().optional(),
  claudeModelCap: z.string().optional(),
  jobId: z.string().optional(),
  sessionId: z.string().optional(),
  networkEnv: networkEnvSchema.optional(),
} satisfies z.ZodRawShape;
const optionalTransportContextFieldsShape = {
  projectRoot: projectRootSchema.optional(),
  owner: z.string().optional(),
  effort: z.string().optional(),
  claudeModelCap: z.string().optional(),
  jobId: z.string().optional(),
  sessionId: z.string().optional(),
  networkEnv: networkEnvSchema.optional(),
} satisfies z.ZodRawShape;

export const kbSearchSchema = z
  .object({
    query: z.string().min(1),
    scope: z.enum(['notes', 'sources', 'communities', 'wiki', 'all']).optional(),
    top_k: z.number().int().positive().optional(),
    mode: z.enum(['text', 'vector', 'hybrid']).optional(),
  })
  .strict();

export const kbSearchQuerySchema = z
  .object({
    q: z.string().min(1),
    scope: z.enum(['notes', 'sources', 'communities', 'wiki', 'all']).optional(),
    top_k: z.coerce.number().int().positive().optional(),
    mode: z.enum(['text', 'vector', 'hybrid']).optional(),
  })
  .strict();

export const kbReadSchema = z
  .object({
    note: z.string().min(1),
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
    note: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
  })
  .strict();

export const kbDeleteSchema = z
  .object({
    note: z.string().min(1),
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
    slug: z.string().min(1).optional(),
    readiness: sourceImportReadinessSchema.default('base-search'),
    async: z.boolean().default(false),
  })
  .strict();

export const kbSourceListSchema = z.object({}).strict();

export const kbSourceDeleteSchema = z
  .object({
    slug: z.string().min(1),
  })
  .strict();

export const kbMemoSchema = z
  .object({
    topic: z.string().min(1),
    content: z.string(),
    owner: z.string().min(1),
  })
  .strict();

export const kbMemoListSchema = z
  .object({
    owner: z.string().optional(),
  })
  .strict();

export const kbMemoListQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
  })
  .strict();

export const kbMemoDeleteSchema = z
  .object({
    pattern: z.string().min(1),
    owner: z.string().optional(),
  })
  .strict();

export const kbMemoPurgeSchema = z
  .object({
    owner: z.string().optional(),
  })
  .strict();

export const kbMemoDeleteConsolidatedSchema = z
  .object({
    pattern: z.string().min(1).optional(),
    owner: z.string().optional(),
    all: z.boolean().optional(),
  })
  .strict();

export const kbMemoDeleteQuerySchema = z
  .object({
    ...transportContextFieldsShape,
    pattern: z.string().optional(),
    all: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .strict()
  .refine((data) => (data.pattern !== undefined) !== (data.all === true), {
    message: 'Exactly one of pattern or all=true must be provided',
  });

export const kbPrinciplesSchema = z
  .object({
    query: z.string().optional(),
    verbose: z.boolean().optional(),
    top_k: z.number().int().positive().optional(),
  })
  .strict();

export const kbPrinciplesQuerySchema = z
  .object({
    q: z.string().optional(),
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
