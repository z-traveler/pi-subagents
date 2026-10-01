---
status: accepted
---

# Treat Fast capability as a model-ID property

Session Fast Routing determines eligibility from `model.id` without considering the provider. The operator may select exact IDs or explicit `/pattern/` regexes (without flags), such as `/^gpt-/`; regexes express the operator's eligibility policy, not automatic service capability detection. A configured ID such as `gpt-5.6-sol` therefore requests the priority service tier through every provider that serves that ID; provider-qualified allowlists were rejected because Fast support is an invariant of these model IDs in the owner's environment.
