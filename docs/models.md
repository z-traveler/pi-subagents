# Models

How subagents pick models, and how to change that.

Builtin agents inherit your current Pi default model. This keeps new installs from depending on a provider you may not have configured. From there you can layer defaults and overrides:

- `subagents.defaultModel` — a default for every subagent that does not set its own model.
- `subagents.modelPools.<class>` — an ordered pool behind a semantic class such as `fast`, `medium`, or `smart`.
- `subagents.defaultProvider` — a provider preference for bare model ids, such as `llama-3`, when multiple providers expose the same id.
- `subagents.agentOverrides.<name>.modelClass` — route one role through a named pool.
- `subagents.agentOverrides.<name>.model` — pin one role.
- `subagents.agentOverrides.<name>.defaultProvider` — choose or clear the provider preference for one role.
- `subagents.agentOverridesByProvider.<provider>.<name>` — layer role fields for the active parent provider.
- Per-run overrides — for one launch only.

Precedence, strongest first: per-run `model` or `modelClass` → provider-scoped role override → ordinary role override → mapped frontmatter `modelClass` → frontmatter `model` → `subagents.defaultModel` → the parent session model. One call or override object cannot set both `model` and `modelClass`; agent frontmatter may keep both so its concrete model remains a portable fallback when a deployment has no mapping for that frontmatter class. A provider preference does not replace this order; it only resolves bare model ids when the active registry has more than one match. Fully qualified `provider/model` strings still win exactly.

Each launch resolves one model. Provider errors, including HTTP 429 responses, are returned from that model rather than selecting another one. Separately, a verified compaction abort after useful progress may continue the retained child session once on the same resolved model; this lifecycle recovery preserves work and is not model fallback.

Use `model: "inherit"` in agent frontmatter or `agentOverrides.<name>.model` to select the current parent session model explicitly.

## Setting defaults and overrides

In `~/.pi/agent/settings.json` (user) or the project config settings file (`.pi/settings.json` in standard Pi; project wins):

```json
{
  "defaultModel": "deepseek-v4-pro",
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "defaultProvider": "gpu-a",
    "agentOverrides": {
      "oracle": {
        "model": "deepseek-v4-pro"
      },
      "worker": {
        "defaultProvider": "gpu-b"
      }
    }
  }
}
```

To keep one role definition but configure it differently for work and personal providers, add the unambiguous provider map beside `agentOverrides`:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": { "thinking": "medium" }
    },
    "agentOverridesByProvider": {
      "github-copilot": {
        "worker": { "model": "github-copilot/gpt-5-mini" }
      },
      "openrouter": {
        "worker": { "model": "openrouter/openai/gpt-5-mini" }
      }
    }
  }
}
```

The provider key comes from the active parent session model (or an explicit host `preferredProvider`). Provider-scoped fields layer over the ordinary override in the same settings file; project settings still win over user settings.

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent role override:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high"
      }
    }
  }
}
```

`subagents.defaultModel` and `subagents.defaultProvider` apply to builtin, package, user, project, and runtime-registered agents. `defaultModel` fills only agents that do not set `model` in frontmatter or in their runtime definition. `defaultProvider` is also applied to frontmatter and override models so bare ids resolve against the intended provider. Per-run model overrides and `agentOverrides.<name>.model` win over frontmatter and the global default. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable an agent (see [agents.md](agents.md)); matching custom-agent frontmatter is replaced for any field set by the override. Runtime-registered agents take only `model`, `defaultProvider`, `fast`, and `thinking` from `agentOverrides.<name>`; their other definition fields stay owned by the registering extension.

## Named model classes and same-class failover

Use lowercase kebab-case class names. Each pool is ordered; a project pool replaces the user pool with the same name as one unit rather than merging candidates.

