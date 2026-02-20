# Frontend Domain Guide

## React

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| state-guardian | 1 | opus | Prevents state management bugs - race conditions, stale closures, unnecessary re-renders |
| render-optimizer | 2 | sonnet | Identifies unnecessary re-renders, missing memoization, expensive computations in render path |
| accessibility-checker | 2 | sonnet | WCAG compliance, ARIA attributes, keyboard navigation, screen reader compatibility |

### Mandatory Concerns
- **State management**: Stale closure detection, proper dependency arrays in hooks, controlled vs uncontrolled components
- **Re-render prevention**: React.memo usage, useMemo/useCallback for expensive operations, key prop correctness
- **Accessibility**: ARIA labels, keyboard navigation, color contrast, focus management
- **SSR/hydration** (if Next.js detected): Hydration mismatch prevention, server-only vs client-only code

### Validation Checklist
#### BLOCKING
- [ ] No stale closures in useEffect dependency arrays
- [ ] Key props on all list items (unique, stable)
- [ ] No direct state mutation
- [ ] Forms have proper validation and error states
#### STRONG
- [ ] Expensive computations memoized
- [ ] Accessibility audit passes (axe-core or similar)
- [ ] Error boundaries around critical sections
- [ ] Loading and empty states handled

### Core Patterns
```tsx
// CORRECT: Stable key, proper deps
function UserList({ users }: { users: User[] }) {
  const sorted = useMemo(() => users.sort(byName), [users]);
  return sorted.map(u => <UserCard key={u.id} user={u} />);
}

// WRONG: Index as key, computation in render
function UserList({ users }: { users: User[] }) {
  return users.sort(byName).map((u, i) => <UserCard key={i} user={u} />);
}
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Stale closure | State shows old value in callback | Check useEffect deps with eslint-plugin-react-hooks | Add missing dependencies or use ref |
| Index as key | Items shuffle/lose state on reorder | `grep 'key={i}' src/` | Use stable unique ID |
| Missing error boundary | White screen on component crash | Check for ErrorBoundary wrapping route sections | Add React Error Boundary |
| Uncontrolled to controlled | Console warning, input loses value | Search for `value={undefined}` patterns | Use defaultValue or manage state consistently |

---

## Vue

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| reactivity-guardian | 1 | opus | Prevents reactivity loss, deep vs shallow ref misuse, computed vs watch misuse |
| render-optimizer | 2 | sonnet | v-if vs v-show, list rendering keys, computed caching |
| accessibility-checker | 2 | sonnet | ARIA, keyboard nav, screen reader support |

### Mandatory Concerns
- **Reactivity system**: ref vs reactive, toRefs for destructuring, watchEffect cleanup
- **Component communication**: Props validation, emit typing, provide/inject scoping
- **Performance**: v-once for static content, shallowRef for large objects, virtual scrolling for lists

### Validation Checklist
#### BLOCKING
- [ ] No reactivity loss from destructuring reactive objects without toRefs
- [ ] Key props on all v-for items
- [ ] Props have type validation
#### STRONG
- [ ] Computed properties used instead of methods for derived state
- [ ] watchers cleaned up properly (onUnmounted)

---

## Svelte

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| reactivity-guardian | 1 | opus | $state/$derived correctness, store subscription cleanup |
| accessibility-checker | 2 | sonnet | a11y warnings, ARIA, keyboard navigation |

### Mandatory Concerns
- **Reactivity**: `$state` vs `$derived` vs `$effect`, assignment-based reactivity rules
- **Store management**: Subscription cleanup, derived stores, writable store patterns
- **Accessibility**: Svelte's built-in a11y warnings, role attributes

### Validation Checklist
#### BLOCKING
- [ ] No missing reactive declarations for mutated state
- [ ] Store subscriptions cleaned up in onDestroy
#### STRONG
- [ ] a11y warnings resolved (Svelte compiler)

---

## Next.js

Inherits all React agents plus:

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| ssr-guardian | 1 | opus | Server/client boundary correctness, hydration safety, data fetching patterns |

### Mandatory Concerns
- **Server/client boundary**: 'use client' / 'use server' directives, serialization rules
- **Hydration**: No browser-only code in server components, consistent rendering
- **Data fetching**: Server actions vs API routes, caching strategy, revalidation
- **Routing**: App router conventions, layout nesting, parallel routes

### Validation Checklist
#### BLOCKING
- [ ] No hydration mismatches (window/document in server components)
- [ ] 'use client' on components using hooks/browser APIs
- [ ] Server actions validate input
#### STRONG
- [ ] Metadata/SEO configured per route
- [ ] Image optimization via next/image

---

## Angular

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| di-guardian | 1 | opus | Dependency injection correctness, provider scope, circular dependencies |
| change-detection-optimizer | 2 | sonnet | OnPush strategy, signal usage, async pipe vs manual subscribe |
| accessibility-checker | 2 | sonnet | ARIA, CDK a11y module usage |

### Mandatory Concerns
- **DI system**: Provider scope (root, module, component), injection tokens, circular deps
- **Change detection**: OnPush strategy, markForCheck, signal-based components
- **RxJS patterns**: Subscription cleanup (takeUntilDestroyed), error handling in streams
- **Modules vs standalone**: Migration patterns, lazy loading

### Validation Checklist
#### BLOCKING
- [ ] No memory leaks from unsubscribed observables
- [ ] DI providers scoped correctly
- [ ] No circular dependencies
#### STRONG
- [ ] OnPush change detection where applicable
- [ ] Lazy loading for feature modules
