export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export function createDeferred<T = void>(): Deferred<T> {
  let settled = false;
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (settled) return;
      settled = true;
      res(value as T | PromiseLike<T>);
    };
    reject = (reason) => {
      if (settled) return;
      settled = true;
      rej(reason);
    };
  });
  return { promise, resolve, reject };
}