```json
{
  "subagents": {
    "modelPools": {
      "fast": ["deepseek/deepseek-v4-flash:off", "openai-codex/gpt-5.6-luna:off"],
      "medium": ["openai-codex/gpt-5.6-terra:medium", "deepseek/deepseek-v4-pro:medium"],
      "smart": ["openai-codex/gpt-5.6-sol:high", "anthropic/claude-fable-5:medium"]
    },
    "agentOverrides": {
      "scout": { "modelClass": "fast" },
      "worker": { "modelClass": "medium" },
      "oracle": { "modelClass": "smart" }
    }
  }
}
```

Per-run forms are `modelClass: "smart"` in structured calls/workflow children and `/run oracle[modelClass=smart] ...`. An explicit per-run or agent-override class must exist. An unmapped frontmatter class falls back to its concrete `model`/`fallbackModels`, then the normal defaults.

The pool is resolved and frozen when the child launches. Status/results expose `modelRouting` with the class, source, pool digest, and candidates; retained resume uses that frozen candidate set even if settings later change. Recent performance data may reorder that set for execution, but it never rewrites the frozen routing snapshot.

Failover stays inside the selected class. Each entry is an independent candidate: retryable transient, unavailable, authentication, authorization, billing, quota, usage-limit, and request-limit failures may try any remaining candidate, including another model under the same provider or aggregation gateway. Context-window, policy, tool, control, and unknown task failures do not fail over. A candidate is attempted at most once because Pi core already owns request-level retries. No-tool/read-only failures restart on the next candidate; workspace edits continue in the retained session; external or unknown effects block automatic failover to avoid duplicate side effects. Model-class failures do not create cross-task cooldowns; a later run evaluates the class afresh.

### Performance-aware class selection

Model-class launches also use fresh first-token and generation-throughput observations. Candidates with measurements are ranked by the predicted time for a 128-token response (`first-token latency + 128 / token-per-second`); candidates without data retain their declared relative order. Real task responses supersede synthetic probe samples. Measurements expire after five minutes by default and affect ordering only, never class membership or cross-run eligibility.

On a cold cache, the declared first candidate starts immediately. Bounded tool-free requests probe unmeasured alternatives in the background, with at most two probes active across local Pi processes. Each probe stops after 15 seconds or about 64 estimated output tokens and consumes real provider quota. Probe results are shown only in human-facing UI/run details and never added to the parent agent's result.

For a child launched through `modelClass`, pi-subagents estimates output at four characters per token and monitors text, thinking, and tool-call deltas. It excludes tool execution, coordination waits, and retry backoff:

- A hard first-token stall or rolling throughput below the hard threshold aborts the incomplete response, discards its partial text/tool call, and retries from the same session checkpoint on the best untried candidate.
- Throughput below the soft threshold finishes the current response. If that response invokes a tool, its tool work is retained and the best untried candidate is selected before the next model response.
- A final response is never rerun for soft degradation, and the last candidate continues even when slow.

Exact `model` launches and legacy explicit `model`/`fallbackModels` chains do not use performance probing or performance-driven switching.

The optional settings below override the defaults; project settings win field by field over user settings:

```json
{
  "subagents": {
    "modelPerformance": {
      "firstTokenTimeoutMs": 45000,
      "hardTokensPerSecond": 2,
      "softTokensPerSecond": 8,
      "cacheTtlMs": 300000,
      "mainAdvisoryDurationMs": 30000
    }
  }
}
```

The hard rolling window is 20 seconds and the soft rolling window is 30 seconds. `hardTokensPerSecond` must be lower than `softTokensPerSecond`.

The interactive main agent is advisory-only: pi-subagents never aborts or changes its model. When a response is slow, pi-subagents opens an overlay once per model per session. It closes automatically after `mainAdvisoryDurationMs` (30 seconds by default), or immediately with Esc. Set that value to `0` to suppress the overlay while keeping performance monitoring and background probes. If the current provider/model maps (ignoring thinking level) to exactly one configured class, the overlay recommends another candidate from that class and may probe alternatives for future routing; otherwise it shows a generic warning. The advisory is not inserted into model context or session entries.

