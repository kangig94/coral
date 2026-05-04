import type { Database } from '../store/db.js';

import type { Runtime } from '../runtime/ports.js';
import { createKbQueryHost, type KbQueryContext } from './kb-query-runtime.js';
import {
  type KbQueryHost,
  diagnoseKnowledgeBase,
  generateKnowledgeBaseWakeUpPacket,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  listKnowledgeBaseWikis,
  readKnowledgeBaseEntryWithResolvedId,
  searchKnowledgeBase,
} from '../kb/queries.js';
import { appendTouchEvent } from '../kb/curate/touch-journal.js';
import { kbRuntimeDir } from '../kb/paths.js';
import type { StoreReadContext } from '../store/body-codec.js';
import type { CoralEvent } from '../store/envelope.js';
import { type EventsFilter, type EventsPage, getEvent, getEventsSince } from '../store/event-queries.js';
import {
  loadJobDetail,
  loadJobProjectionDetail,
  listJobs,
  readJobEvents,
  type JobDetail,
  type JobsListFilters,
} from '../jobs/read-queries.js';
import { buildDiscussWatchState, type WatchState } from '../discuss/watch.js';
import {
  readDiscussDiscovery,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSummaryIndex,
  type DiscussReadRef,
} from '../discuss/read-queries.js';
import type { DiscussDomainEvent, PersistedDiscussSnapshot } from '../discuss/events.js';
import { readSessionEntryById } from '../sessions/read-queries.js';
import {
  listWorkflowProjections,
  readWorkflowProjection,
  readWorkflowView,
  type WorkflowProjectionRow,
  type WorkflowView,
} from '../workflow/read-queries.js';
import type {
  KbDiagnoseResult,
  KbMemoListInput,
  KbMemoListResult,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbEntryId,
  KbReadInput,
  KbReadResult,
  KbSearchInput,
  KbSearchResponse,
  KbSourceListResult,
  KbWakeUpInput,
  KbWakeUpResponse,
  KbWikiListResult,
} from '../kb/entry-types.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { DiscussDiscoveryData, DiscussSummaryIndexData } from '../discuss/persistence-types.js';

export type CoralStoreRuntime = Pick<Runtime, 'env' | 'flavor' | 'ids' | 'paths' | 'process' | 'storage' | 'time'>;

export type CoralStoreOptions = {
  /**
   * Required when consumers exercise `kb.listMemos` or `kb.read` — those
   * surfaces read corpus markdown through `runtime.storage`. Tests that only
   * exercise journal-driven read APIs (jobs/discuss/sessions/workflows) may
   * omit it; calls into the kb surface throw a clear error instead.
   */
  runtime?: CoralStoreRuntime;
  namespace?: string;
  projectRoot?: string;
  pluginRoot?: string;
};

export class CoralStore implements StoreReadContext {
  public readonly schemas: StoreReadContext['schemas'];
  public readonly upcasters: StoreReadContext['upcasters'];
  private readonly runtime?: CoralStoreRuntime;
  private readonly namespace?: string;
  private readonly projectRoot?: string;
  private readonly pluginRoot?: string;

  public readonly jobs: {
    list: (filters: JobsListFilters) => Array<{ jobId: string; status: JobDetail['status'] }>;
    detail: (jobId: string) => JobDetail | null;
  };
  public readonly kb: {
    search: (args: KbSearchInput) => Promise<KbSearchResponse>;
    diagnose: () => KbDiagnoseResult;
    read: (selector: KbReadInput) => KbReadResult;
    listPrinciples: (args: KbPrinciplesInput) => Promise<KbPrinciplesResult>;
    listSources: () => Promise<KbSourceListResult>;
    listWikis: () => Promise<KbWikiListResult>;
    listMemos: (args: KbMemoListInput) => KbMemoListResult;
    wakeUp: (args: KbWakeUpInput) => Promise<KbWakeUpResponse>;
  };
  public readonly discuss: {
    snapshot: (ref: DiscussReadRef) => PersistedDiscussSnapshot | null;
    eventLog: (ref: DiscussReadRef) => DiscussDomainEvent[];
    watch: (sessionId: string, cursor?: number) => WatchState;
    discovery: (source: string) => DiscussDiscoveryData | null;
    summaryIndex: (source: string) => DiscussSummaryIndexData | null;
  };
  public readonly sessions: {
    readEntry: (sessionId: string) => SessionEntry;
  };
  public readonly workflows: {
    projection: (workflowId: string) => WorkflowProjectionRow | null;
    list: () => WorkflowProjectionRow[];
    view: (workflowId: string) => WorkflowView | null;
  };

