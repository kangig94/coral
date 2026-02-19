# Backend Domain Guide

## Node.js / Express

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| api-guardian | 1 | opus | Auth enforcement, input validation, error handling consistency |
| async-safety | 1 | opus | Unhandled promise rejections, event loop blocking, memory leaks |
| db-migration-checker | 2 | sonnet | Migration safety, schema changes, backward compatibility |

### Mandatory Concerns
- **Authentication/Authorization**: Every endpoint must have auth middleware, RBAC enforcement
- **Input validation**: Zod/Joi schemas on all request bodies, SQL injection prevention
- **Error handling**: Centralized error handler, no stack traces in production responses
- **Async safety**: No unhandled promise rejections, no sync operations blocking event loop
- **Memory**: No unbounded caches, stream large payloads, monitor heap usage

### Validation Checklist
#### BLOCKING
- [ ] All endpoints have authentication middleware
- [ ] Request body validation on all POST/PUT/PATCH
- [ ] No SQL/NoSQL injection vectors (parameterized queries)
- [ ] Error responses don't leak internal details
#### STRONG
- [ ] Rate limiting on public endpoints
- [ ] Graceful shutdown handling (SIGTERM)
- [ ] Health check endpoint exists
- [ ] N+1 query patterns identified and resolved

### Core Patterns
```typescript
// CORRECT: Validated endpoint with auth and error handling
app.post('/users', auth, async (req, res, next) => {
  try {
    const data = userSchema.parse(req.body);
    const user = await userService.create(data);
    res.status(201).json(user);
  } catch (err) {
    next(err); // centralized error handler
  }
});

// WRONG: No validation, no auth, error swallowed
app.post('/users', async (req, res) => {
  const user = await db.query(`INSERT INTO users VALUES ('${req.body.name}')`);
  res.json(user);
});
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Unhandled rejection | Process crash in production | `grep -rn 'catch' \| wc -l` vs promise count | Add .catch() or use express-async-errors |
| N+1 queries | Slow list endpoints | Enable query logging, count per request | Use eager loading / dataloader pattern |
| Missing auth | Unauthorized data access | Audit middleware chain per route | Add auth middleware to router group |
| Event loop blocking | High latency spikes | `--prof` flag, blocked-at package | Move CPU work to worker threads |

---

## Python / FastAPI

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| api-guardian | 1 | opus | Auth, input validation via Pydantic, error handling |
| async-safety | 1 | opus | Async/await correctness, blocking calls in async context |
| db-migration-checker | 2 | sonnet | Alembic migration safety, schema evolution |

### Mandatory Concerns
- **Type safety**: Pydantic models for all request/response, strict mode
- **Async correctness**: No blocking calls (requests, time.sleep) in async functions
- **Dependency injection**: FastAPI Depends() for auth, DB sessions, shared resources
- **Migration safety**: Alembic migrations reversible, no data loss

### Core Patterns
```python
# CORRECT: Typed endpoint with dependency injection
@app.post("/users", response_model=UserResponse)
async def create_user(
    data: UserCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_auth),
):
    user = User(**data.model_dump())
    db.add(user)
    await db.commit()
    return user

# WRONG: No types, no auth, blocking call in async
@app.post("/users")
async def create_user(request: Request):
    data = await request.json()
    requests.post("http://external-api", json=data)  # blocking!
    return {"ok": True}
