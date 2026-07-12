# Mobile Domain Guide

## React Native

Inherits React agents (state-guardian, render-optimizer) plus:

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| platform-bridge | 1 | opus | Native module safety, platform-specific code correctness |
| performance-profiler | 2 | sonnet | JS thread blocking, bridge overhead, list optimization |
| lifecycle-guardian | 2 | sonnet | App state handling, background/foreground transitions |

### Mandatory Concerns
- **Bridge overhead**: Minimize native bridge calls, batch operations, use JSI where possible
- **Platform differences**: Platform.select usage, platform-specific file extensions
- **Memory**: Image caching, FlatList optimization (getItemLayout, windowSize)
- **Navigation**: Deep linking, back handler, screen lifecycle

### Validation Checklist
#### BLOCKING
- [ ] No synchronous bridge calls on render path
- [ ] FlatList has keyExtractor and getItemLayout
- [ ] Platform-specific behavior tested on both iOS and Android
#### STRONG
- [ ] Images properly sized and cached
- [ ] App handles background/foreground correctly
- [ ] Deep linking tested

---

## Flutter

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| widget-guardian | 1 | opus | Widget lifecycle, state management, dispose cleanup |
| platform-channel | 2 | sonnet | MethodChannel safety, platform-specific integration |
| performance-profiler | 2 | sonnet | Jank detection, rebuild minimization, image caching |

### Mandatory Concerns
- **Widget lifecycle**: dispose() cleanup, controller disposal, stream cancellation
- **State management**: Provider/Riverpod/Bloc patterns, avoid setState for complex state
- **Rebuild optimization**: const constructors, selective rebuilds, RepaintBoundary

### Validation Checklist
#### BLOCKING
- [ ] All controllers disposed in dispose()
- [ ] Stream subscriptions cancelled
- [ ] No setState in async gaps (mounted check)
#### STRONG
- [ ] const constructors where possible
- [ ] Platform channels handle errors

---

## iOS / Swift

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| memory-guardian | 1 | opus | Retain cycles, weak/unowned references, ARC correctness |
| concurrency-safety | 1 | opus | Actor isolation, Sendable conformance, data races |
| lifecycle-guardian | 2 | sonnet | UIViewController lifecycle, scene transitions |

### Mandatory Concerns
- **ARC/Memory**: Retain cycle prevention (weak self in closures), instrument with Leaks
- **Swift Concurrency**: Actor isolation, @MainActor for UI, Sendable types
- **App lifecycle**: Scene phases, background task completion, state restoration

### Validation Checklist
#### BLOCKING
- [ ] No retain cycles ([weak self] in closures referencing self)
- [ ] @MainActor on all UI-updating code
- [ ] No data races (Swift concurrency checking enabled)
#### STRONG
- [ ] Instruments Leaks shows no growth
- [ ] Background tasks complete properly

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Retain cycle | Memory growth, dealloc not called | Instruments Leaks | [weak self] in closure |
| Main thread violation | UI freeze, purple warning | Main Thread Checker | @MainActor or DispatchQueue.main |
| Data race | Intermittent crash | Thread Sanitizer | Actor isolation |

---

## Android / Kotlin

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| lifecycle-guardian | 1 | opus | Activity/Fragment lifecycle, ViewModel scope, coroutine cancellation |
| memory-guardian | 1 | opus | Context leaks, bitmap recycling, cursor management |
| performance-profiler | 2 | sonnet | ANR prevention, RecyclerView optimization, startup time |

### Mandatory Concerns
- **Lifecycle**: LifecycleOwner-aware components, viewModelScope for coroutines
- **Memory**: No Activity context in singletons, WeakReference for callbacks
- **Coroutines**: Structured concurrency, proper scope (viewModelScope, lifecycleScope)
- **Configuration changes**: Handle rotation, multi-window, locale changes

### Validation Checklist
#### BLOCKING
- [ ] No context leaks (no Activity stored in companion/singleton)
- [ ] Coroutines use structured concurrency (no GlobalScope)
- [ ] Configuration changes don't crash
#### STRONG
- [ ] StrictMode enabled in debug builds
- [ ] RecyclerView uses DiffUtil

---

### Recommended Docs (Mobile)

| Doc | Content | Priority | Condition |
|-----|---------|----------|-----------|
| `docs/platform-setup.md` | Per-platform build/run instructions, signing config, emulator setup, CI device testing | Strong | Any mobile project |

**Architecture Sections**: Mobile projects should include these in `docs/ARCHITECTURE.md`:
- Navigation graph (screen flow, deep link routes, tab/stack structure)
- Native integration points (bridges, plugins, platform channels)
- Offline/sync strategy (if applicable)
