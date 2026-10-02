import {
  jointActivationReceiptSchema,
  jointContainmentReceiptSchema,
  reservationSchema,
} from '#src/provider-proxy/protocol.js';

export function asJointActivationReceipt(value: string) {
  return jointActivationReceiptSchema.parse(value);
}

export function asReservation(value: string) {
  return reservationSchema.parse(value);
}

export function asJointContainmentReceipt(value: string) {
  return jointContainmentReceiptSchema.parse(value);
}
