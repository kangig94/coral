export interface ReadonlyStatement<BindParameters extends unknown[] = unknown[], Result = unknown> {
  get(...params: BindParameters): Result | undefined;
  all(...params: BindParameters): Result[];
  iterate(...params: BindParameters): IterableIterator<Result>;
}

export interface ReadonlyDatabase {
  prepare<BindParameters extends unknown[] = unknown[], Result = unknown>(
    source: string,
  ): ReadonlyStatement<BindParameters, Result>;
  close(): void;
}
