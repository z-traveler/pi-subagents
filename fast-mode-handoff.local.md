# Fast mode handoff

## Goal

Continue the design or implementation of a local Pi `/fast` command that works through CLIProxy and applies coherently to the full `pi-subagents` tree.

The user does not want to install `router-for-me/pi-cliproxyapi-provider`. They manage Pi through `/home/z/projects/pi-src`, will configure CLIProxy themselves, and did not authorize configuration changes during the research conversation.

The user explicitly rejected deriving aliases by appending `-fast`. Model-to-Fast-alias relationships must be exact and configurable; alias names may be arbitrary.

## Confirmed behavior

As of 2026-09-14, Codex CLI `rust-v0.154.0` treats Fast as a root-owned request-routing tier, not as a different model:

- `/fast` changes the root service tier shared by the whole agent tree.
- It does not change a child's model or reasoning effort.
- Existing children use the new tier on their next provider request; new, resumed, and nested children inherit it. An already-issued request is unchanged.
- The tier is applied after the child model is resolved. Unsupported models omit the Fast tier and continue at Standard.

References:

- <https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/agent/control/service_tier.rs>
- <https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/handlers/multi_agents_common.rs>
- <https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/tests/suite/subagent_service_tier.rs>

Earlier CLIProxy investigation established:

- The local CLIProxy container was `eceasy/cli-proxy-api:v7.2.147`; upstream was `v7.3.2` when checked.
- The Responses path accepts `service_tier: "priority"`; literal `service_tier: "fast"` is not the correct wire value.
- The Chat Completions translation path did not reliably carry the caller's `service_tier`, so Hermes needs a CLIProxy model alias/payload override or an equivalent CLIProxy-side route.

Reverify these version-sensitive facts before relying on them in implementation.

## Local Pi facts

Read these before changing code:

- `/home/z/projects/pi-src/AGENTS.md`
- `/home/z/projects/pi-src/pi-core/AGENTS.md`
- `/home/z/projects/pi-src/pi-subagents/AGENTS.md`
- `/home/z/projects/pi-src/pi-subagents/VISION.md`
- `/home/z/projects/pi-src/pi-subagents/docs/models.md`
- `/home/z/projects/pi-src/pi-subagents/docs/configuration.md`

Relevant runtime/configuration files:

- `~/.pi/agent/models.json` defines provider `cliproxy` using `openai-responses` at the local CLIProxy endpoint.
- `~/.pi/agent/settings/settings.cliproxy.json` currently sets the main model to `cliproxy/gpt-5.6-sol` and pins subagents through `subagents.defaultModel`, `modelPools`, and `agentOverrides`.
- `~/.pi/agent/settings.json` is generated; do not edit it directly.
- `settings.static.json` pins the stable `pi-subagents` package version. Verify the installed stable version against the checkout before implementing; the checkout may contain newer Fast code than the active package.

Current child-routing precedence is documented in `docs/models.md`: per-run `model`/`modelClass`, provider-scoped override, ordinary override, frontmatter, `subagents.defaultModel`, then inherited parent model. Consequently, changing only the main Pi model does not affect most locally configured children.

The name `subagents.modelPools.fast` already means a semantic model pool for quick/cheap work. It is unrelated to OpenAI Fast/Priority service routing and must not be reused as the service-mode state.

The newer checkout contains a separate per-launch `fast: true` mechanism:

- `src/runs/shared/fast-mode-extension.ts` injects `service_tier: "priority"`.
- `src/runs/shared/child-tool-plan.ts` hard-codes an allowlist of native `openai-codex` models.
- `src/runs/shared/child-hooks.ts` installs the Fast hook only when the launch was already marked Fast.

That mechanism is not a root-session `/fast` mode, does not support arbitrary `cliproxy` mappings, and cannot dynamically update an already-running child. Account for the installed-version ambiguity before deciding whether to replace, migrate, or coexist with it.

## Recommended design

Treat Fast as an orthogonal root-owned request-routing mode. Keep Pi's logical provider/model unchanged and translate only the outgoing wire model sent to CLIProxy.

Suggested configuration shape in `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "fastMode": {
    "modelMappings": {
      "cliproxy/gpt-5.6-sol": "gpt-5.6-sol-priority",
      "cliproxy/gpt-5.6-terra": "terra-turbo",
      "cliproxy/gpt-5.6-luna": "my-fast-luna"
    }
  }
}
```

The left side is the exact logical `provider/model`. The right side is the arbitrary model ID exposed by CLIProxy for the Fast route. No suffix parsing, fuzzy matching, or implicit provider switching is allowed.

