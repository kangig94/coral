import type { BundledExpansion } from './contract.js';

const PACKAGE_VERSION = '0.5.2';

export const BUNDLED_EXPANSIONS: readonly BundledExpansion[] = [
  {
    id: 'gemini',
    version: PACKAGE_VERSION,
    specifier: '#src/kb/embedding/gemini/expansion.js',
    metadata: {
      slot: 'kb.embedding',
      description: 'Google Gemini embedding API (requires GEMINI_API_KEY; no local model)',
      onboarding: 'required',
    },
  },
  {
    id: 'onnx',
    version: PACKAGE_VERSION,
    specifier: '#src/kb/embedding/onnx/expansion.js',
    metadata: {
      slot: 'kb.embedding',
      description: 'Local ONNX embedding model (~100MB one-time download; runs offline, no API key)',
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
