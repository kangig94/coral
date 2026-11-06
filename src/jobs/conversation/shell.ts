import type { Database } from '../../store/db.js';
import type { CommitEventsFn } from '../../store/append.js';
import type { Runtime } from '../../runtime/ports.js';
import { nowIsoString } from '../../infra/time.js';
import { hashToken } from '../../infra/hash.js';
import { canonicalWorkDirWireSchema, type CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import { jobInCallerScope } from '../scope.js';
import { ProjectionConversationMalformedError } from '../records.js';
import { providerArtifactIdentityKey } from '../../providers/artifact-identity.js';
import type { JobConversation } from './entry.js';
import {
  ConversationReadError,
  type ConversationExecutionPort,
  type ConversationRecoveryPort,
  type ConversationAllocateOptions,
  type ConversationArtifactHandleRecordOptions,
  type ConversationWriteResult,
} from './contracts.js';
import type { ProviderValidatedContinuitySnapshot } from './continuity.js';
import { listProjectionConversationEntries, readProjectionJobConversation } from './read-queries.js';

export class ConversationManager {
  private readonly projectRoot: CanonicalWorkDir;
  private readonly runtime: Pick<Runtime, 'time' | 'ids'>;
  private readonly commitEvents: CommitEventsFn;
  private readonly db: Database;

  constructor(projectRoot: string, runtime: Pick<Runtime, 'time' | 'ids'>, commitEvents: CommitEventsFn, db: Database) {
    this.projectRoot = canonicalWorkDirWireSchema.parse(projectRoot);
    this.runtime = runtime;
    this.commitEvents = commitEvents;
    this.db = db;
  }

  prepare(options: ConversationAllocateOptions): JobConversation {
    const now = nowIsoString(this.runtime.time);
    return {
      jobId: options.jobId ?? this.runtime.ids.uuid(),
      execution: 0,
      open: false,
      finishing: false,
      provider: options.binding.provider,
      binding: options.binding,
      name: options.name,
      cwd: options.cwd,
      projectRoot: options.projectRoot,
      backendNamespace: options.backendNamespace,
      bypassPermissions: options.bypassPermissions ?? false,
      retention: options.retention ?? 'retain',
      artifactHandles: [],
      retentionDiscard: { attempts: [] },
      providerContinuity: null,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.agentName === undefined ? {} : { agent: options.agentName }),
      ...(options.instruction === undefined ? {} : { instruction: options.instruction }),
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
      ...(options.controllerProfile === undefined ? {} : { controllerProfile: options.controllerProfile }),
      createdAt: now,
      lastUsedAt: now,
    };
  }

  readById(jobId: string): JobConversation | null {
    const entry = readProjectionJobConversation(this.db, jobId);
    return entry !== null && jobInCallerScope({ jobKind: 'provider', workDir: entry.cwd }, this.projectRoot, 'contains')
      ? entry
      : null;
  }

  get(provider: string, jobId: string): JobConversation | null {
    const entry = this.readById(jobId);
    return entry?.binding.provider === provider ? entry : null;
  }

  forExecutionOwner(): ConversationExecutionPort & ConversationRecoveryPort {
    return {
      prepare: (options) => this.prepare(options),
      readById: (jobId) => this.readOwnedById(jobId),
      get: (provider, jobId) => {
        const entry = this.readOwnedById(jobId);
        if (entry !== null && entry.provider !== provider) throw new ConversationReadError('provider_mismatch', jobId);
        return entry;
      },
      list: (provider) => this.list(provider),
      checkpointJobContinuityAtomic: (jobId, options) => this.checkpointJobContinuityAtomic(jobId, options),
      recordArtifactHandleAtomic: (jobId, options) => this.recordArtifactHandleAtomic(jobId, options),
    };
  }

  private readOwnedById(jobId: string): JobConversation | null {
    let entry: JobConversation | null;
    try {
      entry = readProjectionJobConversation(this.db, jobId);
    } catch (cause) {
      if (cause instanceof ConversationReadError) throw cause;
      const reason = cause instanceof ProjectionConversationMalformedError ? 'malformed' : 'unreadable';
      throw new ConversationReadError(reason, jobId, { cause });
    }
    if (entry !== null && entry.projectRoot !== this.projectRoot)
      throw new ConversationReadError('owner_mismatch', jobId);
    return entry;
  }

  list(provider: string): JobConversation[] {
    return listProjectionConversationEntries(this.db, provider, hashToken(this.projectRoot, 12));
  }

  checkpointJobContinuityAtomic(
    jobId: string,
    options: {
      execution: number;
      snapshot: ProviderValidatedContinuitySnapshot;
    },
  ): Promise<ConversationWriteResult> {
    return Promise.resolve().then(() => {
      let result: ConversationWriteResult = { ok: false };
      this.commitEvents((commit) => {
        const entry = this.readOwnedById(jobId);
        if (entry === null || !entry.open || entry.finishing || entry.execution !== options.execution) return undefined;
        commit.append({
          type: 'job.continuity.checkpointed',
          stream: { kind: 'job', id: jobId },
          refs: { jobId },
          body: { execution: options.execution, snapshot: options.snapshot },
        });
        result = { ok: true, execution: options.execution };
        return undefined;
      });
      return result;
    });
  }

  recordArtifactHandleAtomic(
    jobId: string,
    options: ConversationArtifactHandleRecordOptions,
  ): Promise<ConversationWriteResult> {
    return Promise.resolve().then(() => {
      let result: ConversationWriteResult = { ok: false };
      this.commitEvents((commit) => {
        const entry = this.readOwnedById(jobId);
        if (entry === null || !entry.open || entry.finishing || entry.execution !== options.execution) return undefined;
        const identityKey = providerArtifactIdentityKey(entry.provider, options.identity);
        if (
          !entry.artifactHandles.some(
            (handle) => handle.execution === options.execution && handle.identityKey === identityKey,
          )
        ) {
          commit.append({
            type: 'job.artifact.recorded',
            stream: { kind: 'job', id: jobId },
            refs: { jobId },
            body: {
              execution: options.execution,
              provider: entry.provider,
              handle: options.handle,
              identity: options.identity,
              identityKey,
            },
          });
        }
        result = { ok: true, execution: options.execution };
        return undefined;
      });
      return result;
    });
  }
}
