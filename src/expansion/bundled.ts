import { needleInstaller } from '#src/engines/needle/install.js';
import installOramaExpansion from '#src/engines/orama/expansion.js';
import type { EngineManifest } from './contract.js';
import type { ExpansionHost } from './contract.js';

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

export async function loadBundledEngine(entry: EngineManifest, host: ExpansionHost): Promise<void> {
  if (entry.tier !== 'bundled') {
    const module = (await import(entry.specifier)) as { default: (h: ExpansionHost) => void | Promise<void> };
    await module.default(host);
    return;
  }

  if (entry.id === 'orama') {
    await installOramaExpansion(host);
    return;
  }

  throw new Error(`No bundled engine loader registered for ${entry.id}`);
}
