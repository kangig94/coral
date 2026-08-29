import type { z } from 'zod';

import type { DurableCliProcessEvidence } from '../../src/jobs/carrier-observation.js';
import type { ControlClient } from '../../src/provider-proxy/control-client.js';
import type { HandoffCapsuleV2, HandoffCapsuleV3 } from '../../src/provider-proxy/handoff-capsule.js';
import type { ProviderProxySetAuthorityDependencies } from '../../src/coordinator/live/provider-proxy/set-authority.js';
import type { RoleControlPlan } from '../../src/coordinator/live/provider-proxy/role-control.js';
import {
  type guardianHandoffRedeemResultSchema,
  type ProviderProxyControlRedemptionBundle,
  type ProviderProxyControlRedemptionOutcome,
  type RedeemedProviderProxyControl,
} from '../../src/coordinator/live/provider-proxy/control-redemption.js';
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

declare const rawRedemptionBundle: ProviderProxyControlRedemptionBundle;
declare const structuralRedemptionSuccess: Readonly<{ kind: 'redeemed' }>;
declare const holderString: string;
declare const rawControlClient: ControlClient;
declare const parsedGuardianReply: z.infer<typeof guardianHandoffRedeemResultSchema>;

// @ts-expect-error possession of the holder identity is not proof that all three controls were redeemed.
const holderCannotPromote: RedeemedProviderProxyControl = holderString;
void holderCannotPromote;

// @ts-expect-error one raw control client cannot stand in for the owner-verified three-role bundle.
const rawClientCannotPromote: RedeemedProviderProxyControl = rawControlClient;
void rawClientCannotPromote;

// @ts-expect-error one parsed role reply cannot mint the redemption owner's private success brand.
const parsedReplyCannotPromote: RedeemedProviderProxyControl = parsedGuardianReply;
void parsedReplyCannotPromote;

// @ts-expect-error three raw sessions do not prove that the redemption owner verified and bundled them.
const rawBundleCannotPromote: RedeemedProviderProxyControl = rawRedemptionBundle;
void rawBundleCannotPromote;

// @ts-expect-error a structurally matching literal cannot mint the redemption owner's private success brand.
const literalCannotPromote: RedeemedProviderProxyControl = structuralRedemptionSuccess;
void literalCannotPromote;

declare const refusedRedemption: Extract<ProviderProxyControlRedemptionOutcome, { kind: 'refused' }>;
// @ts-expect-error a decisive refusal is not the unavailable result whose bound A2 may spend.
const refusalIsNotUnavailability: Extract<ProviderProxyControlRedemptionOutcome, { kind: 'unavailable' }> =
  refusedRedemption;
void refusalIsNotUnavailability;

type RecordedDurableCliProcess = Extract<DurableCliProcessEvidence, { kind: 'recorded' }>;
const impossibleMissingTransportEvidence: RecordedDurableCliProcess = {
  kind: 'recorded',
  alive: true,
  matchesRecordedIncarnation: true,
  // @ts-expect-error durable CLI identity has no independent transport-evidence channel.
  transportEvidence: false,
};
void impossibleMissingTransportEvidence;
