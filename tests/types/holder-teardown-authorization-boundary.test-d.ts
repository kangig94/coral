import type { ControlEpoch, ControlTenancyHolder } from '#src/provider-proxy/control-endpoint.js';
import {
  controlHolderAuthorizationIsCurrent,
  type ControlHolderAuthority,
  type ExplicitTeardownAuthorization,
  type ObservedHolderAbsenceAuthorization,
} from '#src/provider-proxy/holder-lifecycle.js';
import type { LocalSignalTeardownAuthorization } from '#src/provider-proxy/enforcement.js';

declare const authority: ControlHolderAuthority;
declare const absence: ObservedHolderAbsenceAuthorization;
declare const explicitTeardown: ExplicitTeardownAuthorization;
declare const localSignal: LocalSignalTeardownAuthorization;

// @ts-expect-error observed absence and explicit containment meet only inside the enforcer's private reap;
// neither may stand in for the other, despite carrying identical public fields.
const absenceCannotBeExplicit: ExplicitTeardownAuthorization = absence;
void absenceCannotBeExplicit;

// @ts-expect-error the reverse direction of the same non-substitutability.
const explicitCannotBeAbsence: ObservedHolderAbsenceAuthorization = explicitTeardown;
void explicitCannotBeAbsence;

declare const holder: ControlTenancyHolder;
declare const controlEpoch: ControlEpoch;

// @ts-expect-error a matching object literal — the exact two public fields, nothing more — must not inhabit
// the branded capability. Only `observeControlHolder`'s own mint on canonical `absent` may construct one.
const forgedAbsence: ObservedHolderAbsenceAuthorization = { controlEpoch, holder };
void forgedAbsence;

// @ts-expect-error the same forgery must fail for explicit containment too.
const forgedExplicit: ExplicitTeardownAuthorization = { controlEpoch, holder };
void forgedExplicit;

// `LocalSignalTeardownAuthorization` — constructible only inside a role's own signal handler, whose
// precondition (this process was signalled) is unrelated to any control-epoch/holder binding — is a third
// capability non-substitutable with the two above, in both directions.

// @ts-expect-error a local-signal capability cannot stand in for observed absence.
const localSignalCannotBeAbsence: ObservedHolderAbsenceAuthorization = localSignal;
void localSignalCannotBeAbsence;

// @ts-expect-error the reverse direction of the same non-substitutability.
const absenceCannotBeLocalSignal: LocalSignalTeardownAuthorization = absence;
void absenceCannotBeLocalSignal;

// @ts-expect-error a local-signal capability cannot stand in for an explicit peer-credentialled teardown.
const localSignalCannotBeExplicit: ExplicitTeardownAuthorization = localSignal;
void localSignalCannotBeExplicit;

// @ts-expect-error the reverse direction of the same non-substitutability.
const explicitCannotBeLocalSignal: LocalSignalTeardownAuthorization = explicitTeardown;
void explicitCannotBeLocalSignal;

// @ts-expect-error a matching empty object literal must not inhabit the branded capability either — only
// `mintLocalSignalTeardownAuthorization` may construct one.
const forgedLocalSignal: LocalSignalTeardownAuthorization = {};
void forgedLocalSignal;

// @ts-expect-error the currency check accepts only the two capabilities a successor can revoke; a
// local-signal capability has no `{ controlEpoch, holder }` binding for a successor to revoke.
controlHolderAuthorizationIsCurrent(authority, localSignal);
