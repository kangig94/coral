import type { JointActivationReceipt, JointContainmentReceipt, Reservation } from '#src/provider-proxy/protocol.js';

/**
 * Casts for the branded correlation values of the provider-proxy control protocol.
 *
 * Production code can only obtain one of these by originating it at its own authority or by parsing a message
 * that carried it — that is the whole point of the brands, and it is why a `runtime.ids.uuid()` handed to a
 * field expecting one no longer compiles. A test double is neither of those: it names a value in order to
 * stand in for a party, so it needs a way in.
 *
 * One cast per brand, in one file, rather than a cast at each of the sites that need one. That keeps the
 * escape hatch countable — and it is worth being plain that this means the guarantee can only ever be
 * demonstrated by production code. A test proves behaviour; it cannot prove that minting is confined,
 * because the helper below is itself a mint.
 */
export function asJointActivationReceipt(value: string): JointActivationReceipt {
  return value as JointActivationReceipt;
}

export function asReservation(value: string): Reservation {
  return value as Reservation;
}

export function asJointContainmentReceipt(value: string): JointContainmentReceipt {
  return value as JointContainmentReceipt;
}
