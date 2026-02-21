# Infrastructure Domain Guide

## Docker / Kubernetes

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| config-validator | 1 | opus | Dockerfile best practices, K8s manifest correctness, resource limits |
| secret-scanner | 1 | opus | No secrets in images/manifests, proper secret management |
| drift-detector | 2 | sonnet | Config drift between environments, image tag consistency |

### Mandatory Concerns
- **Image security**: Multi-stage builds, non-root user, minimal base image, no secrets in layers
- **Resource limits**: CPU/memory requests and limits on all containers
- **Secret management**: Secrets via K8s Secrets or external vault, never in ConfigMaps or env literals
- **Health checks**: Liveness and readiness probes on all deployments

### Validation Checklist
#### BLOCKING
- [ ] No secrets in Dockerfile or manifests (grep for passwords, tokens, keys)
- [ ] Resource limits defined on all containers
- [ ] Images use specific tags (not :latest in production)
- [ ] Health probes configured
#### STRONG
- [ ] Multi-stage Docker builds
- [ ] Non-root container user
- [ ] Network policies restrict inter-pod communication
- [ ] PodDisruptionBudget for critical services

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Secret in image layer | Credential exposure | `docker history` shows ENV with secret | Multi-stage build, --secret mount |
| No resource limits | OOM kills, noisy neighbor | `kubectl describe pod` shows no limits | Add resources.requests and limits |
| :latest tag | Unpredictable deployments | `grep ':latest' k8s/` | Pin to specific SHA or semver |

---

## Terraform

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| state-guardian | 1 | opus | State file safety, import/move operations, backend config |
| security-auditor | 1 | opus | IAM policies, security groups, encryption at rest |
| drift-detector | 2 | sonnet | Plan review, expected vs actual changes |

### Mandatory Concerns
- **State safety**: Remote backend with locking, never manual state edits, import before adopt
- **Security**: Least-privilege IAM, security groups deny by default, encryption enabled
- **Review process**: Always `terraform plan` before apply, review change count
- **Modules**: Pin module versions, document inputs/outputs

### Validation Checklist
#### BLOCKING
- [ ] Remote backend with state locking configured
- [ ] No hardcoded credentials in .tf files
- [ ] IAM policies follow least privilege
- [ ] All resources have tags for ownership/cost
#### STRONG
- [ ] Module versions pinned
- [ ] `terraform validate` passes
- [ ] `tfsec` or `checkov` scan clean

---

## CI/CD

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| pipeline-guardian | 1 | opus | Secret handling, artifact integrity, deployment safety |
| config-validator | 2 | sonnet | Workflow syntax, step dependencies, caching strategy |

### Mandatory Concerns
- **Secrets**: Never echo secrets, use masked variables, rotate regularly
- **Artifacts**: Sign or checksum build artifacts, pin action versions
- **Deployment**: Require approval for production, rollback strategy defined
- **Caching**: Cache dependencies for speed, invalidate on lockfile change

### Validation Checklist
#### BLOCKING
- [ ] Secrets never printed in logs
- [ ] GitHub Actions pinned by SHA (not tag)
- [ ] Production deployment requires manual approval
#### STRONG
- [ ] Dependency caching configured
- [ ] Pipeline runs in under 10 minutes
- [ ] Failure notifications configured

---

### Recommended Docs (Infrastructure)

| Doc | Content | Priority | Condition |
|-----|---------|----------|-----------|
| `docs/deployment-guide.md` | Environment list, deploy steps, rollback procedure, config management | Strong | Any project with deployment config |
| `docs/runbook.md` | Incident response procedures, common operations, escalation paths, health check interpretation | Conditional | Production deployment or monitoring config detected |

**Architecture Sections**: Infra projects should include these in `docs/ARCHITECTURE.md`:
- Environment topology (dev, staging, prod)
- Service dependency map (what talks to what)
- Secret management strategy
