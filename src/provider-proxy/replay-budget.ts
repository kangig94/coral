export type ReplayAdmissionKind = 'ordinary' | 'completion' | 'emergency-completion';

export type ReplayCharge = Readonly<{
  sharedBytes: number;
  completionSlotBytes: number;
}>;

export type ReplayBudgetUsage = Readonly<{
  sharedBytes: number;
  completionSlotBytes: number;
  totalBytes: number;
}>;

export type ReplayAdmissionScope =
  | 'operation-events'
  | 'operation-bytes'
  | 'proxy-shared-bytes'
  | 'completion-frame-bytes';

export class ReplayAdmissionError extends Error {
  readonly code = 'replay_admission_refused' as const;
  readonly scope: ReplayAdmissionScope;

  constructor(scope: ReplayAdmissionScope, message: string) {
    super(message);
    this.name = 'ReplayAdmissionError';
    this.scope = scope;
    Object.setPrototypeOf(this, ReplayAdmissionError.prototype);
  }
}

function requireByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

export class ReplayBudget {
  readonly #sharedCapacityBytes: number;
  readonly #completionCapacityBytes: number;
  #sharedBytes = 0;
  #completionSlotBytes = 0;

  constructor(sharedCapacityBytes: number, completionCapacityBytes: number) {
    requireByteCount(sharedCapacityBytes, 'Shared replay capacity');
    requireByteCount(completionCapacityBytes, 'Completion replay capacity');
    if (sharedCapacityBytes === 0 || completionCapacityBytes === 0) {
      throw new TypeError('Replay capacities must be positive.');
    }
    this.#sharedCapacityBytes = sharedCapacityBytes;
    this.#completionCapacityBytes = completionCapacityBytes;
  }

  commit(
    input: Readonly<{ kind: ReplayAdmissionKind; frameBytes: number; completionSlotLimitBytes: number }>,
  ): ReplayCharge {
    requireByteCount(input.frameBytes, 'Replay frame bytes');
    requireByteCount(input.completionSlotLimitBytes, 'Completion slot limit');

    const completionSlotBytes =
      input.kind === 'ordinary' ? 0 : Math.min(input.frameBytes, input.completionSlotLimitBytes);
    const sharedBytes = input.frameBytes - completionSlotBytes;
    if (this.#sharedBytes + sharedBytes > this.#sharedCapacityBytes) {
      throw new ReplayAdmissionError('proxy-shared-bytes', 'The proxy shared replay byte budget is exhausted.');
    }
    if (this.#completionSlotBytes + completionSlotBytes > this.#completionCapacityBytes) {
      throw new ReplayAdmissionError('completion-frame-bytes', 'The proxy completion replay slots are exhausted.');
    }

    const charge = Object.freeze({ sharedBytes, completionSlotBytes });
    this.#sharedBytes += charge.sharedBytes;
    this.#completionSlotBytes += charge.completionSlotBytes;
    return charge;
  }

  release(charge: ReplayCharge): void {
    requireByteCount(charge.sharedBytes, 'Released shared replay bytes');
    requireByteCount(charge.completionSlotBytes, 'Released completion slot bytes');
    if (charge.sharedBytes > this.#sharedBytes || charge.completionSlotBytes > this.#completionSlotBytes) {
      throw new RangeError('Released replay bytes must be part of the committed budget.');
    }
    this.#sharedBytes -= charge.sharedBytes;
    this.#completionSlotBytes -= charge.completionSlotBytes;
  }

  isExhausted(): boolean {
    return (
      this.#sharedBytes >= this.#sharedCapacityBytes ||
      this.#sharedBytes + this.#completionSlotBytes >= this.#sharedCapacityBytes + this.#completionCapacityBytes
    );
  }

  usage(): ReplayBudgetUsage {
    return Object.freeze({
      sharedBytes: this.#sharedBytes,
      completionSlotBytes: this.#completionSlotBytes,
      totalBytes: this.#sharedBytes + this.#completionSlotBytes,
    });
  }
}