Use `/subagents-model-performance` in the Pi TUI to inspect every configured model class's cached first-token and generation-throughput measurements and candidate order in a centered overlay. Fresh measurements determine the order; candidates without fresh samples retain their order from settings. The cache expires after `cacheTtlMs` (five minutes by default), so a previously measured candidate can show `no fresh sample`. The command reads the cache without starting a new probe or switching the main model. Press Esc to close the overlay.

## Launch Fast (`fast: true`)

Set `fast: true` on a run, in agent frontmatter, or in `subagents.agentOverrides.<name>.fast` to request the OpenAI priority service tier for that native OpenAI-Codex child launch. This can use a higher quota tier or cost more. It is off by default.

Launch Fast fails before launch unless every resolved model candidate is on the allowlist. The current allowlist is `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol`. External runners, Anthropic models, and other providers do not use Launch Fast.

## Session Fast (`/fast`)

Session Fast requests `service_tier: "priority"` without changing the logical model or provider route. Configure eligible exact model IDs in the extension config (see [configuration.md](configuration.md)):

```json
{
  "fastMode": {
    "models": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]
  }
}
```

Eligibility uses `model.id` only and is provider-independent. Matching is exact and case-sensitive; there is no suffix, family, or fuzzy matching. An ID may itself contain `/`. The `fast` semantic model-pool name is unrelated.

The mode is off by default. `/fast` toggles it, `/fast on` and `/fast off` set it explicitly, and `/fast status` reports both the session state and whether the current model is eligible. The state is stored on the active session branch, so resume, reload, and fork restore the last branch value.

While Session Fast is enabled, pi-subagents publishes the compact extension status `fast` for HUDs and footers that display Pi extension statuses. Turning the mode off clears it. The indicator represents the session-wide mode, not whether the current main-agent model is eligible, because eligible descendants may still use the priority tier.

Changes apply to the next provider request made by the root agent or any native foreground, background, resumed, or nested Pi child in that session. An in-flight request is unchanged. Unsupported models remain on their normal service tier. External CLI and external-job runners are unaffected.

Session Fast and Launch Fast are independent. They may both write the same priority tier; `/fast off` stops only Session Fast and does not disable a child's `fast: true` launch option.

## Recommended model tiering (optional)

A setup that works well in practice: route agents by task shape instead of running everything on one model. Four tiers:

1. **Fast workhorse** — the cheapest capable model at low thinking, for recon, lookups, and mechanical edits. Example: `openai-codex/gpt-5.6-luna:low` on `scout`.
2. **Standard well-scoped** — a mid-tier model at medium thinking, for most delegations: routine multi-file edits, focused reviews, straightforward implementation. Example: `openai-codex/gpt-5.6-luna:max` on `worker`, `reviewer`, and a lightweight `delegate` agent.
3. **Deep but bounded** — a top reasoning model at high thinking, only for hard tasks that arrive with explicit goals and completion criteria. These models tend to loop on vague goals, so keep them off open-ended work. Example: `openai-codex/gpt-5.6-sol:high` on oracle-style agents.
4. **Taste and intent** — a model that reads human intent well and makes judgment calls without looping, for ambiguous work: UX and design decisions, product tradeoffs, planning from vague requirements, writing quality. Example: `anthropic/claude-fable-5` at `low` for lighter passes and `medium` for harder ones.

The routing rule: use the capability tiers (1–3) when the task is well-scoped, and the intent tier (4) when scoping or judging is the task itself.

Each launch resolves one model and starts the child once unless a model class or legacy `fallbackModels` entries are configured. Provider errors on a single-model launch are returned from that attempt; to try another model, the parent or operator must issue a later explicit launch. Separately, a verified compaction abort after useful progress may continue the retained child session once on the same resolved model; this lifecycle recovery preserves work and is not model fallback.

Give tier-4 agents a cross-provider `modelClass` pool (or legacy `fallbackModels`) so subscription usage limits degrade gracefully instead of failing the run. Named classes and legacy concrete fallbacks use the same failure classifier and effect-safety rules. Ordinary task failures and the outer run-level `timeoutMs` / `maxRuntimeMs` deadline do not trigger fallback.

