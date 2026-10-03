import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { build } from 'esbuild';

export async function buildReleasedStorageReader(tag: string, outfile: string): Promise<void> {
  const cwd = process.cwd();
  const sources = new Map<string, string>();
  await build({
    stdin: {
      contents:
        'export {JobLocationIndex, hasReadableTerminalDetail} from "./src/jobs/location-index.ts"; export {readCustodyLedger} from "./src/store/custody-ledger.ts";',
      resolveDir: cwd,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [
      {
        name: 'shipped-storage-source',
        setup(builder) {
          builder.onResolve({ filter: /^(\.|#src\/)/ }, (args) => {
            if (args.namespace !== 'shipped' && args.importer !== '<stdin>') return;
            const path = args.path.startsWith('#src/')
              ? `src/${args.path.slice(5)}`
              : posix.normalize(
                  posix.join(args.namespace === 'shipped' ? posix.dirname(args.importer) : '.', args.path),
                );
            return { path: path.replace(/\.js$/u, '.ts'), namespace: 'shipped' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'shipped' }, (args) => {
            let source = sources.get(args.path);
            if (source === undefined) {
              source = execFileSync('git', ['show', `${tag}:${args.path}`], {
                cwd,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024,
              });
              sources.set(args.path, source);
            }
            return { contents: source, loader: 'ts', resolveDir: cwd };
          });
        },
      },
    ],
  });
}