```

### Validation Checklist
#### BLOCKING
- [ ] All endpoints have Pydantic request/response models
- [ ] No blocking I/O in async endpoints
- [ ] Auth dependency on all protected routes
- [ ] Migrations are reversible (downgrade works)
#### STRONG
- [ ] Background tasks for long operations (not in request cycle)
- [ ] Connection pooling configured
- [ ] CORS properly restricted

---

## Python / Django

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| security-guardian | 1 | opus | CSRF, XSS, SQL injection, auth enforcement |
| orm-optimizer | 2 | sonnet | N+1 queries, select_related, prefetch_related |
| migration-checker | 2 | sonnet | Migration safety, data migrations, squashing |

### Mandatory Concerns
- **Security**: CSRF middleware, XSS prevention, secure headers, auth decorators
- **ORM**: select_related/prefetch_related for foreign keys, .only() for large models
- **Migrations**: No irreversible data migrations, test rollback

### Validation Checklist
#### BLOCKING
- [ ] CSRF middleware active
- [ ] No raw SQL without parameterization
- [ ] Auth decorators on all protected views
#### STRONG
- [ ] N+1 queries resolved (django-debug-toolbar)
- [ ] Migrations tested with rollback

---

## Go

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| error-guardian | 1 | opus | Error handling completeness — no ignored errors, proper wrapping |
| concurrency-safety | 1 | opus | Goroutine leaks, race conditions, channel safety |
| api-guardian | 2 | sonnet | HTTP handler patterns, middleware chain, input validation |

### Mandatory Concerns
- **Error handling**: Every error must be checked, errors.Is/As for comparison, %w for wrapping
- **Concurrency**: No goroutine leaks (context cancellation), sync.WaitGroup, mutex usage
- **Resource cleanup**: defer for Close(), context propagation through call chain

### Validation Checklist
#### BLOCKING
- [ ] No unchecked errors (`errcheck` linter passes)
- [ ] No goroutine leaks (context cancellation)
- [ ] Race detector passes (`go test -race`)
#### STRONG
- [ ] Table-driven tests for handlers
- [ ] Graceful shutdown with signal handling

### Core Patterns
```go
// CORRECT: Error handling, context propagation, graceful shutdown
func (s *Server) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.db.QueryContext(ctx, "SELECT * FROM users WHERE id = $1", id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return user, nil
}

// WRONG: Ignored error, no context, string formatting SQL
func (s *Server) GetUser(id string) *User {
    user, _ := s.db.Query(fmt.Sprintf("SELECT * FROM users WHERE id = '%s'", id))
    return user
}
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Ignored error | Silent data corruption | `errcheck` linter | Handle or explicitly ignore with `_ =` |
| Goroutine leak | Memory growth over time | `runtime.NumGoroutine()` in tests | Use context with cancel/timeout |
| Race condition | Intermittent test failures | `go test -race` | Use sync.Mutex or channels |

---

## Rust

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| ownership-guardian | 1 | opus | Borrow checker patterns, lifetime correctness, unsafe usage |
| error-handling | 2 | sonnet | Result/Option patterns, error type design, ? operator usage |
| api-design | 2 | sonnet | Trait design, builder patterns, public API ergonomics |

### Mandatory Concerns
- **Ownership**: Minimize cloning, use references where possible, understand move semantics
- **Error types**: Custom error enums with thiserror, anyhow for applications
- **Unsafe**: Minimize unsafe blocks, document safety invariants, review all unsafe

### Validation Checklist
#### BLOCKING
- [ ] `cargo clippy` passes with no warnings
- [ ] No unsafe without documented safety invariants
- [ ] All public APIs have doc comments
#### STRONG
- [ ] No unnecessary cloning (use references)
- [ ] Error types are descriptive and actionable

---

## Java / Spring

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| security-guardian | 1 | opus | Spring Security config, auth enforcement, CSRF/XSS |
| di-guardian | 1 | opus | Bean lifecycle, circular dependencies, scope correctness |
| db-migration-checker | 2 | sonnet | Flyway/Liquibase migration safety |

### Mandatory Concerns
- **Security**: Spring Security filter chain, method-level security, CORS config
- **DI**: Bean scopes (singleton, prototype, request), avoid field injection, use constructor
- **Transactions**: @Transactional propagation, rollback rules, lazy loading outside session

### Validation Checklist
#### BLOCKING
- [ ] Security filter chain configured for all endpoints
- [ ] No field injection (use constructor injection)
- [ ] Migrations are idempotent and reversible
#### STRONG
- [ ] No LazyInitializationException patterns
- [ ] Integration tests for security configuration
