# Backend Router Must Stay Provider-Neutral
## Rule
If the stdio proxy is meant to become a pure MCP↔HTTP bridge and providers are meant to be pluggable via the registry, `src/backend/tool-router.ts` must not contain provider-specific execution normalization. Backend routing may select a provider from the registry and invoke shared built-ins, but defaults like launch `working_directory` or op-shape quirks must live in provider adapters or a provider contract that all adapters implement.
## Why
Once the backend router special-cases `codex` and `claude`, registration stops being the real extensibility boundary. A third-party provider can register successfully yet still miss required execution defaults, and the transport layer becomes coupled to current built-ins. That blocks the goal of adding providers without framework changes and prevents the proxy/backend split from collapsing into a clean transport boundary.
## Pattern
Right:
```typescript
const provider = getProvider(name);
if (!provider) return unknownTool();
return provider.handleOp(args, mgr);
```

Or, if a shared default is needed:
```typescript
const normalizedArgs = provider.normalizeArgs?.(args, context) ?? args;
return provider.handleOp(normalizedArgs, mgr);
```

Wrong:
```typescript
if (toolName !== 'codex' && toolName !== 'claude') return args;
if (rawOp === 'exec' && !hasSession) {
  return { ...args, working_directory: projectRoot };
}
```
