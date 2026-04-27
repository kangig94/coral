import { z } from 'zod';

import type { BundledExpansion } from './contract.js';

const PACKAGE_VERSION = '0.5.2';

export const bundledEntrySchema = z
  .object({
    id: z.string(),
    version: z.string().min(1),
    specifier: z.string().min(1),
    metadata: z
      .object({
        description: z.string().min(1),
        repo: z.string().min(1).optional(),
        onboarding: z.enum(['optional', 'required']).optional(),
        slot: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const BUNDLED_EXPANSIONS: readonly BundledExpansion[] = [
  {
    id: 'gemini',
    version: PACKAGE_VERSION,
    specifier: '#src/kb/embedding/gemini/expansion.js',
    metadata: {
      slot: 'kb.embedding',
      description: 'Google Gemini embedding API',
      onboarding: 'required',
    },
  },
  {
    id: 'onnx',
    version: PACKAGE_VERSION,
    specifier: '#src/kb/embedding/onnx/expansion.js',
    metadata: {
      slot: 'kb.embedding',
      description: 'Local ONNX embedding model',
      onboarding: 'required',
    },
  },
  {
    id: 'needle',
    version: '0.2.0',
    specifier: '#src/kb/search/needle/expansion.js',
    metadata: {
      description: 'Needle vector backend (DuckDB-backed ScanANN; replaces Orama vector when equipped)',
      repo: '../coral-needle',
      onboarding: 'optional',
      slot: 'kb.vector',
    },
  },
];
