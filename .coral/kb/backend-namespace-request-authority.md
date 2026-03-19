# Backend Namespace Isolation Requires Server-Authoritative Request Identity
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When backend ownership becomes installation-scoped, do not let request payloads or implicit client defaults choose that installation identity. The backend server must resolve one authoritative `pluginRoot` for its own process, overwrite inbound request `pluginRoot` with that value before routing, and use the derived namespace on request-time job management surfaces as well as durable job ownership. Public clients that resolve a daemon without an explicit override must derive that choice from explicit/default `pluginRoot` context instead of a process-global fallback.
## Why
Namespaced `backend.json`, `backend.lock`, and lifecycle sweeps are not sufficient if request-time paths still trust caller-supplied provenance or talk to the default daemon. A client can otherwise stamp jobs with a foreign namespace, enumerate another installation's jobs through `/api/jobs`, or send `abort` and `wait` requests against another installation when both share the same `projectRoot`. The failure hides behind apparently correct discovery isolation because the leak lives in request parsing and client-side daemon selection.
## Pattern
Right:
```ts
const resolvedPluginRoot = resolveServerPluginRoot(options);
const namespace = pluginRootNamespace(resolvedPluginRoot);

function normalizeToolRequest(body: unknown): ToolRequest {
  const parsed = parseAndValidate(body);
  return {
    ...parsed,
    context: {
      ...parsed.context,
      pluginRoot: resolvedPluginRoot,
    },
  };
}

function resolveBackendHandle(ctx?: CallerContext): Promise<BackendHandle> {
  return ensureBackend(ctx?.pluginRoot ?? defaultContext?.pluginRoot);
}

function listJobsForNamespace(store: ProgressStore, namespace: string) {
  return readJobIds()
    .map((jobId) => store.readStatus(jobId))
    .filter((status) => status?.backendNamespace === namespace);
}
```

Wrong:
```ts
function parseToolRequest(body: unknown): ToolRequest {
  return {
    name: body.name,
    args: body.args,
    context: body.context, // trusts caller-supplied pluginRoot
  };
}

const client = new BackendClient({ defaultContext });
await client.health(); // still resolves the process-global default daemon

sendJson(res, 200, { jobs: listAllJobs(progressStore) }); // no namespace filter
```
