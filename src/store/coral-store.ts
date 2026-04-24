import type { Database } from 'better-sqlite3';

import type { StoreReadContext } from './body-codec.js';
import type { CoralEvent } from './envelope.js';
import type { EventsFilter, EventsPage } from './queries/events.js';
import { getEvent, getEventsSince } from './queries/events.js';
import {
  loadJobDetail,
  loadJobProjectionDetail,
  listJobs,
  readJobProgress,
  type JobDetail,
  type JobsListFilters,
} from './queries/jobs.js';
import {
  diagnoseKnowledgeBase,
  listKnowledgeBaseMemos,
  listKnowledgeBasePrinciples,
  listKnowledgeBaseSources,
  readKnowledgeBaseEntry,
  searchKnowledgeBase,
} from '../kb/queries.js';
import {
  readDiscussDiscovery,
  readDiscussEventLog,
  readDiscussSnapshot,
  readDiscussSummaryIndex,
  type DiscussEventLogEntry,
  type DiscussReadRef,
  type DiscussSnapshotRow,
} from './queries/discuss.js';
import { readSessionEntryById } from './queries/sessions.js';
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

export type CoralStoreOptions = {
  namespace?: string;
  projectRoot?: string;
  pluginRoot?: string;
};

export class CoralStore implements StoreReadContext {
  public readonly schemas: StoreReadContext['schemas'];
  public readonly upcasters: StoreReadContext['upcasters'];
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
    discovery: (source: string) => DiscussDiscoveryData | null;
    summaryIndex: (source: string) => DiscussSummaryIndexData | null;
  };
  public readonly sessions: {
    readEntry: (sessionId: string) => SessionEntry;
  };

  constructor(
    private readonly db: Database,
    readCtx: StoreReadContext,
    options: CoralStoreOptions = {},
  ) {
    this.schemas = readCtx.schemas;
    this.upcasters = readCtx.upcasters;
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
      search: (args) => searchKnowledgeBase(args, { pluginRoot: this.pluginRoot }),
      diagnose: () => diagnoseKnowledgeBase({ pluginRoot: this.pluginRoot }),
      read: (selector) => readKnowledgeBaseEntry(selector, { projectRoot: this.projectRoot, pluginRoot: this.pluginRoot }),
      listPrinciples: (args) => listKnowledgeBasePrinciples(args, { pluginRoot: this.pluginRoot }),
      listSources: () => listKnowledgeBaseSources({ pluginRoot: this.pluginRoot }),
      listMemos: (args) => listKnowledgeBaseMemos(this.projectRoot ?? process.cwd(), args),
    };

    this.discuss = {
      snapshot: (ref) => readDiscussSnapshot(this.db, ref),
      eventLog: (ref) => readDiscussEventLog(this.db, ref, this),
      discovery: (source) => readDiscussDiscovery(this.db, source),
      summaryIndex: (source) => readDiscussSummaryIndex(this.db, source),
    };

    this.sessions = {
      readEntry: (sessionId) => readSessionEntryById(this.db, sessionId),
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
}
