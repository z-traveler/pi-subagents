---
status: accepted
---

# Treat Fast capability as a model-ID property

Session Fast Routing determines eligibility from the exact model ID without considering the provider. A configured ID such as `gpt-5.6-sol` therefore requests the priority service tier through every provider that serves that ID; provider-qualified allowlists were rejected because Fast support is an invariant of these model IDs in the owner's environment.
