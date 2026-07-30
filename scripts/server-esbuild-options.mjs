export const PLACEHOLDER_STORE_FORMAT_FINGERPRINT = `sha256:${'0'.repeat(64)}`;

function bundleBanner({ version, buildSetId, flavor, storeFormatFingerprint }) {
  return (
    `var __CORAL_BUILD_IDENTITY__=${JSON.stringify({ version, buildSetId, flavor, storeFormatFingerprint })};` +
    'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
    'var __BUNDLE_DIR__=__dirname;' +
    'var __importMetaUrl=require("url").pathToFileURL(__filename).href;'
  );
}

export function createProductionServerEsbuildOptions({ version, buildSetId, flavor, storeFormatFingerprint }) {
  return {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    minify: true,
    banner: {
      js: bundleBanner({ version, buildSetId, flavor, storeFormatFingerprint }),
    },
    define: {
      __VERSION__: JSON.stringify(version),
      __BUILD_SET_ID__: JSON.stringify(buildSetId),
      __BUILD_FLAVOR__: JSON.stringify(flavor),
      __STORE_FORMAT_FINGERPRINT__: JSON.stringify(storeFormatFingerprint),
      // Preserve a bundle-local URL after conversion to CJS. The bundled Kiwi
      // Emscripten glue uses `createRequire(import.meta.url)` for Node built-ins;
      // WASM location itself is supplied separately through `locateFile`.
      'import.meta.url': '__importMetaUrl',
    },
  };
}
