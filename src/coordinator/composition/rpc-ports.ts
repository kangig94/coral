import {
  ADMISSION_READ_TIMEOUT_MS,
  AdmissionProjectionReadUnavailableError,
  readAdmissionProjection,
} from '../../jobs/admission-read.js';
import type { TimePort } from '../../infra/port-types.js';
import type { Database } from '../../store/db.js';
import type { JobSendRequest } from '../services/job-send.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import { readProjectionJobAddress, readProjectionJobRow } from '../../jobs/projection-row.js';
import { malformedConversationSendRefusal, type JobSendResult } from '../../jobs/send.js';
import { findCommittedExecutionRequest } from '../../jobs/execution-journal.js';
import { ZodError } from 'zod';

import { throwIfRequestAborted } from '../../runtime/request-lease-identity.js';
import { assertNever } from '../../infra/error-format.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { isLivePhase } from '../../jobs/phase.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import { type JobAddressing } from '../../jobs/addressing.js';
import type { JobAttention } from '../services/job-attention.js';
import {
  ProjectionConversationMalformedError,
  type JobsListResponse,
  type JobsReleaseResult,
} from '../../jobs/records.js';
import type { JobStore } from '../../jobs/store.js';
import {
  providerHostEvictResponseSchema,
  providerHostInspectResponseSchema,
  providerHostListV2ResponseSchema,
  providerProxySetContainResponseSchema,
  providerProxySetContainBooleanResponseSchema,
  type ProviderProxySetContainRequest,
  type ProviderProxySetContainBooleanResponse,
  type ProviderProxySetContainResponse,
} from '../../transport/rpc/catalog.js';
import type { RpcPorts } from '../../transport/rpc/ports.js';
import {
  handleDiscussAbort,
  handleDiscussBid,
  handleDiscussSeed,
  handleDiscussSpeech,
  handleDiscussStart,
  handleDiscussWatch,
} from '../../discuss/shell/tools.js';
import { listDiscussSessions, loadDiscussDetail } from '../../discuss/shell/session-read-service.js';
import { type createDiscussRuntime } from '../../discuss/shell/runtime-services.js';
import { type createExecutionServices } from './execution-services.js';
import { type createCoordinatorWorld } from './world.js';
import { type ProviderHostAdministrationService } from '../services/provider-host-administration.js';
import type { ProviderProxySetBooleanOperatorExitResult } from '../services/provider-proxy-set/index.js';

type ProviderProxySetContainSuccess = Extract<ProviderProxySetContainResponse, { kind: 'contained' | 'abandoned' }>;
type ProviderProxySetContainBooleanSuccess = Extract<
  ProviderProxySetContainBooleanResponse,
  { kind: 'contained' | 'abandoned' | 'unattributable-group-abandoned' }
>;

function providerProxySetContainBooleanClaimDischarge(
  discharge: ProviderProxySetContainSuccess['claimDischarge'],
): ProviderProxySetContainBooleanSuccess['claimDischarge'] {
  switch (discharge.kind) {
    case 'completed':
      return discharge;
    case 'initial-disposition-pending':
      return { kind: 'initial-disposition-retry-owned' };
    case 'operational-retry-owned':
      return { kind: discharge.kind, incidents: discharge.incidents };
    case 'released-undischarged':
      return discharge;
    default:
      return assertNever(discharge);
  }
}

function providerProxySetContainBooleanResponse(
  response: ProviderProxySetBooleanOperatorExitResult,
): ProviderProxySetContainBooleanResponse {
  if (response.kind === 'contained') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'unattributable-group-abandoned') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'abandoned') {
    return providerProxySetContainBooleanResponseSchema.parse({
      ...response,
      claimDischarge: providerProxySetContainBooleanClaimDischarge(response.claimDischarge),
    });
  }
  if (response.kind === 'not-held' && response.state === 'reattachment-hold') {
    return providerProxySetContainBooleanResponseSchema.parse({ ...response, state: 'reattaching' });
  }
  return providerProxySetContainBooleanResponseSchema.parse(response);
}

