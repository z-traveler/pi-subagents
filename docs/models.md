# Models

How subagents pick models, and how to change that.

Builtin agents inherit your current Pi default model. This keeps new installs from depending on a provider you may not have configured. From there you can layer defaults and overrides:

- `subagents.defaultModel` — a default for every subagent that does not set its own model.
- `subagents.modelPools.<class>` — an ordered pool behind a semantic class such as `fast`, `medium`, or `smart`.
- `subagents.agentOverrides.<name>.modelClass` — route one role through a named pool.
- `subagents.agentOverrides.<name>.model` — pin one role.
- Per-run overrides — for one launch only.

Precedence, strongest first: per-run `model` → per-run `modelClass` → `agentOverrides.<name>.model` → mapped class (`agentOverrides.<name>.modelClass` before frontmatter `modelClass`) → frontmatter `model` → `subagents.defaultModel` → the parent session model. One override object cannot set both `model` and `modelClass`; agent frontmatter may keep both so its concrete model remains a portable fallback when a deployment has no mapping for that frontmatter class.

## Setting defaults and overrides

In `~/.pi/agent/settings.json` (user) or the project config settings file (`.pi/settings.json` in standard Pi; project wins):

```json
{
  "defaultModel": "deepseek-v4-pro",
  "subagents": {
    "defaultModel": "deepseek-v4-flash",
    "agentOverrides": {
      "oracle": {
        "model": "deepseek-v4-pro"
      }
    }
  }
}
```

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent role override with a backup model for provider failures:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

`subagents.defaultModel` applies to builtin, package, user, and project agents that do not set `model` in frontmatter. Per-run model overrides and `agentOverrides.<name>.model` still win, and explicit agent frontmatter still wins over the global default. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin (see [agents.md](agents.md)). Matching user and project agents also receive override fields that their frontmatter leaves unset, so a shared project config agent can keep the persona while local settings choose the model.

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

The pool is resolved and frozen when the child launches. Status/results expose `modelRouting` with the class, source, pool digest, and candidates; retained resume uses that frozen candidate set even if settings later change.

Failover stays inside the selected class. Transient/provider-unavailable failures may try the next candidate; auth, billing, and quota failures cross only to a different provider. Context-window, policy, tool, control, and unknown task failures do not fail over. A candidate is attempted at most once because Pi core already owns request-level retries. No-tool/read-only failures restart on the next candidate; workspace edits continue in the retained session; external or unknown effects block automatic failover to avoid duplicate side effects.

## Recommended model tiering (optional)

A setup that works well in practice: route agents by task shape instead of running everything on one model. Four tiers:

1. **Fast workhorse** — the cheapest capable model at low thinking, for recon, lookups, and mechanical edits. Example: `openai-codex/gpt-5.6-luna:low` on `scout`.
2. **Standard well-scoped** — a mid-tier model at medium thinking, for most delegations: routine multi-file edits, focused reviews, straightforward implementation. Example: `openai-codex/gpt-5.6-terra:medium` on `worker`, `reviewer`, and a lightweight `delegate` agent.
3. **Deep but bounded** — a top reasoning model at high thinking, only for hard tasks that arrive with explicit goals and completion criteria. These models tend to loop on vague goals, so keep them off open-ended work. Example: `openai-codex/gpt-5.6-sol:high` on oracle-style agents.
4. **Taste and intent** — a model that reads human intent well and makes judgment calls without looping, for ambiguous work: UX and design decisions, product tradeoffs, planning from vague requirements, writing quality. Example: `anthropic/claude-fable-5` at `low` for lighter passes and `medium` for harder ones.

The routing rule: use the capability tiers (1–3) when the task is well-scoped, and the intent tier (4) when scoping or judging is the task itself.

Give tier-4 agents a cross-provider `modelClass` pool (or legacy `fallbackModels`) so subscription usage limits degrade gracefully instead of failing the run:

```yaml
---
name: shaper
description: Open-ended design/UX/product/planning agent for ambiguous tasks
model: anthropic/claude-fable-5
thinking: medium
fallbackModels: openai-codex/gpt-5.5:high
---
```

One interaction worth knowing for tier 4: forked context over an Anthropic parent transcript with signed thinking blocks forces the child's thinking off, so intent-tier agents work best with fresh context.

## Thinking level defaults

Set `subagents.defaultThinking` to give builtin, package, user, and project agents without a `thinking` value a shared thinking level, independent of the parent session's default. Project settings win over user settings. Explicit frontmatter, `agentOverrides.<name>.thinking`, and per-run thinking overrides still win. `thinking: false` remains an explicit opt-out:

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

If your provider rejects model IDs with thinking suffixes, set `subagents.disableThinking: true` in user or project settings. That clears bundled builtin thinking defaults in one place. An explicit higher-precedence `agentOverrides.<name>.thinking` value can opt a role back in. Existing custom-agent frontmatter remains authoritative.

## Extension defaults

Set `subagents.defaultExtensions` to give builtin, package, user, and project agents without an `extensions` field a shared extension allowlist:

- Absent: preserves Pi's normal ambient extension discovery.
- Empty array: sets `extensions: []` for agents that do not explicitly define it, disabling ambient extension loading.
- Non-empty array: supplies that allowlist to agents that do not explicitly define one.

Project settings win over user settings. Use `agentOverrides.<name>.extensions` for per-agent settings; explicit custom-agent frontmatter remains authoritative.

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

A non-array value, an array containing a non-string entry, or an empty/whitespace-only string raises a settings error naming `defaultExtensions` and the offending settings file, matching the validation pattern used by `defaultModel` and `defaultThinking`.

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

## Model scope enforcement

To keep subagents inside a budget or compliance profile, enforce a model scope. Put `subagents.modelScope` in user or project settings (project overrides user):

```json
{
  "subagents": {
    "modelScope": {
      "enforce": true,
      "strict": true,
      "allow": ["anthropic/*", "openai/gpt-5-*"]
    }
  }
}
```

- `allow` is a list of glob patterns matched against the resolved `provider/id` (only `*` is special, case-insensitive). A resolved model that matches none of the patterns is rejected.
- Models you pass explicitly — the tool-call `model`, `--model`, or a clarify pick — error and abort the run.
- By default, models from agent frontmatter, `subagents.defaultModel`, the inherited parent session model, or fallback chains only warn and remain available, so existing configurations keep working while you tighten the scope.
- Set `strict: true` with `enforce: true` to reject every resolved out-of-scope model. This includes inherited models and fallback candidates. An invalid fallback fails the run instead of being removed from the candidate chain.
- `enforce: true` requires a non-empty `allow` list; otherwise the config is rejected at load time.

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
