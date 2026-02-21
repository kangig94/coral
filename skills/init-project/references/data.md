# Data Domain Guide

## Spark

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| partition-guardian | 1 | opus | Partition strategy, skew detection, shuffle optimization |
| schema-validator | 2 | sonnet | Schema evolution safety, type consistency, null handling |
| pipeline-monitor | 2 | sonnet | Job monitoring, resource utilization, stage bottlenecks |

### Mandatory Concerns
- **Partitioning**: Partition count matches cluster, repartition vs coalesce, avoid skew
- **Shuffles**: Minimize wide transformations, broadcast joins for small tables
- **Schema**: Schema evolution compatibility, null handling in aggregations
- **Resources**: Executor memory/cores, dynamic allocation, spill management

### Validation Checklist
#### BLOCKING
- [ ] No collect() on large datasets
- [ ] Partition strategy defined for all outputs
- [ ] Schema changes are backward compatible
#### STRONG
- [ ] Broadcast joins for tables < 10MB
- [ ] Caching strategy for reused DataFrames
- [ ] Checkpointing for long lineage chains

### Anti-Patterns
| Bug | Symptom | Detection | Fix |
|-----|---------|-----------|-----|
| Data skew | One task takes 100x longer | Spark UI stage detail | Salt key, repartition, skew join hint |
| collect() on large data | Driver OOM | `grep 'collect()' src/` | Use write/foreach instead |
| Cartesian join | Exponential output size | explain() shows BroadcastNestedLoopJoin | Add join condition or broadcast |

---

## dbt

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| model-guardian | 1 | opus | Ref correctness, materialization strategy, incremental safety |
| data-quality-checker | 2 | sonnet | Test coverage, freshness, source validation |
| schema-validator | 2 | sonnet | Column naming, documentation, contract enforcement |

### Mandatory Concerns
- **Refs**: All inter-model dependencies via ref(), no hardcoded table names
- **Materialization**: Table vs view vs incremental - choose based on size and freshness needs
- **Tests**: Unique, not_null, accepted_values on all primary keys and critical columns
- **Documentation**: All models and columns documented in schema.yml

### Validation Checklist
#### BLOCKING
- [ ] All model dependencies use ref()
- [ ] Primary keys have unique + not_null tests
- [ ] Incremental models handle late-arriving data
#### STRONG
- [ ] All columns documented in schema.yml
- [ ] Source freshness configured
- [ ] CI runs `dbt build` with `--fail-fast`

---

## ETL Pipelines

### Required Agents
| Agent | Tier | Model | Purpose |
|-------|------|-------|---------|
| idempotency-guardian | 1 | opus | Rerun safety, deduplication, exactly-once semantics |
| schema-validator | 2 | sonnet | Schema evolution, type coercion, null handling |
| data-quality-checker | 2 | sonnet | Validation rules, anomaly detection, completeness checks |

### Mandatory Concerns
- **Idempotency**: Every pipeline must produce the same result on rerun
- **Error handling**: Dead letter queues for failed records, partial failure recovery
- **Monitoring**: Record counts at each stage, latency tracking, alerting on anomalies
- **Schema evolution**: Handle new fields gracefully, version data formats

### Validation Checklist
#### BLOCKING
- [ ] Pipeline is idempotent (rerun produces same output)
- [ ] Failed records go to dead letter queue (not silently dropped)
- [ ] Schema changes don't break downstream consumers
#### STRONG
- [ ] Record count validation between stages
- [ ] Data freshness monitoring
- [ ] Backfill procedure documented

---

### Recommended Docs (Data)

| Doc | Content | Priority | Condition |
|-----|---------|----------|-----------|
| `docs/data-dictionary.md` | Source systems, table/column definitions, types, business meaning, ownership | Strong | Any data project |

**Architecture Sections**: Data projects should include these in `docs/ARCHITECTURE.md`:
- Pipeline DAG structure and scheduling
- Data lineage (source → transform → target)
- Quality validation rules and SLA definitions
