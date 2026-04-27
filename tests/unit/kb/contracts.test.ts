import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const KB_DIR = join(process.cwd(), 'src', 'kb');

function readKbFile(name: string): string {
  return readFileSync(join(KB_DIR, name), 'utf-8');
}

describe('kb contracts boundary', () => {
  it('moves shared runtime contracts into contract.ts and keeps runtime value exports explicit', () => {
    const contractsSource = readKbFile('contract.ts');
    const runtimeSource = readKbFile('runtime.ts');

    for (const contractName of [
      'KbRuntime',
      'KbIndexState',
      'KbCachedOramaIndex',
    ]) {
      expect(contractsSource).toMatch(new RegExp(`export interface ${contractName}\\b`));
      expect(runtimeSource).not.toMatch(new RegExp(`export (?:interface|type) ${contractName}\\b`));
    }

    expect(runtimeSource).toContain('export function createKbRuntime');
  });

  it('keeps kb runtime-type consumers pointed at contract.ts instead of runtime.ts', () => {
    for (const [fileName, contractImport] of [
      ['curate/state/bootstrap.ts', "from '../../contract.js'"],
      ['curate/state/store.ts', "from '../../contract.js'"],
      ['corpus/index-mutations.ts', "from '../contract.js'"],
      ['corpus/rescan/index.ts', "from '../../contract.js'"],
    ] as const) {
      const source = readKbFile(fileName);
      expect(source).toContain(contractImport);
      expect(source).not.toMatch(
        /import\s+type\s+\{[^}]*Kb(?:Runtime|IndexState|CachedOramaIndex)[^}]*\}\s+from ['"](?:\.\/|\.\.\/)?runtime\.js['"]/,
      );
    }
  });
});
