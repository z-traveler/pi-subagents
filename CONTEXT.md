# Pi Delegation

The language of launching, supervising, and recovering focused child-agent work within a Pi session.

## Language

**Model Class**:
A stable logical routing name for a substitutable set of model candidates whose membership is frozen for one child launch.
_Avoid_: Tier, concrete model alias

**Model Candidate**:
A concrete model choice, including its provider identity and thinking level, that may satisfy a model class.
_Avoid_: Model class, tier

**Same-Class Failover**:
Moving a child run from its current model candidate to another untried candidate in the same frozen model class.
_Avoid_: Cross-class fallback, model upgrade

**Generation Stall**:
An abnormally long absence of model output while generation is expected to be active.
_Avoid_: Tool latency, queue latency, generation throughput

**Generation Throughput**:
The rolling rate of model output tokens while generation is active, excluding tool execution, coordination waits, queueing, and retry backoff.
_Avoid_: End-to-end latency, time to first token

**Run-Local Candidate Exclusion**:
A decision not to retry one model candidate again within the current child run; it does not affect later runs.
_Avoid_: Global cooldown, persistent model exclusion

**Main-Agent Throughput Advisory**:
A user-facing signal that the interactive main agent's generation appears slow and that another model may be preferable; it never changes the main agent's model automatically.
_Avoid_: Main-agent failover, automatic model switch

**Transparent Same-Class Failover**:
Same-class failover that remains absent from the child result shown to the parent agent because its caller requested a model class rather than a concrete model; human-facing run status and records remain observable.
_Avoid_: Caller-directed reroute, cross-class fallback

**Soft Throughput Degradation**:
Generation that is slower than the preferred operating range but still tolerable enough to finish the current model response before changing candidates for a later response.
_Avoid_: Immediate abort, terminal failure

**Hard Throughput Degradation**:
Generation slow enough to abort the current incomplete model response and select another eligible candidate immediately, when another candidate remains.
_Avoid_: Outer run timeout, soft degradation

**Model Performance Probe**:
A bounded, tool-free model request used only to estimate a candidate's current first-token latency and generation throughput.
_Avoid_: Task execution, health check without generation

**Model Performance Cache**:
Short-lived observations used to rank model candidates by recent measured performance; it does not exclude or cool down candidates across runs.
_Avoid_: Run-local candidate exclusion, persistent cooldown

**Performance-Aware Candidate Selection**:
Choosing an eligible model candidate using fresh first-token and generation-throughput observations, with the declared candidate order as the default when observations are missing or inconclusive.
_Avoid_: Permanent ranking, quality-class inference

**Exact-Model Launch**:
A child launch that names one concrete model rather than a model class; automatic throughput-based model switching is disabled.
_Avoid_: Model-class routing, implicit fallback list
