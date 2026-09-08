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

// @ts-expect-error absence and explicit-containment authorities must remain non-substitutable.
const absenceCannotBeExplicit: ExplicitTeardownAuthorization = absence;
void absenceCannotBeExplicit;

// @ts-expect-error explicit-containment authority cannot stand in for absence authority.
const explicitCannotBeAbsence: ObservedHolderAbsenceAuthorization = explicitTeardown;
void explicitCannotBeAbsence;

declare const holder: ControlTenancyHolder;
declare const controlEpoch: ControlEpoch;

// @ts-expect-error structural matches must not forge absence authority.
const forgedAbsence: ObservedHolderAbsenceAuthorization = { controlEpoch, holder };
void forgedAbsence;

// @ts-expect-error structural matches must not forge explicit-containment authority.
const forgedExplicit: ExplicitTeardownAuthorization = { controlEpoch, holder };
void forgedExplicit;

// @ts-expect-error a local-signal capability cannot stand in for observed absence.
const localSignalCannotBeAbsence: ObservedHolderAbsenceAuthorization = localSignal;
void localSignalCannotBeAbsence;

// @ts-expect-error absence authority cannot stand in for local-signal authority.
const absenceCannotBeLocalSignal: LocalSignalTeardownAuthorization = absence;
void absenceCannotBeLocalSignal;

// @ts-expect-error a local-signal capability cannot stand in for an explicit peer-credentialled teardown.
const localSignalCannotBeExplicit: ExplicitTeardownAuthorization = localSignal;
void localSignalCannotBeExplicit;

// @ts-expect-error explicit-containment authority cannot stand in for local-signal authority.
const explicitCannotBeLocalSignal: LocalSignalTeardownAuthorization = explicitTeardown;
void explicitCannotBeLocalSignal;

// @ts-expect-error structural matches must not forge local-signal authority.
const forgedLocalSignal: LocalSignalTeardownAuthorization = {};
void forgedLocalSignal;

// @ts-expect-error successor-revocable currency checks must reject local-signal authority.
controlHolderAuthorizationIsCurrent(authority, localSignal);
