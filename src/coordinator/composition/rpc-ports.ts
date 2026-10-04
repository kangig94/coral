import { ZodError } from 'zod';

import { throwIfRequestAborted } from '../../runtime/request-lease-identity.js';
import { assertNever } from '../../infra/error-format.js';
import { isWorkflowInputFailure, workflowCompiler } from '../../workflow/compile.js';
import { workflowCommands } from '../../workflow/dispatch.js';
import { isLivePhase } from '../../jobs/phase.js';
import { jobInCallerScope } from '../../jobs/scope.js';
import { type JobAddressing } from '../../jobs/addressing.js';
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

function createCoordinatorJobLister(getProgressStore: () => JobStore): RpcPorts['jobs']['list'] {
  return (filters) => {
    const progressStore = getProgressStore();
    const jobs: ReturnType<typeof progressStore.listJobProjections> = [];
    for (const entry of progressStore.listJobProjections()) {
      if (filters.all !== true && !isLivePhase(entry.status.phase)) {
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
      jobs.push(entry);
    }

    return jobs;
  };
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
}: {
  services: ReturnType<typeof createExecutionServices>;
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
      scopeCheck: (jobIds, callerRoot, relation) => jobAddressing.scopeCheck(jobIds, callerRoot, relation),
      abort: (jobIds) => jobAddressing.abort(jobIds),
      validateWait: (request) => jobAddressing.validateWait(request),
      waitStream: (request) => jobAddressing.waitStream(request),
      waitHandoverSignal,
      list: createCoordinatorJobLister(getProgressStore),
      detail: (jobId) => jobAddressing.detail(jobId),
      unknownJobDisposition: () => jobAddressing.unknownJobDisposition(),
      unknownJobCaveat: () => jobAddressing.unknownJobCaveat(),
      outcomeUnrecoverable: (jobIds) => jobAddressing.outcomeUnrecoverable(jobIds),
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
