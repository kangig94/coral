import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { garbageStoreEpochs } from '#src/store/epoch/index.js';

const ROOT = process.cwd();
const STORE_ROOT = join(ROOT, 'src/store');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function storeSources(): readonly string[] {
  return readdirSync(STORE_ROOT, { recursive: true })
    .filter((name): name is string => typeof name === 'string' && name.endsWith('.ts'))
    .map((name) => `src/store/${name}`);
}

function epochSource(): string {
  return storeSources()
    .filter((path) => path.startsWith('src/store/epoch/'))
    .map(source)
    .join('\n');
}

function enclosingFunctionName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionDeclaration(current) && current.name !== undefined) return current.name.text;
    current = current.parent;
  }
  return null;
}

function functionSource(path: string, name: string): string {
  const text = source(path);
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declaration === undefined) throw new Error(`Missing function ${name} in ${path}`);
  return declaration.getText(parsed);
}

describe('write-once store epoch invariants', () => {
  it('publishes an epoch directory only by renaming a private mint', () => {
    const facets = storeSources().filter((path) => path.startsWith('src/store/epoch/'));
    const publications: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'renameSync' &&
        /epochDirectory|epoch-/u.test(node.arguments[1]?.getText() ?? '')
      ) {
        publications.push(node);
      }
      ts.forEachChild(node, visit);
    };
    for (const path of facets) visit(ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true));

    expect(publications).toHaveLength(1);
    expect(publications[0]?.arguments[0]?.getText()).toBe('mint');
    expect(enclosingFunctionName(publications[0])).toBe('mintNextEpoch');
    expect(epochSource()).toContain("const MINT_DIRECTORY_PREFIX = '.mint-'");
    expect(epochSource()).not.toContain('replaceEpoch');
  });

  it('makes descriptor and WAL-path binding race cells unreachable', () => {
    const epoch = epochSource();
    const ports = source('src/infra/port-types.ts');
    const runtime = source('src/runtime/real.ts');

    expect(epoch).not.toMatch(
      /openProvenStoreDescriptor|provenPathStillNamesObject|verifiedObservations|settledObservations|\/proc\/self\/fd|\/dev\/fd/u,
    );
    expect(ports).not.toContain('openNoFollowSync');
    expect(runtime).not.toMatch(/openNoFollowSync|O_NOFOLLOW/u);
  });

  it('deletes superseded epochs only through the named deletion owners', () => {
    for (const path of storeSources()) {
      if (path.startsWith('src/store/epoch/')) continue;
      expect(source(path), path).not.toMatch(/(?:rmSync|unlinkSync)\([^\n]*epoch-/u);
    }

    const facets = storeSources().filter((path) => path.startsWith('src/store/epoch/'));
    const deletions = new Set([
      'removeDuringSweep',
      'removeDuringPostReadySweep',
      'removeEpochEntry',
      'removeClosedProtectedEpoch',
    ]);
    const deletionOwners = new Map<string, Set<string | null>>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && deletions.has(node.expression.text)) {
        const owners = deletionOwners.get(node.expression.text) ?? new Set<string | null>();
        owners.add(enclosingFunctionName(node));
        deletionOwners.set(node.expression.text, owners);
      }
      ts.forEachChild(node, visit);
    };
    for (const path of facets) visit(ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true));
    expect(new Map([...deletionOwners].map(([callee, owners]) => [callee, [...owners].sort()]))).toEqual(
      new Map([
        ['removeDuringSweep', ['cleanStoreEpochHolders', 'removeAfterReapingRename', 'sweepStoreEpochs']],
        [
          'removeDuringPostReadySweep',
          [
            'cleanPostReadyStoreEpochHolders',
            'removeAfterReapingRenameAsync',
            'removeWhileExclusivelyLockedAsync',
            'sweepStoreEpochsPostReady',
          ],
        ],
        ['removeEpochEntry', ['discardUnservedRetirementMint', 'sweepStoreEpochsPostReady']],
        ['removeClosedProtectedEpoch', ['sweepStoreEpochsPostReady']],
      ]),
    );
  });

  it('retains exactly the highest two proven epochs across numbering gaps', () => {
    for (let mask = 0; mask < 1 << 8; mask += 1) {
      const proven = Array.from({ length: 8 }, (_, epoch) => String(epoch + 1)).filter(
        (_epoch, index) => mask & (1 << index),
      );
      const retained = new Set([...proven].sort((left, right) => Number(left) - Number(right)).slice(-2));
      expect(garbageStoreEpochs(proven)).toEqual(new Set(proven.filter((epoch) => !retained.has(epoch))));
    }
  });

  it('keeps filesystem identity comparisons at their proof sites', () => {
    expect(epochSource()).not.toContain('sameDevice');
  });

  it('does not retain the deleted reset authority and resume mechanisms', () => {
    expect(storeSources().map((path) => path.split('/').at(-1))).not.toEqual(
      expect.arrayContaining([
        'backend-store-reset.ts',
        'reset-active-evidence.ts',
        'reset-retention.ts',
        'settlement-authority.ts',
      ]),
    );
    const all = storeSources().map(source).join('\n');
    expect(all).not.toMatch(/WriterExclusion|store_reset_lock_contended|store_reset_interrupted_/u);
  });

  it('replaces the swept-mint refusal with holder-publication safety in the semantic-refusal ratchet', () => {
    expect(epochSource()).not.toContain('failStoreEpoch');
  });

  it('uses file-lock acquisition rather than bare pid observation for holder liveness', () => {
    const epoch = epochSource();
    expect(epoch).not.toContain('observeLiveness');
    expect(epoch).toContain('attemptExclusiveFileLockSync');
  });

  it('does not retain private-copy reporting or diagnostic child machinery', () => {
    expect(storeSources()).not.toContain('src/store/reset-incident-diagnostic.ts');
    expect(readdirSync(join(ROOT, 'src/infra'))).not.toEqual(
      expect.arrayContaining(['store-report-temp-root.ts', 'store-reset-diagnostic-supervisor.ts']),
    );
    expect(source('src/cli/store-reset.ts')).not.toMatch(/diagnos|tempRoot|tmpdir/u);
    const quarantineList = functionSource('src/cli/commands/backend.ts', 'listRecoveryQuarantineLocal');
    expect(quarantineList).toContain('openReadOnlyStoreDatabase');
    expect(quarantineList).not.toMatch(/stage|copy|tempRoot/u);
  });

  it('uses one ENOENT-only observation for every store-path absence decision', () => {
    for (const path of storeSources()) {
      if (path === 'src/store/path-observation.ts') continue;
      expect(source(path), path).not.toContain('.existsSync(');
    }
    expect(source('src/cli/read-store.ts')).not.toContain('.existsSync(');
    expect(source('clients/hooks/pre-compact.mjs')).not.toContain('existsSync(dbPath)');
    expect(functionSource('src/store/path-observation.ts', 'observeStorePath')).toContain("code === 'ENOENT'");
    expect(functionSource('src/store/epoch/observation.ts', 'inspectCurrentStore')).toContain(
      'observeCurrentStore(runtime)',
    );
    expect(functionSource('src/store/epoch/observation.ts', 'resolveCurrentStore')).toContain(
      'observeCurrentStore(runtime)',
    );
  });

  it('requires private device identity for every required epoch file in source and generated hooks', () => {
    const epoch = epochSource();
    const hook = source('clients/hooks/lib/store-epoch.mjs');
    expect(functionSource('src/store/epoch/observation.ts', 'observeRegularFile')).toContain('entry.nlink === 1n');
    expect(functionSource('src/store/epoch/observation.ts', 'observeRegularFile')).toContain('entry.dev === device');
    expect(functionSource('src/store/epoch/observation.ts', 'observeContainedDirectory')).toContain(
      'entry.dev !== parentEntry.dev',
    );
    expect(functionSource('src/store/epoch/metadata.ts', 'readEpochMetadata')).toContain('nlink !== 1n');
    expect(epoch).toContain('entry.dev !== directoryEntry.dev');
    expect(epoch).toContain('return entry.isFile() && entry.nlink === 1n && entry.dev === device;');
    expect(hook).toContain('return entry.isFile() && entry.nlink === 1n && entry.dev === device;');
  });

  it('uses the metadata-complete epoch proof for every production opener', () => {
    expect(functionSource('src/store/epoch/observation.ts', 'resolveProvenStoreEpochAtPath')).toContain(
      'observeStoreEpoch',
    );
    expect(functionSource('src/store/epoch/opening.ts', 'openWritableStoreDbNoReset')).toContain(
      'acquireStoreEpochReadLock',
    );
    expect(functionSource('src/store/epoch/observation.ts', 'resolveCurrentStore')).toContain(
      'resolveProvenStoreEpochAtPath',
    );
    expect(functionSource('src/store/epoch/holder.ts', 'acquireStoreEpochReadLock')).toContain('resolved.storeRoot');
    expect(functionSource('src/store/read-port.ts', 'openReadOnlyStoreDatabase')).toContain(
      'acquireStoreEpochReadLock',
    );
    expect(source('src/cli/expansion/install.ts')).toContain('openWritableStoreDbNoReset');
    expect(source('clients/hooks/lib/store-epoch.mjs')).toContain(
      "isValidEpochMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')))",
    );
  });

  it('keeps list publication provenance on the sidecar without opening SQLite', () => {
    const list = functionSource('src/store/epoch/inventory.ts', 'listStoreEpochs');
    expect(list).not.toMatch(/classifyStoreFile|acquireSharedFileLockSync|openStoreDatabase/u);
    expect(list).toContain('publicationReason');
    expect(list).toContain('observation.epochJson.value.classification');
  });

  it('keeps reporting paths free of exclusive lock acquisition', () => {
    for (const name of ['observeStoreEpochHolder', 'observeStoreEpochHolderAsync', 'listStoreEpochResidues']) {
      expect(
        functionSource(
          name === 'listStoreEpochResidues' ? 'src/store/epoch/residue.ts' : 'src/store/epoch/holder.ts',
          name,
        ),
        name,
      ).not.toMatch(/(?:attempt|tryAcquire)ExclusiveFileLockSync/u);
    }
    expect(functionSource('src/store/epoch/holder.ts', 'listStoreEpochHolders')).not.toContain(
      'inspectStoreEpochHolder',
    );
  });

  it('constructs on the store device in a namespace only the post-ready sweep reclaims', () => {
    const mint = functionSource('src/store/epoch/mint.ts', 'mintNextEpoch');
    const postReady = functionSource('src/store/epoch/post-ready-sweep.ts', 'sweepStoreEpochsPostReady');
    expect(mint).toContain('join(dbDir, `${PRIVATE_MINT_CONSTRUCTION_PREFIX}${id}`)');
    expect(mint).not.toContain('createSharedFileLockSync(join(preparation');
    expect(postReady).toContain('isStoreEpochResidue(entry)');
    expect(epochSource()).toContain('name.startsWith(PRIVATE_MINT_CONSTRUCTION_PREFIX)');
  });

  it('keeps every store lock inside its store directory', () => {
    const epoch = epochSource();
    expect(epoch).toContain("export const STORE_LOCK_FILE_NAME = '.lock'");
    expect(epoch).not.toMatch(/\.epoch-lock-|\.mint-lock-|removeOrphanedEpochLock|removeLockFile/u);
  });

  it('keeps legacy_source_not_quiescent producers off the startup adoption path', () => {
    const activeSelection = source('src/store/active-store-selection-coordination.ts');
    expect(activeSelection).toContain('tryAcquireGenerationAdoptionLock(runtime)');
    expect(activeSelection).not.toMatch(/\bacquireGenerationAdoptionLock\b/u);

    const coordination = source('src/store/generation-mutation-coordination.ts');
    const start = coordination.indexOf('export async function tryAcquireGenerationAdoptionLock');
    const end = coordination.indexOf('export async function acquireGenerationAdoptionLease', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(coordination.slice(start, end)).not.toContain('generationNotQuiescentError');
  });
});
