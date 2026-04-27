import { z } from 'zod';

import type { BundledExpansion } from './contract.js';

export const bundledEntrySchema = z
  .object({
    id: z.string().min(1),
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
