import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync } from 'fs';

mkdirSync('bridge', { recursive: true });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await esbuild.build({
  entryPoints: ['src/mcp/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'bridge/coral-server.cjs',
  external: ['node:*'],
  minify: true,
  define: {
    '__VERSION__': JSON.stringify(version),
  },
});

console.log('Built bridge/coral-server.cjs');
