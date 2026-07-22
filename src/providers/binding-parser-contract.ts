export type ProviderPersistedContractValue =
  | null
  | boolean
  | number
  | string
  | readonly ProviderPersistedContractValue[]
  | { readonly [key: string]: ProviderPersistedContractValue };

export type ProviderValueParseResult<Value> =
  | { readonly success: true; readonly data: Value }
  | { readonly success: false; readonly error?: unknown };

export type ProviderValueParser<Value> = (raw: unknown) => ProviderValueParseResult<Value>;

export type ProviderPersistedParser<Value> = Readonly<{
  parse: ProviderValueParser<Value>;
  contract: ProviderPersistedContractValue;
}>;
