import {
  immutablePlainSnapshot,
  readOptionalOwnDataProperty,
  readOwnDataProperty,
} from '../../../infra/immutable-snapshot.js';
import type { JobConversation } from '../../../jobs/conversation/entry.js';
import { hydrateJobConversation } from '../../../jobs/conversation/projections.js';
import type { BoundProvider } from '../../../providers/bound-provider-contract.js';
import type { ProviderContinuityBlob } from '../../../jobs/conversation/continuity.js';
import type {
  ProviderRecoveryAuthority,
  ProviderRecoveryLaunch,
  ProviderRecoverySession,
} from '../../../jobs/reconcile/contracts.js';
import type { RawCoordinatorConversationRow } from './coordinator-job-source.js';

export function hydrateCoordinatorConversationAuthority(raw: RawCoordinatorConversationRow): JobConversation {
  return hydrateJobConversation(raw);
}

export function snapshotProviderRecoveryAuthority(
  launchRecord: ProviderRecoveryLaunch,
  session: JobConversation,
  boundProvider: BoundProvider,
  providerContinuity: ProviderContinuityBlob | undefined,
): ProviderRecoveryAuthority {
  return Object.freeze({
    launchRecord: snapshotRecoveryLaunch(launchRecord),
    session: snapshotRecoverySession(session, providerContinuity),
    boundProvider,
  });
}

function snapshotRecoveryLaunch(launchRecord: ProviderRecoveryLaunch): ProviderRecoveryLaunch {
  const label = 'Provider recovery launch';
  const requestSource = readOwnDataProperty(launchRecord, 'request', label);
  const requestLabel = `${label}.request`;
  const bundleHash = readOptionalOwnDataProperty(launchRecord, 'bundleHash', label);
  const discussionRun = readOptionalOwnDataProperty(launchRecord, 'discussionRun', label);
  const parentWorkflowJobId = readOptionalOwnDataProperty(launchRecord, 'parentWorkflowJobId', label);
  const workflowSlotId = readOptionalOwnDataProperty(launchRecord, 'workflowSlotId', label);
  const name = readOptionalOwnDataProperty(requestSource, 'name', requestLabel);
  const model = readOptionalOwnDataProperty(requestSource, 'model', requestLabel);
  const effort = readOptionalOwnDataProperty(requestSource, 'effort', requestLabel);
  const systemPrompt = readOptionalOwnDataProperty(requestSource, 'systemPrompt', requestLabel);
  const instruction = readOptionalOwnDataProperty(requestSource, 'instruction', requestLabel);
  const retention = readOptionalOwnDataProperty(requestSource, 'retention', requestLabel);

  return immutablePlainSnapshot(
    {
      jobId: readOwnDataProperty(launchRecord, 'jobId', label),
      owner: readOwnDataProperty(launchRecord, 'owner', label),
      execution: readOwnDataProperty(launchRecord, 'execution', label),
      provider: readOwnDataProperty(launchRecord, 'provider', label),
      projectRoot: readOwnDataProperty(launchRecord, 'projectRoot', label),
      backendNamespace: readOwnDataProperty(launchRecord, 'backendNamespace', label),
      ...(bundleHash === undefined ? {} : { bundleHash }),
      jobKind: readOwnDataProperty(launchRecord, 'jobKind', label),
      pool: readOwnDataProperty(launchRecord, 'pool', label),
      enqueueSequence: readOwnDataProperty(launchRecord, 'enqueueSequence', label),
      createdAt: readOwnDataProperty(launchRecord, 'createdAt', label),
      ...(discussionRun === undefined ? {} : { discussionRun }),
      providerAction: readOwnDataProperty(launchRecord, 'providerAction', label),
      ...(parentWorkflowJobId === undefined ? {} : { parentWorkflowJobId }),
      ...(workflowSlotId === undefined ? {} : { workflowSlotId }),
      request: {
        prompt: readOwnDataProperty(requestSource, 'prompt', requestLabel),
        cwd: readOwnDataProperty(requestSource, 'cwd', requestLabel),
        bypassPermissions: readOwnDataProperty(requestSource, 'bypassPermissions', requestLabel),
        coralEnv: readOwnDataProperty(requestSource, 'coralEnv', requestLabel),
        ...(name === undefined ? {} : { name }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        ...(instruction === undefined ? {} : { instruction }),
        ...(retention === undefined ? {} : { retention }),
      },
    },
    label,
  );
}

function snapshotRecoverySession(
  session: JobConversation,
  providerContinuity: ProviderContinuityBlob | undefined,
): ProviderRecoverySession {
  const label = 'Provider recovery session';
  const conversationRef = readOptionalOwnDataProperty(session, 'conversationRef', label);
  const artifactHandles = immutablePlainSnapshot(
    readOwnDataProperty(session, 'artifactHandles', label),
    `${label}.artifactHandles`,
  );
  const minimalArtifactHandles = artifactHandles.map((artifact, index) => ({
    handle: readOwnDataProperty(artifact, 'handle', `${label}.artifactHandles[${index}]`),
    identity: readOwnDataProperty(artifact, 'identity', `${label}.artifactHandles[${index}]`),
    sourceJobId: readOwnDataProperty(artifact, 'sourceJobId', `${label}.artifactHandles[${index}]`),
  }));

  return immutablePlainSnapshot(
    {
      jobId: readOwnDataProperty(session, 'jobId', label),
      projectRoot: readOwnDataProperty(session, 'projectRoot', label),
      ...(conversationRef === undefined ? {} : { conversationRef }),
      providerContinuity: providerContinuity ?? null,
      artifactHandles: minimalArtifactHandles,
      execution: readOwnDataProperty(session, 'execution', label),
    },
    label,
  );
}
