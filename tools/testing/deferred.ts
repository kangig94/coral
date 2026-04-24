export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function toRejectionError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  if (reason === undefined) {
    return new Error('Deferred rejected');
  }

  if (reason === null) {
    return new Error('Deferred rejected with null');
  }

  switch (typeof reason) {
    case 'string':
      return new Error(reason);
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
      return new Error(String(reason));
  }

  try {
    return new Error(JSON.stringify(reason) ?? 'Deferred rejected with non-serializable reason');
  } catch {
    return new Error('Deferred rejected with non-serializable reason');
  }
}

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
      rej(toRejectionError(reason));
    };
  });
  return { promise, resolve, reject };
}