  constructor(
    private readonly db: Database,
    readCtx: StoreReadContext,
    options: CoralStoreOptions = {},
  ) {
    this.schemas = readCtx.schemas;
    this.upcasters = readCtx.upcasters;
    this.runtime = options.runtime;
    this.namespace = options.namespace;
    this.projectRoot = options.projectRoot;
    this.pluginRoot = options.pluginRoot;

    this.jobs = {
      list: (filters) =>
        listJobs(
          this.db,
          {
            ...filters,
            ...(this.namespace === undefined ? {} : { namespace: this.namespace }),
          },
          this,
        ),
      detail: (jobId) =>
        loadJobDetail(this.db, jobId, this, this.namespace === undefined ? {} : { namespace: this.namespace }),
    };

    this.kb = {
      search: (args) => searchKnowledgeBase(args, this.kbQueryHost('kb.search')),
      diagnose: () => diagnoseKnowledgeBase(this.kbQueryHost('kb.diagnose')),
      read: (selector) => this.readKnowledgeBaseEntry(selector),
      listPrinciples: (args) => listKnowledgeBasePrinciples(args, this.kbQueryHost('kb.listPrinciples')),
      listSources: () => listKnowledgeBaseSources(this.kbQueryHost('kb.listSources')),
      listWikis: () => listKnowledgeBaseWikis(this.kbQueryHost('kb.listWikis')),
      listMemos: (args) =>
        listKnowledgeBaseMemos(
          this.requireRuntime('kb.listMemos').storage,
          this.requireProjectRoot('kb.listMemos'),
          args,
        ),
      wakeUp: (args) => generateKnowledgeBaseWakeUpPacket(args, this.kbQueryHost('kb.wakeUp')),
    };

    this.discuss = {
      snapshot: (ref) => readDiscussSnapshot(this.db, ref),
      eventLog: (ref) => readDiscussEventLog(this.db, ref, this),
      watch: (sessionId, cursor) =>
        buildDiscussWatchState(
          sessionId,
          readDiscussSnapshot(this.db, sessionId),
          readDiscussEventLog(this.db, sessionId, this),
          cursor,
        ),
      discovery: (source) => readDiscussDiscovery(this.db, source),
      summaryIndex: (source) => readDiscussSummaryIndex(this.db, source),
    };

    this.sessions = {
      readEntry: (sessionId) => readSessionEntryById(this.db, sessionId),
    };

    this.workflows = {
      projection: (workflowId) => readWorkflowProjection(this.db, workflowId),
      list: () => listWorkflowProjections(this.db),
      view: (workflowId) => readWorkflowView(this.db, workflowId, this),
    };
  }

  getEvent(stream: { kind: string; id: string }, seq: number): CoralEvent | undefined {
    return getEvent(this.db, stream, seq, this);
  }

  getEventsSince(afterSeq: number, filter?: EventsFilter, limit?: number): EventsPage {
    return getEventsSince(this.db, afterSeq, filter, limit, this);
  }

  loadJobProjectionDetail(jobId: string) {
    return loadJobProjectionDetail(this.db, jobId, this);
  }

  readJobEvents(jobId: string) {
    return readJobEvents(this.db, jobId, this);
  }

  private requireProjectRoot(operation: string): string {
    if (this.projectRoot === undefined || this.projectRoot.length === 0) {
      throw new Error(`CoralStore ${operation} requires an explicit projectRoot.`);
    }
    return this.projectRoot;
  }

  private requirePluginRoot(operation: string): string {
    if (this.pluginRoot === undefined || this.pluginRoot.length === 0) {
      throw new Error(`CoralStore ${operation} requires an explicit pluginRoot.`);
    }
    return this.pluginRoot;
  }

  private requireRuntime(operation: string): CoralStoreRuntime {
    if (this.runtime === undefined) {
      throw new Error(`CoralStore ${operation} requires a runtime port slice.`);
    }
    return this.runtime;
  }

  private kbQueryHost(operation: string, options: { requireProjectRoot?: boolean } = {}): KbQueryHost {
    const context: KbQueryContext = {
      pluginRoot: this.requirePluginRoot(operation),
      readDb: this.db,
    };
    if (options.requireProjectRoot === true) {
      context.projectRoot = this.requireProjectRoot(operation);
    }
    if (this.runtime !== undefined) {
      context.runtime = this.runtime;
    }
    return createKbQueryHost(context);
  }

  private readKnowledgeBaseEntry(selector: KbReadInput): KbReadResult {
    const resolved = readKnowledgeBaseEntryWithResolvedId(
      selector,
      this.kbQueryHost('kb.read', { requireProjectRoot: true }),
    );
    this.appendKbReadTouch(resolved.resolvedEntryId);
    return resolved.result;
  }

  private appendKbReadTouch(target: KbEntryId | null): void {
    if (target === null || this.runtime === undefined) {
      return;
    }

    const runtime = this.runtime;
    try {
      appendTouchEvent(kbRuntimeDir(runtime.flavor), target, runtime.ids.uuid(), {
        storage: runtime.storage,
        now: () => runtime.time.now(),
      });
    } catch {
      // KB reads are read-class operations; touch journaling is strictly fail-open.
    }
  }
}
