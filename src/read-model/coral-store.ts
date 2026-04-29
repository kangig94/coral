import type { Database } from 'better-sqlite3';

import type { Runtime } from '../runtime/ports.js';
import type { StoreReadContext } from '../store/body-codec.js';
import type { CoralEvent } from '../store/envelope.js';
import type { EventsFilter, EventsPage } from '../store/event-queries.js';
import { getEvent, getEventsSince } from '../store/event-queries.js';
import {
  loadJobDetail,
  loadJobProjectionDetail,
  listJobs,
  readJobProgress,
  type JobDetail,
  type JobsListFilters,
} from '../jobs/read-queries.js';
import {
  diagnoseKnowledgeBase,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  readKnowledgeBaseEntry,
  searchKnowledgeBase,
} from '../kb/queries.js';
import { buildDiscussWatchState } from '../discuss/watch.js';
import type { WatchState } from '../discuss/watch.js';
import {
  readDiscussDiscovery,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSummaryIndex,
  type DiscussEventLogEntry,
  type DiscussReadRef,
  type DiscussSnapshotRow,
} from '../discuss/read-queries.js';
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
  KbReadInput,
  KbReadResult,
  KbSearchInput,
  KbSearchResponse,
  KbSourceListResult,
} from '../kb/entry-types.js';
import type { SessionEntry } from '../sessions/entry.js';
import type { DiscussDiscoveryData, DiscussSummaryIndexData } from '../discuss/persistence-types.js';

export type CoralStoreRuntime = Pick<Runtime, 'storage' | 'ids'>;

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
    listMemos: (args: KbMemoListInput) => KbMemoListResult;
  };
  public readonly discuss: {
    snapshot: (ref: DiscussReadRef) => DiscussSnapshotRow | null;
    eventLog: (ref: DiscussReadRef) => DiscussEventLogEntry[];
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
      search: (args) => searchKnowledgeBase(args, { pluginRoot: this.requirePluginRoot('kb.search') }),
      diagnose: () => diagnoseKnowledgeBase({ pluginRoot: this.requirePluginRoot('kb.diagnose') }),
      read: (selector) =>
        readKnowledgeBaseEntry(selector, {
          projectRoot: this.requireProjectRoot('kb.read'),
          pluginRoot: this.requirePluginRoot('kb.read'),
        }),
      listPrinciples: (args) =>
        listKnowledgeBasePrinciples(args, { pluginRoot: this.requirePluginRoot('kb.listPrinciples') }),
      listSources: () => listKnowledgeBaseSources({ pluginRoot: this.requirePluginRoot('kb.listSources') }),
      listMemos: (args) =>
        listKnowledgeBaseMemos(this.requireRuntime('kb.listMemos').storage, this.requireProjectRoot('kb.listMemos'), args),
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

  readJobProgress(jobId: string) {
    return readJobProgress(this.db, jobId, this);
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
}