Recommended runtime semantics:

1. Parent mode registers `/fast on`, `/fast off`, and `/fast status`.
2. The root session owns one Standard/Fast state.
3. A `before_provider_request` adapter looks at the logical model in the extension context. When Fast is active and a mapping exists, it rewrites only `payload.model` to the configured CLIProxy alias.
4. Pi's current model, model picker, session history, reasoning level, model pool, and fallback identities remain logical/base models. Fast aliases do not need duplicate entries in `models.json`.
5. The same mapping should automatically authorize the corresponding response model alias for native-child verification; do not require a second `modelResponseAliases` declaration for the same pair.
6. An unmapped model remains Standard, matching current Codex behavior. Status/observability must not claim that such a request was accelerated.

The mapping is a contract that both IDs represent the same underlying model with different CLIProxy routing. Do not use it to switch to a model with different context or capability metadata.

## Subagent propagation

The root state must apply after normal child model routing, so pinned `defaultModel`, role overrides, explicit models, model-class pools, fallbacks, and nested children all retain their existing selection semantics.

Desired propagation:

- Foreground children read the shared root Fast policy before every provider request.
- Detached/background runners receive a versioned policy snapshot at launch and updates through the existing control-channel mechanism.
- Root changes are broadcast to active runners. Existing children use the new policy on their next request; requests already in flight are untouched.
- New, resumed, recovered, and nested children start from the current root snapshot.
- Do not simulate control updates with natural-language steering messages.

Relevant seams:

- Pi command/request hooks: `pi-core/packages/coding-agent/src/core/extensions/types.ts` and `core/extensions/runner.ts`.
- Child hook construction: `src/runs/shared/child-hooks.ts`.
- Background control channel: `src/runs/background/control-channel.ts` and `src/runs/background/subagent-runner.ts`.
- Response-model verification and aliases: `src/runs/shared/model-fallback.ts`.
- Session-state restoration pattern: `src/extension/main-agent.ts`.

Prefer implementing this inside the existing `pi-subagents` package because it owns the delegation tree, child hooks, detached-runner lifecycle, and control channel. No `pi-core` change or provider extension should be necessary.

## Alternatives already considered

An independent extension that switches the current session with `pi.setModel()` is small, but insufficient here: most local roles are pinned by `modelClass`, overrides, or `subagents.defaultModel`; existing and fallback children would not follow.

A generic multi-tier model-family system supports `standard`, `fast`, `economy`, and arbitrary cross-provider variants, but expands the current requirement. Preserve a clean internal resolver if useful, without exposing extra commands or configuration until requested.

Hard-coded `-fast` suffix inference was rejected by the user and must not be reintroduced.

## Open decisions

- Decide whether bare `/fast` displays status or toggles. The safer recommendation was status; the user has not confirmed this detail.
- Decide how to migrate or remove the newer per-run/frontmatter `fast: true` authority if the implementation branch includes it. Two independent Fast authorities would be confusing.
- Verify whether CLIProxy returns the requested Fast alias or the canonical upstream model ID, then cover both exact response-verification cases.
- Verify the target stable branch/version before coding and follow the `main`/`z`/immutable-tag workflow in `/home/z/projects/pi-src/AGENTS.md`.

## Acceptance criteria

- Alias relationships come only from exact configuration; no `-fast` convention exists in code.
- `/fast on|off|status` controls only the current root session and does not rewrite generated settings or default models.
- Main, existing child, future child, resumed child, and nested child behavior matches the propagation rules above.
- All normal subagent model-selection precedence and fallback ordering remain unchanged.
- Thinking suffixes and reasoning levels remain unchanged.
- Unmapped providers/models send their original model ID and are reported as Standard/unmapped.
- A Fast mapping cannot bypass model scope, authentication, or provider routing constraints.
- Response model verification accepts only aliases implied by the exact configured mapping.
- Unit tests cover mapping validation, request rewrite, unmapped models, on/off/status, state restoration, foreground propagation, background propagation, resume, nested children, and in-flight request immutability.
- No configuration or production file is modified outside the requested implementation scope.

## Suggested skills

The next agent should call these skills before implementation:

- `codebase-design`: confirm the root-policy Module, request Adapter, and subagent propagation seam.
- `tdd`: drive the change from the acceptance criteria, especially foreground/background propagation and response verification.
- `diagnosing-bugs`: use only if observed CLIProxy responses or background propagation disagree with the confirmed model.

No repository files other than this handoff were intentionally changed in this conversation.
