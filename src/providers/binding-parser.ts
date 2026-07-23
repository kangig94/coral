import { z } from 'zod';

import { zodPersistedContract } from '../store/format-fingerprint.js';
import type { ProviderPersistedParser, ProviderValueParser } from './binding-parser-contract.js';

function privateSchema<Value>(factory: () => z.ZodType<Value>): z.ZodType<Value> {
  const schema = factory();
  if (!(schema instanceof z.ZodType)) throw new TypeError('Zod parser authority factory must return a Zod schema.');
  return schema;
}

export function zodValueParser<Value>(factory: () => z.ZodType<Value>): ProviderValueParser<Value> {
  const schema = privateSchema(factory);
  const descriptor = Object.getOwnPropertyDescriptor(schema, 'safeParse');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError('Zod parser authority requires an own safeParse data method.');
  }
  const safeParse = descriptor.value as ProviderValueParser<Value>;
  return (raw) => safeParse(raw);
}

export function zodPersistedParser<Value>(factory: () => z.ZodType<Value>): ProviderPersistedParser<Value> {
  const schema = privateSchema(factory);
  return Object.freeze({
    parse: zodValueParser(() => schema),
    contract: zodPersistedContract(schema),
  });
}
