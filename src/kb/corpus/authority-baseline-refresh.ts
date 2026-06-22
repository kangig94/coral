import { isNoEntryError } from '../../infra/fs-errors.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { KbRuntime } from '../contract.js';
import type {
  CorpusAuthorityBaselineMap,
  CorpusAuthorityBaselineRecord,
  CorpusAuthorityBaselineStore,
} from './authority-baseline-contract.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import { collectCorpusAuthorityBaseline } from './surface.js';
import {
  buildCorpusScanView,
  createCorpusEntityGraphScan,
  createCorpusMarkdownFileScan,
  createCorpusScanView,
  ENTITY_GRAPH_SCAN_ENTRY_ID,
} from './rescan/scan.js';
import type { CorpusMarkdownKind } from './rescan/storage.js';

type AuthorityBaselineRefreshTarget =
  | {
      readonly kind: CorpusMarkdownKind;
      readonly slug: string;
      readonly entryId: string;
      readonly key: string;
    }
  | {
      readonly kind: 'entity-graph';
      readonly entryId: typeof ENTITY_GRAPH_SCAN_ENTRY_ID;
      readonly key: typeof ENTITY_GRAPH_SCAN_ENTRY_ID;
    };

export interface CorpusAuthorityBaselineRefreshOptions {
  corpusAuthorityBaseline: CorpusAuthorityBaselineStore;
  storagePort: Pick<StoragePort, 'readFileSync'>;
  getRuntime(): KbRuntime;
  notePath(note: string): string;
  wikiPath(wiki: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  entityGraphPath(): string;
}

export class CorpusAuthorityBaselineRefresh {
  private readonly options: CorpusAuthorityBaselineRefreshOptions;
  constructor(options: CorpusAuthorityBaselineRefreshOptions) {
    this.options = options;
  }

  rebuildAuthorityBaselineFromDisk(): void {
    this.options.corpusAuthorityBaseline.rebuild(buildCorpusScanView(this.options.getRuntime()));
  }

  refreshAuthorityBaselineForPendingDeltas(deltas: readonly ManifestAuthorityDelta[]): void {
    if (deltas.length === 0) {
      this.rebuildAuthorityBaselineFromDisk();
      return;
    }

    const targets = new Map<string, AuthorityBaselineRefreshTarget>();
    for (const delta of deltas) {
      const target = this.authorityBaselineRefreshTarget(delta.manifestId);
      if (target === null) {
        this.rebuildAuthorityBaselineFromDisk();
        return;
      }
      targets.set(target.key, target);
    }

    const current = this.options.corpusAuthorityBaseline.read();
    if (current.size === 0) {
      this.rebuildAuthorityBaselineFromDisk();
      return;
    }

    for (const target of targets.values()) {
      if (target.kind === 'entity-graph') {
        this.refreshEntityGraphAuthorityBaseline(current, target);
      } else {
        this.refreshMarkdownAuthorityBaseline(current, target);
      }
    }

    this.options.corpusAuthorityBaseline.replace([...current.values()]);
  }

  private authorityBaselineRefreshTarget(manifestId: string): AuthorityBaselineRefreshTarget | null {
    if (manifestId.startsWith('note-meta:')) {
      const slug = manifestId.slice('note-meta:'.length);
      return { kind: 'note', slug, entryId: `note:${slug}`, key: `note:${slug}` };
    }

    if (manifestId.startsWith('note:')) {
      const slug = manifestId.slice('note:'.length);
      return { kind: 'note', slug, entryId: manifestId, key: manifestId };
    }

    if (manifestId.startsWith('source-meta:')) {
      const slug = manifestId.slice('source-meta:'.length);
      return { kind: 'source', slug, entryId: `source:${slug}`, key: `source:${slug}` };
    }

    if (manifestId.startsWith('source:')) {
      const slug = manifestId.slice('source:'.length);
      return { kind: 'source', slug, entryId: manifestId, key: manifestId };
    }

    if (manifestId.startsWith('wiki-meta:')) {
      const slug = manifestId.slice('wiki-meta:'.length);
      return { kind: 'wiki', slug, entryId: `wiki:${slug}`, key: `wiki:${slug}` };
    }

    if (manifestId.startsWith('wiki:')) {
      const slug = manifestId.slice('wiki:'.length);
      return { kind: 'wiki', slug, entryId: manifestId, key: manifestId };
    }

    if (manifestId.startsWith('community:')) {
      const slug = manifestId.slice('community:'.length);
      return { kind: 'community', slug, entryId: manifestId, key: manifestId };
    }

    if (manifestId.startsWith('principle:')) {
      const slug = manifestId.slice('principle:'.length);
      return { kind: 'principle', slug, entryId: manifestId, key: manifestId };
    }

    if (manifestId === ENTITY_GRAPH_SCAN_ENTRY_ID) {
      return { kind: 'entity-graph', entryId: ENTITY_GRAPH_SCAN_ENTRY_ID, key: ENTITY_GRAPH_SCAN_ENTRY_ID };
    }

    return null;
  }

  private refreshMarkdownAuthorityBaseline(
    current: CorpusAuthorityBaselineMap,
    target: Extract<AuthorityBaselineRefreshTarget, { readonly kind: CorpusMarkdownKind }>,
  ): void {
    const path = this.authorityBaselineMarkdownPath(target.kind, target.slug);
    let content: string;
    try {
      content = this.options.storagePort.readFileSync(path, 'utf-8');
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        current.delete(target.entryId);
        return;
      }
      throw error;
    }

    this.replaceAuthorityBaselineRecord(
      current,
      collectCorpusAuthorityBaseline(
        createCorpusScanView({
          markdownFiles: [
            createCorpusMarkdownFileScan({
              kind: target.kind,
              path,
              content,
              slug: target.slug,
            }),
          ],
          entityGraph: null,
        }),
      )[0],
      target.entryId,
    );
  }

  private refreshEntityGraphAuthorityBaseline(
    current: CorpusAuthorityBaselineMap,
    target: Extract<AuthorityBaselineRefreshTarget, { readonly kind: 'entity-graph' }>,
  ): void {
    const path = this.options.entityGraphPath();
    let content: string;
    try {
      content = this.options.storagePort.readFileSync(path, 'utf-8');
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        current.delete(target.entryId);
        return;
      }
      throw error;
    }

    this.replaceAuthorityBaselineRecord(
      current,
      collectCorpusAuthorityBaseline(
        createCorpusScanView({
          markdownFiles: [],
          entityGraph: createCorpusEntityGraphScan({ content, path }),
        }),
      )[0],
      target.entryId,
    );
  }

  private replaceAuthorityBaselineRecord(
    current: CorpusAuthorityBaselineMap,
    record: CorpusAuthorityBaselineRecord | undefined,
    entryId: string,
  ): void {
    if (record === undefined) {
      current.delete(entryId);
      return;
    }

    current.set(record.entryId, record);
  }

  private authorityBaselineMarkdownPath(kind: CorpusMarkdownKind, slug: string): string {
    switch (kind) {
      case 'note':
        return this.options.notePath(slug);
      case 'source':
        return this.options.sourcePath(slug);
      case 'wiki':
        return this.options.wikiPath(slug);
      case 'community':
        return this.options.communityPath(slug);
      case 'principle':
        return this.options.principlePath(slug);
    }
  }
}
