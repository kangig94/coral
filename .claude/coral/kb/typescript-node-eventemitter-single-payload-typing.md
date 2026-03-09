# Node EventEmitter Single-Payload Typing
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When wrapping Node's `EventEmitter` with a typed event map in this repo, keep each event to a single object payload and expose generic `on()`, `off()`, and `emit()` methods keyed by that map. Under the current `strict` + `NodeNext` TypeScript setup, this shape type-checks cleanly without listener casts or overload boilerplate.
## Why
It is easy to overcomplicate a typed emitter wrapper by assuming Node's listener signatures need assertions or tuple plumbing. That adds noise right at the boundary that should stay minimal, and makes the wrapper harder to read than the events it is meant to clarify.
## Pattern
```typescript
type BusEvents = {
  'job:created': { jobId: string; sessionId: string };
};

class TypedBus {
  private readonly emitter = new EventEmitter();

  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): boolean {
    return this.emitter.emit(event, payload);
  }
}
```

```typescript
class TypedBus {
  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
```
