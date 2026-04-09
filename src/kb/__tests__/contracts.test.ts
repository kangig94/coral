import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const KB_DIR = join(process.cwd(), 'src', 'kb');

function readKbFile(name: string): string {
  return readFileSync(join(KB_DIR, name), 'utf-8');
}

describe('kb contracts boundary', () => {
  it('moves shared runtime contracts into contracts.ts and keeps runtime value exports explicit', () => {
    const contractsSource = readKbFile('contracts.ts');
    const runtimeSource = readKbFile('runtime.ts');

    for (const contractName of [
      'KbRuntime',
      'KbIndexState',
      'KbCachedOramaIndex',
      'KbVectorSpecState',
      'KbVectorLease',
      'KbVectorTextSnapshot',
    ]) {
      expect(contractsSource).toMatch(new RegExp(`export interface ${contractName}\\b`));
      expect(runtimeSource).not.toMatch(new RegExp(`export (?:interface|type) ${contractName}\\b`));
    }

    const entrySeqGuardSource = readKbFile('entry-seq-guard.ts');
    expect(entrySeqGuardSource).toContain('export function runEntrySeqUpgradeGuard');
    expect(runtimeSource).toContain('export function createKbRuntime');
  });

  it('keeps kb runtime-type consumers pointed at contracts.ts instead of runtime.ts', () => {
    for (const fileName of ['curate-state.ts', 'mutation-helpers.ts', 'text-artifacts.ts']) {
      const source = readKbFile(fileName);
      expect(source).toContain("from './contracts.js'");
      expect(source).not.toMatch(
        /import\s+type\s+\{[^}]*Kb(?:Runtime|IndexState|CachedOramaIndex|VectorSpecState|VectorLease|VectorTextSnapshot)[^}]*\}\s+from ['"]\.\/runtime\.js['"]/,
      );
    }
  });
});
