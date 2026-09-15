---
status: accepted
---

# Use performance-aware model-class routing

Model-class routing uses recent first-token latency and estimated generation-throughput observations to select among the launch's frozen candidate set, while an exact-model launch remains fixed. Interactive main-agent slowdown is advisory only, whereas a model-class child may switch transparently: hard degradation aborts and retries the incomplete model response, soft degradation changes the model before a later response, and human-facing run status remains observable without injecting routing details into the parent agent's result.

## Considered Options

Blocking every cold launch on synthetic benchmarks was rejected because it adds latency, cost, rate-limit pressure, and a weak proxy for real agent workloads. Strict sequential failover was rejected because fresh performance evidence can identify a better remaining candidate without repeating known-slow attempts.

## Consequences

Cold launches start without waiting while bounded, tool-free probes warm a short-lived host-local cache; real workload observations take precedence over probe results. Cache data ranks candidates but never creates a cross-run exclusion, and missing or inconclusive data falls back to the declared candidate order. Probes consume real provider quota and are recorded in human-facing run details without entering agent-visible output.