function createCoordinatorJobLister(
  getProgressStore: () => JobStore,
  attention: JobAttention,
  admitWait: JobAddressing['admitWait'],
): RpcPorts['jobs']['list'] {
  return (filters) => {
    const progressStore = getProgressStore();
    const jobs: JobsListResponse['jobs'] = [];
    for (const entry of progressStore.listJobProjections()) {
      if ((filters.all !== true || filters.owner !== undefined) && !isLivePhase(entry.status.phase)) {
        continue;
      }
      if (filters.projectRoot !== undefined && !jobInCallerScope(entry.status, filters.projectRoot, 'exact')) {
        continue;
      }
      if (filters.phase !== undefined && entry.status.phase !== filters.phase) {
        continue;
      }
      if (filters.provider !== undefined && entry.status.provider !== filters.provider) {
        continue;
      }
      if (filters.owner !== undefined) {
        const launch = progressStore.loadJobProjectionDetail(entry.jobId).launch;
        if (
          launch === null ||
          !('coralEnv' in launch.request) ||
          launch.request.coralEnv.CORAL_OWNER !== filters.owner
        ) {
          continue;
        }
      }
      if (filters.unwaited === true && !attention.isUnwaited(entry.jobId, entry.status.execution ?? 0)) continue;
      jobs.push({
        ...entry,
        execution: entry.status.execution,
        ...(attention.isReleased(entry.jobId, entry.status.execution ?? 0) ? { released: true } : {}),
      });
    }

    if (filters.unwaited === true && jobs.length > 0) {
      const admissions = admitWait({ jobIds: jobs.map(({ jobId }) => jobId) });
      for (const job of jobs) {
        const admission = admissions.find((admission) => admission.jobId === job.jobId);
        if (
          admission?.disposition === 'admitted' &&
          !admission.observationDeferred &&
          admission.detail?.status.execution === job.execution &&
          admission.selection !== undefined
        )
          job.executionSelection = admission.selection;
      }
    }
    return jobs;
  };
}

function malformedConversationSendOutcome(
  db: Database,
  request: JobSendRequest,
  error: ProjectionConversationMalformedError,
): JobSendResult {
  const uncertain = (evidence: string): JobSendResult => ({
    state: 'unknown',
    conversationEvidenceFailure: true,
    reason: `${evidence} This retry did not admit another execution or deliver input. An earlier attempt may have delivered this message. ${conversationSendEvidenceFacts(error)}`,
  });
  try {
    const replay = findCommittedExecutionRequest(db, request.jobId, request.clientMessageId);
    if (replay !== null)
      return uncertain(
        'Saved conversation evidence is malformed and a committed execution request already exists for this message identity.',
      );
    if (request.target.mode === 'steer')
      return uncertain(
        'Saved conversation evidence is malformed and prior steering delivery could not be established.',
      );
  } catch {
    return uncertain(
      'Saved conversation evidence is malformed and committed-request replay evidence could not be read.',
    );
  }
  return malformedConversationSendRefusal(request.jobId);
}

type SendReadEvidence = Pick<NonNullable<ReturnType<typeof readProjectionJobAddress>>, 'workDir' | 'owner'>;

function conversationSendEvidenceFacts(evidence: SendReadEvidence | null): string {
  const location =
    evidence === null || evidence.workDir === null
      ? 'The recorded work directory is unavailable.'
      : `Recorded work directory: ${JSON.stringify(evidence.workDir)}.`;
  const ownership =
    evidence === null || evidence.owner === null
      ? 'Ownership could not be established. This failure belongs to the owning operation.'
      : evidence.owner.kind === 'provider-session'
        ? `Execution owner: provider-session ${evidence.owner.id}.`
        : `This failure belongs to the owning ${evidence.owner.kind} operation ${evidence.owner.id}.`;
  return `${location} ${ownership}`.trim();
}

function unavailableSendReadOutcome(
  error: AdmissionProjectionReadUnavailableError,
  evidence: SendReadEvidence | null,
): JobSendResult {
  return {
    state: 'unknown',
    conversationEvidenceFailure: true,
    reason: `${error.message} This attempt did not admit an execution or deliver input. An earlier attempt may have delivered this message. ${conversationSendEvidenceFacts(evidence)}`,
  };
}

