import oramaExpansion from '#src/engines/orama/expansion.js';
import { needleInstaller } from '#src/engines/needle/install.js';
import { KIWI_INSTALLER_VERSION, kiwiInstaller } from '#src/engines/kiwi/install.js';
import type { EngineManifest, Expansion, ExpansionHost, InstallOnlyManifest } from './contract.js';
import { parseEngineManifests } from './manifest/schema.js';

const PACKAGE_VERSION = '0.5.2';

export const BUNDLED_ENGINES: readonly EngineManifest[] = parseEngineManifests([
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
]);

export const BUNDLED_INSTALL_ONLY_PACKAGES: readonly InstallOnlyManifest[] = [
  {
    id: 'kiwi',
    version: KIWI_INSTALLER_VERSION,
    description:
      'Kiwi Korean morphological analyzer artifact - installs kiwi-nlp WASM support plus the CoNg base model for opt-in Korean KB tokenization',
    installer: kiwiInstaller,
    onboarding: [
      {
        kind: 'confirm-download',
        message:
          "This downloads the Kiwi CoNg base model (~88 MB) from github.com/bab2min/Kiwi releases into Coral's engine data directory. Continue?",
      },
    ],
  },
];

// `tier: 'bundled'` engines must be statically reachable so esbuild inlines
// them into coral-backend.cjs. A marketplace install ships src/ alongside the
// bundle, but a runtime `import(specifier)` of a TS module hits relative
// `./xxx.js` imports inside that module which Node's package.json `imports`
// map cannot rewrite (only the entry specifier matches `#src/*.js`). Listing
// the loader statically here resolves the entire engine through esbuild.
export const BUNDLED_LOADERS: Readonly<Record<string, Expansion>> = {
  orama: oramaExpansion,
};

export async function loadBundledEngine(
  entry: EngineManifest,
  host: ExpansionHost,
  loaders: Readonly<Record<string, Expansion>> = BUNDLED_LOADERS,
): Promise<void> {
  if (entry.tier === 'bundled') {
    const loader = loaders[entry.id];
    if (!loader) {
      throw new Error(`Bundled engine '${entry.id}' is missing a static loader`);
    }
    await loader(host);
    return;
  }
  const module = (await import(entry.specifier)) as { default: Expansion };
  await module.default(host);
}