Fallback uses native Pi sessions, not fresh `pi` CLI processes. Even when an exact session file is reopened, normal fallback resubmits the original task; retained history alone does not make automatic continuation after tool work safe.

Example fallback configuration:

```yaml
---
name: shaper
description: Open-ended design/UX/product/planning agent for ambiguous tasks
model: anthropic/claude-fable-5
thinking: medium
fallbackModels: openai-codex/gpt-5.5:high
---
```

One interaction worth knowing for tier 4: forked context over an Anthropic parent transcript strips the parent's signed thinking blocks from the child session, because a thinking signature cannot be replayed into a branch. The child still runs at its requested thinking level and reasons fresh from its first turn.

## Thinking level defaults

Set `subagents.defaultThinking` to give builtin, package, user, and project agents without a `thinking` value a shared thinking level, independent of the parent session's default. Project settings win over user settings. Matching `agentOverrides.<name>.thinking` and per-run thinking overrides replace frontmatter; otherwise explicit frontmatter remains in effect. `thinking: false` remains an explicit opt-out:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "agentOverrides": {
      "reviewer": { "thinking": "high" }
    }
  }
}
```

If your provider rejects model IDs with thinking suffixes, set `subagents.disableThinking: true` in user or project settings. That clears bundled builtin thinking defaults in one place. An explicit higher-precedence `agentOverrides.<name>.thinking` value can opt a role back in or replace custom-agent frontmatter thinking.

### Thinking ceiling

Set `subagents.maxThinking` to enforce a hard maximum for every native Pi child. The supported levels, from least to most thinking, are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`:

```json
{
  "subagents": {
    "defaultThinking": "medium",
    "maxThinking": "xhigh"
  }
}
```

Requests above the ceiling fail before child startup; the setting covers frontmatter, `agentOverrides`, per-run overrides, parallel/chain children, nested launches, and resumed children. Project settings take precedence over user settings. External runners retain their existing behavior.

## Extension defaults

Set `subagents.defaultExtensions` to give builtin, package, user, and project agents without an `extensions` field a shared extension allowlist:

- Absent: preserves Pi's normal ambient extension discovery.
- Empty array: sets `extensions: []` for agents that do not explicitly define it, disabling ambient extension loading.
- Non-empty array: supplies that allowlist to agents that do not explicitly define one.

Project settings win over user settings. Use `agentOverrides.<name>.extensions` for per-agent settings; a matching override replaces custom-agent frontmatter for that field.

```json
{
  "subagents": {
    "defaultExtensions": [],
    "agentOverrides": {
      "researcher": {
        "extensions": ["./tools/research.ts"]
      }
    }
  }
}
```

Set `subagents.defaultSubagentOnlyExtensions` to give agents without a `subagentOnlyExtensions` field a shared child-only extension list while preserving ambient extension discovery. An empty array is an explicit empty default but, unlike `defaultExtensions: []`, does not disable ambient extensions. An agent's frontmatter list (including `[]`) suppresses the default; user and then project `agentOverrides.<name>.subagentOnlyExtensions` replace it or clear it with `false`. Lists are not combined.

The two defaults resolve independently, with an explicitly present project value winning over the user value. If both are set, `defaultExtensions` still disables ambient discovery and the child-only paths are loaded alongside its allowlist. Both reject non-arrays, non-string or blank entries with an error naming the setting and source file. Extension paths execute trusted code, so use project defaults only for trusted repositories and extensions.

## Inspecting the live mapping

To see what `pi-subagents` has actually loaded right now:

```text
/subagents-models
/subagents-models reviewer
```

That reports the live runtime mapping, which can differ from settings on disk until you reload Pi.

## Fuzzy model matching

You do not have to spell a model exactly. Model ids are matched fuzzily against the registry, so these all resolve to the same model:

