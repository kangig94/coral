import { needleInstaller } from '#src/engines/needle/install.js';
import type { EngineManifest } from './contract.js';

const PACKAGE_VERSION = '0.5.2';

export const BUNDLED_ENGINES: readonly EngineManifest[] = [
  {
    id: 'gemini',
    version: PACKAGE_VERSION,
    specifier: '#src/engines/gemini/expansion.js',
    tier: 'installed',
    description: 'Google Gemini embedding API (requires GEMINI_API_KEY; no local model)',
    fills: ['kb.embedding'],
    onboarding: [{ kind: 'env-var', name: 'GEMINI_API_KEY' }],
  },
  {
    id: 'onnx',
    version: PACKAGE_VERSION,
    specifier: '#src/engines/onnx/expansion.js',
    tier: 'installed',
    description: 'Local ONNX embedding model (~100MB one-time download; runs offline, no API key)',
    fills: ['kb.embedding'],
  },
  {
    id: 'needle',
    version: '0.2.0',
    specifier: '#src/engines/needle/expansion.js',
    tier: 'installed',
    description: 'Needle vector backend (DuckDB-backed ScanANN; replaces Orama vector when equipped)',
    installer: needleInstaller,
    onboarding: [{ kind: 'require-binding', binding: 'kb.embedding' }],
    fills: ['kb.vector'],
  },
  {
    id: 'orama',
    version: PACKAGE_VERSION,
    specifier: '#src/engines/orama/expansion.js',
    tier: 'bundled',
    description: 'Default KB FTS backend (no native deps)',
    fills: ['kb.fts'],
  },
];
