/** Reusable test utility — exposes resolve/reject handles from a Promise. */
export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T = void>(): Deferred<T> {
  let settled = false;
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value);
    };
    reject = (error) => {
      if (settled) return;
      settled = true;
      rej(error instanceof Error ? error : new Error(String(error)));
    };
  });
  return { promise, resolve, reject };
}
