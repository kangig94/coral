type ReplayBudgetUsage = Readonly<{
  bufferedBytes: number;
  reservedBytes: number;
  waiting: number;
}>;

export interface ReplayCapacityReservation {
  readonly identity: string;
  release(): void;
}

type ActiveReservation = Readonly<{
  identity: string;
  signal?: AbortSignal;
  onAbort?: () => void;
}>;

type ReplayWaiter = Readonly<{
  identity: string;
  canProduce: () => boolean;
  signal?: AbortSignal;
  resolve: (reservation: ReplayCapacityReservation) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}>;

function replayCancellationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Replay capacity wait was cancelled.', { cause: reason });
}

export class ReplayBudget {
  readonly #capacityBytes: number;
  readonly #reservationBytes: number;
  readonly #claimedIdentities = new Set<string>();
  readonly #active = new Map<ReplayCapacityReservation, ActiveReservation>();
  readonly #waiters: ReplayWaiter[] = [];
  #bufferedBytes = 0;
  #reservedBytes = 0;

  constructor(capacityBytes: number, reservationBytes: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) {
      throw new TypeError('Replay capacity must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes <= 0 || reservationBytes > capacityBytes) {
      throw new TypeError('Replay reservation must fit inside the capacity.');
    }
    this.#capacityBytes = capacityBytes;
    this.#reservationBytes = reservationBytes;
  }

  reserve(identity: string, canProduce: () => boolean, signal?: AbortSignal): Promise<ReplayCapacityReservation> {
    if (this.#claimedIdentities.has(identity)) {
      return Promise.reject(new Error(`Replay capacity is already claimed by '${identity}'.`));
    }
    if (signal?.aborted === true) return Promise.reject(replayCancellationError(signal.reason));

    this.#claimedIdentities.add(identity);
    return new Promise<ReplayCapacityReservation>((resolve, reject) => {
      const onAbort =
        signal === undefined
          ? undefined
          : () => {
              const index = this.#waiters.findIndex((candidate) => candidate.identity === identity);
              if (index < 0) return;
              this.#waiters.splice(index, 1);
              this.#claimedIdentities.delete(identity);
              reject(replayCancellationError(signal.reason));
              this.#drain();
            };
      const waiter: ReplayWaiter = {
        identity,
        canProduce,
        signal,
        resolve,
        reject,
        ...(onAbort === undefined ? {} : { onAbort }),
      };
      this.#waiters.push(waiter);
      if (signal !== undefined && onAbort !== undefined) signal.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort?.();
      else this.#drain();
    });
  }

  commit(reservation: ReplayCapacityReservation, bufferedBytes: number): void {
    const active = this.#active.get(reservation);
    if (active === undefined) throw new Error('Replay reservation is no longer active.');
    if (!Number.isSafeInteger(bufferedBytes) || bufferedBytes < 0 || bufferedBytes > this.#reservationBytes) {
      reservation.release();
      throw new RangeError(`Replay frame must fit inside its ${this.#reservationBytes}-byte reservation.`);
    }

    this.#forgetActive(reservation, active);
    this.#reservedBytes -= this.#reservationBytes;
    this.#bufferedBytes += bufferedBytes;
    this.#drain();
  }

  releaseBuffered(bufferedBytes: number): void {
    if (!Number.isSafeInteger(bufferedBytes) || bufferedBytes < 0 || bufferedBytes > this.#bufferedBytes) {
      throw new RangeError('Released replay bytes must be part of the committed budget.');
    }
    this.#bufferedBytes -= bufferedBytes;
    this.#drain();
  }

  cancel(identity: string, reason: unknown): void {
    const waiterIndex = this.#waiters.findIndex((waiter) => waiter.identity === identity);
    if (waiterIndex >= 0) {
      const [waiter] = this.#waiters.splice(waiterIndex, 1);
      if (waiter?.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.#claimedIdentities.delete(identity);
      waiter?.reject(replayCancellationError(reason));
    }
    for (const [reservation, active] of this.#active) {
      if (active.identity === identity) reservation.release();
    }
    this.#drain();
  }

  isExhausted(): boolean {
    return this.#bufferedBytes + this.#reservedBytes >= this.#capacityBytes;
  }

  usage(): ReplayBudgetUsage {
    return Object.freeze({
      bufferedBytes: this.#bufferedBytes,
      reservedBytes: this.#reservedBytes,
      waiting: this.#waiters.length,
    });
  }

  #release(reservation: ReplayCapacityReservation): void {
    const active = this.#active.get(reservation);
    if (active === undefined) return;
    this.#forgetActive(reservation, active);
    this.#reservedBytes -= this.#reservationBytes;
    this.#drain();
  }

  #forgetActive(reservation: ReplayCapacityReservation, active: ActiveReservation): void {
    this.#active.delete(reservation);
    this.#claimedIdentities.delete(active.identity);
    if (active.signal !== undefined && active.onAbort !== undefined) {
      active.signal.removeEventListener('abort', active.onAbort);
    }
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined) return;
      if (!waiter.canProduce()) return;
      if (this.#bufferedBytes + this.#reservedBytes + this.#reservationBytes > this.#capacityBytes) return;

      this.#waiters.shift();
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      const onAbort =
        waiter.signal === undefined
          ? undefined
          : () => {
              reservation.release();
            };
      const reservation: ReplayCapacityReservation = Object.freeze({
        identity: waiter.identity,
        release: () => this.#release(reservation),
      });
      this.#reservedBytes += this.#reservationBytes;
      this.#active.set(reservation, {
        identity: waiter.identity,
        ...(waiter.signal === undefined ? {} : { signal: waiter.signal, onAbort }),
      });
      if (waiter.signal !== undefined && onAbort !== undefined) {
        waiter.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (waiter.signal?.aborted === true) reservation.release();
      waiter.resolve(reservation);
    }
  }
}
