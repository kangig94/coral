import type { ControlEpoch, ControlTenancyHolder } from '#src/provider-proxy/control-endpoint.js';
import {
  controlHolderAuthorizationIsCurrent,
  type ControlHolderAuthority,
  type ExplicitTeardownAuthorization,
  type ObservedHolderAbsenceAuthorization,
  type OperatorTeardownAuthorization,
} from '#src/provider-proxy/holder-lifecycle.js';

declare const authority: ControlHolderAuthority;
declare const absence: ObservedHolderAbsenceAuthorization;
declare const explicitTeardown: ExplicitTeardownAuthorization;
declare const operatorTeardown: OperatorTeardownAuthorization;

// @ts-expect-error observed absence and explicit containment meet only inside the enforcer's private reap;
// neither may stand in for the other, despite carrying identical public fields.
const absenceCannotBeExplicit: ExplicitTeardownAuthorization = absence;
void absenceCannotBeExplicit;

// @ts-expect-error the reverse direction of the same non-substitutability.
const explicitCannotBeAbsence: ObservedHolderAbsenceAuthorization = explicitTeardown;
void explicitCannotBeAbsence;

// @ts-expect-error the operator override cannot be constructed from an observed-absence capability.
const absenceCannotBeOperator: OperatorTeardownAuthorization = absence;
void absenceCannotBeOperator;

// @ts-expect-error the operator override cannot be constructed from an explicit-teardown capability either.
const explicitCannotBeOperator: OperatorTeardownAuthorization = explicitTeardown;
void explicitCannotBeOperator;

// @ts-expect-error and the operator override cannot authorize either enforcer path.
const operatorCannotBeAbsence: ObservedHolderAbsenceAuthorization = operatorTeardown;
void operatorCannotBeAbsence;

// @ts-expect-error same direction, against explicit containment.
const operatorCannotBeExplicit: ExplicitTeardownAuthorization = operatorTeardown;
void operatorCannotBeExplicit;

declare const holder: ControlTenancyHolder;
declare const controlEpoch: ControlEpoch;

// @ts-expect-error a matching object literal — the exact two public fields, nothing more — must not inhabit
// the branded capability. Only `observeControlHolder`'s own mint on canonical `absent` may construct one.
const forgedAbsence: ObservedHolderAbsenceAuthorization = { controlEpoch, holder };
void forgedAbsence;

// @ts-expect-error the same forgery must fail for explicit containment too.
const forgedExplicit: ExplicitTeardownAuthorization = { controlEpoch, holder };
void forgedExplicit;

// @ts-expect-error the operator override carries no public fields at all, so an empty object literal must
// still fail to inhabit it — the brand is the only thing that can.
const forgedOperator: OperatorTeardownAuthorization = {};
void forgedOperator;

// @ts-expect-error the currency check accepts only the two capabilities a successor can revoke; the operator
// override is deliberately not one of them.
controlHolderAuthorizationIsCurrent(authority, operatorTeardown);