async function readSendPrerequisites(
  db: Database,
  request: JobSendRequest,
  time: Pick<TimePort, 'now' | 'sleep'>,
): Promise<{ address: ReturnType<typeof readProjectionJobAddress>; deadline: number } | { outcome: JobSendResult }> {
  const deadline = time.now() + ADMISSION_READ_TIMEOUT_MS;
  let address: ReturnType<typeof readProjectionJobAddress> = null;
  try {
    address = await readAdmissionProjection(() => readProjectionJobAddress(db, request.jobId), time, deadline);
    if (address !== null && !jobInCallerScope(address, request.projectRoot, 'contains'))
      return { outcome: { state: 'refused', code: 'scope_mismatch', reason: 'The job belongs to another project.' } };
    await readAdmissionProjection(() => readProjectionJobRow(db, request.jobId), time, deadline);
    return { address, deadline };
  } catch (error) {
    if (error instanceof ProjectionConversationMalformedError)
      return { outcome: malformedConversationSendOutcome(db, request, error) };
    if (error instanceof AdmissionProjectionReadUnavailableError)
      return { outcome: unavailableSendReadOutcome(error, address) };
    throw error;
  }
}

export function createCoordinatorRpcPorts({
  services,
  jobAddressing,
  waitHandoverSignal,
  getProgressStore,
  world,
  recoveryQuarantine,
  providerHostAdministration,
  containProviderProxySet,
  kbRpcPort,
  discuss,
  expansion,
  createOwnerInvocationContext,
  time,
}: {
  services: ReturnType<typeof createExecutionServices>;
  createOwnerInvocationContext(projectRoot: string): InvocationContext;
  time: Pick<TimePort, 'now' | 'sleep'>;
  jobAddressing: JobAddressing;
  waitHandoverSignal: () => AbortSignal;
  getProgressStore: () => JobStore;
  world: ReturnType<typeof createCoordinatorWorld>;
  recoveryQuarantine: RpcPorts['recoveryQuarantine'];
  providerHostAdministration: ProviderHostAdministrationService;
  containProviderProxySet: (
    request: ProviderProxySetContainRequest,
    contract: 'current' | 'boolean',
    abandonWithoutAbsence: boolean,
    signal?: AbortSignal,
  ) => Promise<ProviderProxySetBooleanOperatorExitResult | Readonly<{ kind: 'unsupported-contract' }>>;
  kbRpcPort: RpcPorts['kb'];
  discuss: ReturnType<typeof createDiscussRuntime>;
  expansion: RpcPorts['expansion'];
}): RpcPorts {
  return {
    sessions: {
      start: (providerName, input, ctx, signal) =>
        services.getExecutionService(ctx).start(providerName, input, ctx, signal),
    },
    jobs: {
      admitWait: (request) => jobAddressing.admitWait(request),
      snapshot: (request) => jobAddressing.snapshot(request),
      scopeCheck: (jobIds, callerRoot, relation) => {
        const result = { valid: [] as string[], missing: [] as string[], mismatch: [] as string[] };
        for (const jobId of jobIds) {
          const address = readProjectionJobAddress(getProgressStore().getDb(), jobId);
          if (address === null) {
            const historical = jobAddressing.scopeCheck([jobId], callerRoot, relation);
            result.valid.push(...historical.valid);
            result.missing.push(...historical.missing);
            result.mismatch.push(...historical.mismatch);
          } else if (jobInCallerScope(address, callerRoot, relation)) result.valid.push(jobId);
          else result.mismatch.push(jobId);
        }
        return result;
      },
      abort: (jobIds) => jobAddressing.abort(jobIds),
      send: async (request, ctx) => {
        const prerequisite = await readSendPrerequisites(getProgressStore().getDb(), request, time);
        if ('outcome' in prerequisite) return prerequisite.outcome;
        const ownerContext =
          prerequisite.address === null ? ctx : createOwnerInvocationContext(prerequisite.address.projectRoot);
        try {
          return await services
            .getExecutionService(ownerContext)
            .send({ ...request, conversationReadDeadline: prerequisite.deadline }, ctx);
        } catch (error) {
          if (error instanceof AdmissionProjectionReadUnavailableError)
            return unavailableSendReadOutcome(error, prerequisite.address);
          throw error;
        }
      },
      release: (jobIds) => {
        const result: JobsReleaseResult = { released: [], unknown: [], terminal: [] };
        for (const jobId of jobIds) {
          const status = getProgressStore().loadJobProjectionDetail(jobId).status;
          if (status === null) result.unknown.push(jobId);
          else if (!isLivePhase(status.phase)) result.terminal.push(jobId);
          else {
            services.jobAttention.release(jobId, status.execution ?? 0);
            result.released.push(jobId);
          }
        }
        return result;
      },
      waitStream: (request) =>
        services.jobAttention.waitStream(
          request,
          (scoped) => jobAddressing.admitWait(scoped),
          (scoped) => jobAddressing.waitStream(scoped),
        ),
      waitHandoverSignal,
      list: createCoordinatorJobLister(getProgressStore, services.jobAttention, (request) =>
        jobAddressing.admitWait(request),
      ),
      detail: (jobId) => jobAddressing.detail(jobId),
      unknownJobDisposition: () => jobAddressing.unknownJobDisposition(),
      unknownJobCaveat: () => jobAddressing.unknownJobCaveat(),
    },
    workflows: {
      execute: async (request, ctx, signal) => {
        try {
          throwIfRequestAborted(signal);
          const compiled = workflowCompiler.compile(request, world.providerRegistry);
          const decision =
            'status' in compiled
              ? compiled
              : await workflowCommands.execute(services.getExecutionService(ctx), compiled, ctx, signal);
          return { kind: 'decision' as const, decision };
        } catch (error: unknown) {
          if (isWorkflowInputFailure(error)) {
            if (error instanceof ZodError) {
              const first = error.issues[0];
              const path = first?.path.join('.') ?? '';
              let message = error.message;
              if (first !== undefined) {
                message = path.length > 0 ? `${path}: ${first.message}` : first.message;
              }
              return { kind: 'invalid_request' as const, message, detail: { issues: error.issues } };
            }
            return { kind: 'invalid_request' as const, message: error.message };
          }
          throw error;
        }
      },
    },
    recoveryQuarantine,
    providerHosts: {
      list: async () => {
        const { rows, tornDownOwnerIds } = await providerHostAdministration.list();
        return providerHostListV2ResponseSchema.parse({ hosts: rows, tornDownOwnerIds });
      },
      inspect: async (selector) =>
        providerHostInspectResponseSchema.parse({
          host: await providerHostAdministration.inspect(selector),
        }),
      evict: async (selector, signal) =>
        providerHostEvictResponseSchema.parse(await providerHostAdministration.evict(selector, signal)),
    },
    providerProxySets: {
      contain: async (request, signal) =>
        providerProxySetContainResponseSchema.parse(
          await containProviderProxySet(request, 'current', request.mode === 'abandon', signal),
        ),
      containBoolean: async (request, signal) => {
        const result = await containProviderProxySet(
          { setIdentity: request.setIdentity, mode: 'contain' },
          'boolean',
          request.abandonWithoutAbsence,
          signal,
        );
        return result.kind === 'unsupported-contract' ? result : providerProxySetContainBooleanResponse(result);
      },
    },
    kb: kbRpcPort,
    discuss: {
      seed: handleDiscussSeed,
      start: (args, ctx, signal) =>
        handleDiscussStart(args, ctx, { getDiscussContext: discuss.getDiscussContext }, signal),
      listSessions: () => listDiscussSessions(discuss.readHelpersDeps),
      loadDetail: (projectRoot, sessionId, view) =>
        loadDiscussDetail(discuss.readHelpersDeps, world.resolveProjectSource(projectRoot), sessionId, view),
      watch: (args, ctx) => handleDiscussWatch(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      bid: (args, ctx) => handleDiscussBid(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      speech: (args, ctx) => handleDiscussSpeech(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
      abort: (args, ctx) => handleDiscussAbort(args, ctx, { getDiscussContext: discuss.getDiscussContext }),
    },
    expansion,
  };
}
