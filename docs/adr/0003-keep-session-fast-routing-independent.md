---
status: accepted
---

# Keep session Fast routing independent from Launch Fast

Session Fast Routing remains independent from the upstream per-child `fast` option: neither reads, disables, validates, nor migrates the other's state. Each may request `service_tier: "priority"`; when both apply, the identical request value is harmless. Consequently, `/fast off` stops the current root session from adding the priority tier but does not claim to disable an upstream Launch Fast request.
