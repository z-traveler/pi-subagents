---
status: accepted
---

# Treat model candidates as independent failover targets

A provider name is not treated as a failure domain because it may identify an aggregation gateway whose model candidates fail independently. Retryable authentication, authorization, billing, quota, usage-limit, request-limit, availability, and transient failures may therefore advance to any remaining candidate in the same frozen model class, including one under the same provider name; existing effect and recovery safety gates still decide whether restarting is safe.

## Considered Options

Adding a configurable fault-domain identity was rejected because it adds configuration without improving the desired gateway behavior. Keeping provider-scoped suppression was rejected because one backend model's failure would incorrectly prevent trying another backend exposed by the same gateway.
