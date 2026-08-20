import { createOperationLedger } from '#src/provider-proxy/ledger.js';
import type { JointActivationReceipt, JointContainmentReceipt, Reservation } from '#src/provider-proxy/protocol.js';

/**
 * The compile-time half of the correlation guarantees, kept where `tsc -p tsconfig/typecheck.json` will run it
 * in CI rather than only in a mutation somebody performed once and reverted.
 *
 * Each `@ts-expect-error` below is a defect this branch actually shipped or nearly shipped, expressed as the
 * smallest program that would reintroduce it. If a signature ever loosens, the `@ts-expect-error` stops being
 * an error and this file fails — which is the property a hand-run mutation does not have.
 */

declare const reservation: Reservation;
declare const containment: JointContainmentReceipt;
declare const activation: JointActivationReceipt;
declare const rawUuid: string;

const ledger = createOperationLedger<{ readonly prepared: true }>();
const key = { jobId: 'j', operationId: 'o' };

// @ts-expect-error one value cannot half-match, and the arity is what makes the old shape unwritable.
ledger.beginActivation(key, reservation, reservation, 0, 'f'.repeat(64));

ledger.beginActivation(key, reservation, 0, 'f'.repeat(64));

// @ts-expect-error the reservation must have been received, not typed into existence. This is the exact shape
// of the defect that made every activation fail `identity_mismatch`: a fresh value where a forwarded one belongs.
ledger.beginActivation(key, rawUuid, 0, 'f'.repeat(64));

// @ts-expect-error two receipts travel in the same message and are not interchangeable — presenting one where
// the other belongs is a different mistake, and the brands are what tell them apart.
const crossed: JointContainmentReceipt = activation;
void crossed;

const kept: JointContainmentReceipt = containment;
void kept;

// @ts-expect-error the ledger's own record holds a received receipt, not any string.
ledger.recordContainmentReceipt(key, rawUuid);

ledger.recordContainmentReceipt(key, containment);
