import assert from 'node:assert/strict';

export function raceWithSignal<Value, Interrupted>(
  operation: Promise<Value>,
  signal: AbortSignal | null | undefined,
  onAbort: () => Interrupted,
): Promise<Value | Interrupted> {
  if (signal === undefined || signal === null) return operation;
  return new Promise<Value | Interrupted>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', interrupt);
    const complete = (value: Value | Interrupted): void => {
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      cleanup();
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the original rejection value.
      reject(error);
    };
    const interrupt = (): void => {
      try {
        complete(onAbort());
      } catch (error: unknown) {
        fail(error);
      }
    };
    operation.then(complete, fail);
    if (signal.aborted) interrupt();
    else signal.addEventListener('abort', interrupt, { once: true });
  });
}

type PromiseObservation<Value> = { signal: AbortSignal; result(): Value };
const observations = new WeakMap<Promise<unknown>, PromiseObservation<unknown>>();

export function observePromise<Value>(promise: Promise<Value>): PromiseObservation<Value> {
  const existing = observations.get(promise);
  if (existing !== undefined) return existing as PromiseObservation<Value>;
  const controller = new AbortController();
  let settlement: PromiseSettledResult<Value> | undefined;
  void promise.then(
    (value) => {
      settlement = { status: 'fulfilled', value };
      controller.abort();
    },
    (error: unknown) => {
      settlement = { status: 'rejected', reason: error };
      controller.abort();
    },
  );
  const result = (): Value => {
    assert(settlement !== undefined);
    if (settlement.status === 'rejected') throw settlement.reason;
    return settlement.value;
  };
  const observation = { signal: controller.signal, result };
  observations.set(promise, observation);
  return observation;
}

export function raceObserved<const Values extends readonly unknown[]>(
  promises: Values,
): Promise<Awaited<Values[number]>> {
  const observed = promises.map((promise) => observePromise(Promise.resolve(promise)));
  const settled = AbortSignal.any(observed.map(({ signal }) => signal));
  return raceWithSignal(new Promise<never>(() => {}), settled, () => {
    const winner = observed.find(({ signal }) => signal.aborted);
    assert(winner !== undefined);
    return winner.result() as Awaited<Values[number]>;
  });
}

export function raceWithPromise<Value, Input, Interrupted>(
  operation: Promise<Value>,
  interrupt: Promise<Input>,
  onInterrupt: (value: Input) => Interrupted,
): Promise<Value | Interrupted> {
  const observed = observePromise(interrupt);
  return raceWithSignal(operation, observed.signal, () => onInterrupt(observed.result()));
}
