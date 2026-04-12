import { z } from 'zod';
import type { CallerContext } from '../shared/request-context.js';

export function parseBooleanQuery(value: unknown): boolean | undefined {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  if (value === undefined || value === '') return undefined;
  return undefined;
}

export const kbSearchQuerySchema = z
  .object({
    q: z.string().min(1),
    scope: z.enum(['notes', 'sources', 'communities', 'all']).optional(),
    top_k: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const kbPrinciplesQuerySchema = z
  .object({
    q: z.string().optional(),
    top_k: z.coerce.number().int().positive().optional(),
    verbose: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .strict();

export const discussEventsQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).optional(),
    projectRoot: z.string().min(1),
  })
  .strict();

export const kbMemoListQuerySchema = z
  .object({
    projectRoot: z.string().min(1),
    owner: z.string().optional(),
  })
  .strict();

export const kbMemoDeleteQuerySchema = z
  .object({
    projectRoot: z.string().min(1),
    pattern: z.string().optional(),
    owner: z.string().optional(),
    all: z.preprocess(parseBooleanQuery, z.boolean()).optional(),
  })
  .strict()
  .refine((data) => (data.pattern !== undefined) !== (data.all === true), {
    message: 'Exactly one of pattern or all=true must be provided',
  });

export const discussDetailQuerySchema = z
  .object({
    projectRoot: z.string().min(1),
    view: z.enum(['control', 'audit']).optional(),
  })
  .strict();

export const discussDeleteQuerySchema = z
  .object({
    projectRoot: z.string().min(1),
  })
  .strict();

export function queryParamsToObject(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params);
}

export function buildCallerContextFromQuery(
  projectRoot: string,
  pluginRoot: string,
  coralEnvSnapshot: Readonly<Record<string, string>>,
): CallerContext {
  return { projectRoot, pluginRoot, coralEnv: { ...coralEnvSnapshot } };
}
