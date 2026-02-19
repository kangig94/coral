# ML/AI Domain Guide

## PyTorch

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| gradient-validator | 1 | opus | Gradient accumulation/zeroing, autograd graph correctness, no_grad scoping |
| ddp-guardian | 1 | opus | DDP synchronization, process group safety, all-reduce correctness |
| device-tracker | 2 | sonnet | Tensor device consistency, CPU/GPU transfer minimization |
| checkpoint-guardian | 2 | sonnet | Model save/load correctness, state_dict completeness |

### Mandatory Concerns
- **Gradient safety**: zero_grad() before backward(), no_grad() for inference, gradient clipping
- **Device consistency**: All tensors on same device before operations, minimize .to() calls
- **DDP**: All processes execute same code path, no non-deterministic ops in loss, sync batch norm
- **Memory**: torch.cuda.empty_cache(), gradient checkpointing for large models, mixed precision
- **Reproducibility**: Manual seeds, deterministic algorithms flag, CUBLAS workspace config

### Validation Checklist
#### BLOCKING
- [ ] optimizer.zero_grad() called before loss.backward()
- [ ] torch.no_grad() wraps all inference/evaluation code
- [ ] All tensors on same device before operations
- [ ] DDP: no code path divergence between ranks
#### STRONG
- [ ] Gradient clipping configured
- [ ] Mixed precision (autocast + GradScaler) for GPU training
- [ ] Checkpoints save optimizer state + scheduler state
- [ ] Seeds set for reproducibility

### Core Patterns
```python
# CORRECT: Full training loop
optimizer.zero_grad()
with torch.autocast('cuda'):
    output = model(input)
    loss = criterion(output, target)
scaler.scale(loss).backward()
scaler.unscale_(optimizer)
torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
scaler.step(optimizer)
scaler.update()

# WRONG: Missing zero_grad, no autocast, no clipping
output = model(input)
loss = criterion(output, target)
loss.backward()
optimizer.step()
```

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Missing zero_grad | Gradient accumulation across batches | `grep -n 'backward()' \| grep -v 'zero_grad'` | Add zero_grad() before backward() |
| Device mismatch | RuntimeError: tensors on different devices | Error message at runtime | Ensure consistent .to(device) |
| DDP rank divergence | Hang during training | Process hangs at all_reduce | Same code path for all ranks |
| No no_grad in eval | Memory growth during validation | Memory monitor shows growth | Wrap in torch.no_grad() |

---

## TensorFlow / Keras

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| graph-guardian | 1 | opus | TF function tracing, variable creation, eager vs graph mode |
| distribution-guardian | 1 | opus | Strategy scope, replica handling, dataset sharding |
| device-tracker | 2 | sonnet | Device placement, memory growth config |

### Mandatory Concerns
- **tf.function**: No Python side effects in traced functions, variable creation outside tf.function
- **Distribution**: Strategy.scope() for model/optimizer creation, dataset auto-sharding
- **Memory**: GPU memory growth config, mixed precision policy
- **SavedModel**: Signature correctness, serving function testing

### Validation Checklist
#### BLOCKING
- [ ] No variable creation inside tf.function
- [ ] Distribution strategy wraps model/optimizer creation
- [ ] GPU memory growth configured (prevent OOM)
#### STRONG
- [ ] SavedModel tested with TF Serving
- [ ] Mixed precision configured for GPU training

---

## LLM Application

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| prompt-guardian | 1 | opus | Prompt injection prevention, output validation, token limits |
| cost-auditor | 2 | sonnet | Token usage tracking, caching strategy, model selection optimization |
| reliability-guardian | 2 | sonnet | Retry logic, fallback models, timeout handling, rate limits |

### Mandatory Concerns
- **Prompt injection**: Separate system/user content, validate outputs, don't execute LLM output blindly
- **Cost control**: Token counting, prompt caching, model routing (cheap for simple, expensive for complex)
- **Reliability**: Retry with exponential backoff, fallback to smaller model, timeout configuration
- **Evaluation**: Output quality metrics, regression testing, A/B testing framework

### Validation Checklist
#### BLOCKING
- [ ] System prompt separated from user input
- [ ] LLM output validated before execution/display
- [ ] Token limits enforced (input + output)
- [ ] API keys not hardcoded
#### STRONG
- [ ] Retry with backoff on rate limits
- [ ] Prompt caching for repeated patterns
- [ ] Cost tracking per request/user
- [ ] Output evaluation pipeline exists

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Prompt injection | LLM executes attacker instructions | Test with adversarial inputs | Separate system/user, validate output |
| No retry | Failures on transient API errors | Grep for bare API calls without retry | Add tenacity/backoff wrapper |
| Unbounded tokens | Cost spike, timeout | Monitor token usage per request | Set max_tokens, truncate input |
