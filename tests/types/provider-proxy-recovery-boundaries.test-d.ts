import type { z } from 'zod';

import type { DurableCliProcessEvidence } from '../../src/jobs/carrier-observation.js';
import type { HandoffCapsuleV2, HandoffCapsuleV3 } from '../../src/provider-proxy/handoff-capsule.js';
import type { ProviderProxySetAuthorityDependencies } from '../../src/coordinator/live/provider-proxy/set-authority.js';
import type { RoleControlPlan } from '../../src/coordinator/live/provider-proxy/role-control.js';
import type {
  ProviderProxyRecoveryExactContext,
  ProviderProxyRecoveryProducerInput,
} from '../../src/coordinator/services/provider-proxy-recovery-policy.js';
import type { ProviderProxySetInheritance } from '../../src/coordinator/services/provider-proxy-set/inheritance.js';

declare const capsuleV2: HandoffCapsuleV2;
declare const capsuleV3: HandoffCapsuleV3;
declare const inheritance: ProviderProxySetInheritance;
declare const signal: AbortSignal;

const redemptionV3: ProviderProxyRecoveryProducerInput['capsule-redemption'] = {
  capsule: capsuleV3,
  capsulePath: '/capsule.v3.json',
  signal,
};
void redemptionV3;

const redemptionV2: ProviderProxyRecoveryProducerInput['capsule-redemption'] = {
  // @ts-expect-error a decoded legacy capsule is classified and represented, never handed to redemption.
  capsule: capsuleV2,
  capsulePath: '/capsule.v2.json',
  signal,
};
void redemptionV2;

void inheritance.redeemDiscoveredCapsule(capsuleV3, '/capsule.v3.json', signal);
// @ts-expect-error the inheritance port cannot dial a legacy capsule even if a caller bypasses discovery.
void inheritance.redeemDiscoveredCapsule(capsuleV2, '/capsule.v2.json', signal);

const exactV3: ProviderProxyRecoveryExactContext = { capsule: capsuleV3 };
void exactV3;
// @ts-expect-error exact recovery context is downstream of V3-only classification.
const exactV2: ProviderProxyRecoveryExactContext = { capsule: capsuleV2 };
void exactV2;

type RecoveryCapsule = NonNullable<ProviderProxySetAuthorityDependencies['recoveryCapsule']>;
const authorityV3: RecoveryCapsule = capsuleV3;
void authorityV3;
// @ts-expect-error a set authority can only be built from the V3 capsule that was redeemed.
const authorityV2: RecoveryCapsule = capsuleV2;
void authorityV2;

type Opened = { controlEpoch: number; heartbeatChallenge: string };
declare const _paramsSchema: z.ZodType<{ grantId: string }>;
type GuardianPlan = Extract<RoleControlPlan<Opened, typeof _paramsSchema>, { role: 'guardian' }>;

// @ts-expect-error guardian control cannot call a proxy open method.
const guardianProxyOpen: GuardianPlan['openMethod'] = 'control.open.v1';
void guardianProxyOpen;
// @ts-expect-error guardian control cannot run the proxy heartbeat method.
const guardianProxyHeartbeat: GuardianPlan['heartbeatMethod'] = 'control.heartbeat.v1';
void guardianProxyHeartbeat;
// @ts-expect-error only the proxy role can serve provider events on its control connection.
const guardianProviderEvents: GuardianPlan['onProviderEvent'] = async () => ({
  kind: 'ack',
  committedThroughProviderSeq: 0,
});
void guardianProviderEvents;

type RecordedDurableCliProcess = Extract<DurableCliProcessEvidence, { kind: 'recorded' }>;
const impossibleMissingTransportEvidence: RecordedDurableCliProcess = {
  kind: 'recorded',
  alive: true,
  matchesRecordedIncarnation: true,
  // @ts-expect-error durable CLI identity has no independent transport-evidence channel.
  transportEvidence: false,
};
void impossibleMissingTransportEvidence;
