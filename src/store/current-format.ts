import { z } from 'zod';

import {
  describeStoreFormat,
  PersistedCodecRegistry,
  zodPersistedContract,
  type CanonicalContractValue,
  type PersistedDdlFragment,
  type StoreFormatDescription,
} from './format-fingerprint.js';
import type { ComposedReducers } from './reducers.js';
import schemaSource from './schema.sql';

export type CurrentStoreCodecSchemas = Readonly<{
  eventRefs: z.ZodTypeAny;
  jobTerminal: z.ZodTypeAny;
  jobDiagnostics: z.ZodTypeAny;
  executionOwner: z.ZodTypeAny;
  providerSession: z.ZodTypeAny;
  discussState: z.ZodTypeAny;
  workflowPlan: z.ZodTypeAny;
  providerScope: z.ZodTypeAny;
  workflowLifecycle: z.ZodTypeAny;
  expansionManifest: z.ZodTypeAny;
}>;

export type CurrentStoreCodecComponent = Readonly<{ name: string; contract: CanonicalContractValue }>;

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

function registerEventBodyCodec(codecs: PersistedCodecRegistry, reducers: ComposedReducers): void {
  const events = [...reducers.schemas.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([type, schema]) => ({ type, contract: zodPersistedContract(schema) }));
  codecs.register('store.events.body', { kind: 'event-body-map', events });
}

/**
 * Describe Coral's complete SQL-backed persisted contract. The store owns the
 * stable codec names; the application composition root supplies the domain
 * schemas without reversing the store-to-domain dependency direction.
 */
export function createCurrentStoreFormat(
  reducers: ComposedReducers,
  schemas: CurrentStoreCodecSchemas,
  ddlFragments: readonly PersistedDdlFragment[],
  components: readonly CurrentStoreCodecComponent[] = [],
): StoreFormatDescription {
  const codecs = new PersistedCodecRegistry();
  registerEventBodyCodec(codecs, reducers);
  codecs.registerZod('store.events.refs', schemas.eventRefs);
  codecs.registerZod('store.projection_jobs.terminal', schemas.jobTerminal);
  codecs.registerZod('store.projection_jobs.diagnostics', schemas.jobDiagnostics);
  codecs.registerZod('store.projection_jobs.execution_owner', schemas.executionOwner);
  codecs.registerZod('store.projection_sessions.entry', schemas.providerSession);
  codecs.registerZod('store.projection_discuss.state', schemas.discussState);
  codecs.registerZod('store.projection_workflows.plan', schemas.workflowPlan);
  codecs.registerZod('store.projection_workflows.provider_scope', schemas.providerScope);
  codecs.registerZodComponent('workflow.lifecycle', schemas.workflowLifecycle);
  codecs.registerZod('store.kb_curate_retry_queue.signals', jsonValueSchema);
  codecs.registerZod('store.expansion_manifest_catalog.manifest', schemas.expansionManifest);
  for (const component of components) codecs.register(component.name, component.contract, 'component');
  return describeStoreFormat(schemaSource, codecs, ddlFragments);
}

export function assertCurrentStoreFormat(
  reducers: ComposedReducers,
  schemas: CurrentStoreCodecSchemas,
  ddlFragments: readonly PersistedDdlFragment[],
  components: readonly CurrentStoreCodecComponent[] = [],
): void {
  createCurrentStoreFormat(reducers, schemas, ddlFragments, components);
}