- Provider separator variations: `anthropic/claude-sonnet-4`, `anthropic:claude-sonnet-4`, `anthropic.claude-sonnet-4`
- Id separator variations: `claude-haiku-4.5` vs `claude-haiku-4-5`
- Case differences: `Claude-Sonnet-4` vs `claude-sonnet-4`
- Optional trailing date stamps: `claude-haiku-4-5-20251001` or `claude-haiku-4-5-2025-10-01` vs `claude-haiku-4-5`

Exact `provider/id` matches still win, and a qualified provider query never silently switches providers — it only matches within the named provider. Ambiguous bare ids that exist under multiple providers still require a provider prefix or the current session's provider to disambiguate.

Registry ids that themselves contain `/` (Hugging Face `owner/name`) resolve the same way as Pi's main agent: `thinkingmachines/Inkling` becomes `huggingface/thinkingmachines/Inkling` when that id is unique or offered by the current session provider. A first path segment that matches a registered provider still means `provider/id`.

## Model scope enforcement

To keep subagents inside a budget or compliance profile, enforce a model scope. Put `subagents.modelScope` in user or project settings (project overrides user):

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["inherit", "openai/gpt-5-*", "openai-codex/gpt-5.6-*"],
      "agents": {
        "worker": { "allow": ["openai-codex/gpt-5.6-luna"] },
        "reviewer": { "allow": ["inherit"] }
      }
    }
  }
}
```

- `allow` is a list of glob patterns matched against the resolved `provider/id` (only `*` is special, case-insensitive). The literal `inherit` means the current parent session model.
- `agents.<name>` adds a second allow-list for that agent. The model must pass both the global list and the matching agent list, so an agent rule cannot weaken the global rule. Agent rules inherit `enforce` and `strict` when those fields are absent.
- A top-level `enforce: true` with only agent allow-lists restricts only those named agents. Unknown names are allowed so settings can be shared across projects and machines.
- Models you pass explicitly — the tool-call `model`, `--model`, or a clarify pick — error and abort the run.
- By default, models from agent frontmatter, `subagents.defaultModel`, or the inherited parent session model only warn and remain available, so existing configurations keep working while you tighten the scope.
- Set `strict: true` with `enforce: true` to reject every resolved out-of-scope model, including inherited models.
- `enforce: true` requires at least one non-empty global or agent `allow` list; otherwise the config is rejected at load time.

Model scope is policy only. It rejects or warns; it does not select a cheaper model. Set `agentOverrides.worker.model` to choose a worker model and use `modelScope.agents.worker` to prevent a per-run override from escaping that restriction.

`inherit` expands in the parent process at each launch. It is never sent to the child as a model id. A nested child therefore inherits its immediate parent's current model, not the original top-level model. If no parent model is available, an enforced `inherit` entry does not match and fails closed.

Project `modelScope` settings replace the complete user `modelScope`, as with the existing project-over-user settings precedence. Project settings are trusted and can therefore replace user restrictions.

## Profiles and provider model catalogs

Profiles let you generate and save role-to-model assignments from a provider's live catalog.

Profiles are stored under:

```text
~/.pi/agent/profiles/pi-subagents/
```

Provider model catalogs are cached under:

```text
~/.pi/agent/profiles/pi-subagents/providers/
```

The workflow:

```text
/subagents-refresh-provider-models openai-codex
/subagents-generate-profiles openai-codex
/subagents-load-profile openai-codex.quota
```

- `/subagents-refresh-provider-models` writes a serialized provider model catalog with observed registry data, simple role-oriented classification, and live probe results from tiny one-shot `pi -p --model ... --no-tools` checks. The cache refreshes when missing or stale; use `--force` to ignore freshness and probe again immediately.
- `/subagents-generate-profiles` uses the provider catalog to produce quota and quality profiles.
- `/subagents-check-profile` re-checks each assigned model in a saved profile against the current registry and a live probe, so you can detect model removals, auth problems, or stale assignments.
