# Claude Code、Codex 与 pi-subagents 的 subagent 上下文比较

## 范围与证据

本文区分三种机制，避免把同名的 “subagent” 混在一起：

1. Claude Code 原生 subagent；
2. OpenAI Codex 原生 multi-agent/subagent；
3. pi-subagents 的 Pi-native child 与 `claude-code` / `codex-exec` external-CLI profiles。

Claude 行为依据 Anthropic 官方文档；Codex 行为依据 OpenAI 官方源码
`openai/codex@5c5308fc9a9ee789049d646ef11e5400384b9c6f`；pi-subagents 行为依据本仓库
`e07e02a203003b83a7c5ba7b6d2402543561ea93`。源码事实与官方公开文档不一致时，以对应提交的源码为准，并明确版本条件。

## 结论摘要

- **Claude Code 普通 subagent**：fresh isolated context，不继承父对话历史，但默认装载父会话所装载的
  CLAUDE.md 层级及作为项目指令加载的 AGENTS.md。Claude 的 `fork` 模式则继承整个父会话。
- **Codex 当前源码有 V1/V2 两套语义**：默认启用的是 V1；V1 默认 fresh，仅在
  `fork_context: true` 时 fork。V2 当前默认关闭；启用后，`fork_turns` 缺省为 `all`，即默认复制经过过滤的父历史。
- **Codex 的 AGENTS.md 是混合策略**：用户级 `$CODEX_HOME/AGENTS*.md` 继承父线程已经解析的文本快照；
  项目级 AGENTS.md 按 child 的 cwd/environment 重新发现。child 不重新读取 `$CODEX_HOME` 用户指令文件。
- **Codex child 的配置来自父 turn 的有效配置快照**：cwd、approval、sandbox、model/reasoning、MCP、skills、
  plugins 等随配置复制，再叠加 agent role 和 spawn 参数覆盖。
- **pi-subagents 的 external CLI profiles 不是原生 Claude/Codex subagent**：它们只向一次性外部进程发送
  `<System instructions>` 与 `<Task>`。profile 中的 `inheritProjectContext: true` 当前不会让 Pi 把 AGENTS.md
  注入外部进程。
- Codex adapter 使用的 `--ignore-rules` 只忽略 execpolicy `.rules`，**不忽略 AGENTS.md**；
  `--ignore-user-config` 只忽略 `$CODEX_HOME/config.toml`，也**不直接忽略 AGENTS.md**。

## 对比表

| 上下文组件 | Claude 普通 subagent | Claude `fork` | Codex V1（当前默认） | Codex V2（当前默认关闭） | Pi-native child |
|---|---|---|---|---|---|
| 父对话历史 | 不继承 | 整体继承 | 默认不继承；`fork_context:true` 才 fork | 默认 `fork_turns:"all"`，继承过滤后的历史；可设 `none` 或最近 N turns | fresh；仅显式 fork context 时传递 |
| 任务 | 父 agent 编写 delegation message | 位于继承上下文/新任务中 | 单独 initial user input | `InterAgentCommunication(Spawn)` | task handoff |
| system/base instructions | 使用 agent 自己的 system prompt，不使用主 Claude Code system prompt | 继承父 system prompt | 从父 session/turn 的有效配置构造 child config | 同 V1，并处理 fork 中的 system/developer messages | `systemPromptMode` 控制 append/replace |
| 用户级规则 | 默认加载 `~/.claude/CLAUDE.md` | 随完整上下文继承 | 继承父线程已应用的 `$CODEX_HOME/AGENTS*.md` 文本快照 | 同 V1 | 仅 `inheritProjectContext && inheritGlobalContext` 时保留 |
| 项目级规则 | 默认加载 CLAUDE.md 层级和已加载的 AGENTS.md | 随上下文继承 | child 按自己的 cwd/environment 重新发现 AGENTS.md | 同 V1；full fork 还可保留 reference context prefix | `inheritProjectContext:true` 时按 child cwd 加载 |
| Skills/MCP | skills 需预加载或运行时发现；MCP 从父能力中缩减 | 随父上下文/能力 | 由父 turn config clone，agent role 可覆盖 | 同 V1 | 分别受 agent 定义和 runtime 控制 |
| Sandbox/approval | 独立权限与工具过滤 | 继承父 tools/model 等 | 继承父 live turn 的 runtime selection | 同 V1 | child launch policy |
| Resume/persistence | 独立 transcript，可恢复 | 可恢复 | 正常 first-class thread，可持久化/恢复/steer | 同 V1，另有 eviction/reload | 原生 run 支持 resume/steer |

## Claude Code 原生 subagent

Anthropic 官方文档明确说明普通 subagent 使用全新的独立 context window。启动时包括：

- subagent 自己的 system prompt，加上 Claude Code 附加的环境信息；
- 父 agent 编写的任务消息；
- 父会话装载的 CLAUDE.md 层级，包括用户、项目、本地和 managed policy，以及作为项目指令加载的 AGENTS.md；
- 父会话启动时的 git-status snapshot；
- agent 定义的 `skills` 字段中列出的 skill 全文；
- 适用时的 sibling roster。

普通 subagent 不继承：

- 父 conversation history；
- 父会话已经调用的 skills；
- 父 agent 已读取的文件；
- 父 output style、auto memory、context-window size 和 prompt cache。

`omitClaudeMd: true` 可以省略普通 CLAUDE.md；Explore 和 Plan 内置 agent 默认不加载 CLAUDE.md 和 git status。
Claude `fork` 则明确继承同一 system prompt、tools、model 和 message history，并共享 prompt cache。

来源：[Claude Code subagents](https://code.claude.com/docs/en/sub-agents)。

## Codex 原生 subagent：源码结论

### 两套版本必须分开讨论

当前源码中：

- `Feature::Collab`（`multi_agent`）为 stable 且 `default_enabled: true`；
- `Feature::MultiAgentV2` 为 stable 但 `default_enabled: false`。

见 `codex-rs/features/src/lib.rs:1301-1314`。

因此，不应笼统地说“Codex subagent 默认 fork”：

- **V1 默认 fresh**：`SpawnAgentArgs.fork_context` 使用 `#[serde(default)] bool`，缺省为 `false`；仅为真时传入
  `SpawnAgentForkMode::FullHistory`。见
  `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs:50-130,220-232`。
- **V2 默认 filtered fork**：`fork_turns` 缺省为 `"all"`；支持 `"none"`、`"all"`、正整数 N。
  见 `codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:88-230,283-303`。

### fork 并非逐项复制完整 rollout

Codex fork 保留：

- `system`、`developer`、`user` message；
- 只有 `phase == FinalAnswer` 的 assistant message；
- 部分 configuration/session/context metadata。

它丢弃 reasoning、function/tool calls、tool outputs、动态 `AdditionalTools`、inter-agent communication、token usage 等。
完整 fork 可保留 `TurnContext`/`WorldState` reference-context prefix，截断 fork 需要重建。

见 `codex-rs/core/src/agent/control/spawn.rs:72-155`。

因此更准确的说法是：

> V2 默认继承经过模型上下文过滤的父历史，而不是复制父线程的所有内部 rollout 项。

### child 配置如何构造

`build_agent_shared_config` 从父 `TurnContext.config` clone 一份独立配置，再刷新：

- base instructions；
- model/provider/reasoning；
- developer instructions；
- cwd；
- approval policy；
- permission/sandbox profile。

spawn 参数、默认 subagent model/reasoning 和 agent role 随后可以覆盖。MCP servers、plugins、skills、features 和
static tool wiring 等未单独剔除的配置字段随 clone 继承。

见 `codex-rs/core/src/agent/child_config.rs:44-203`。

### AGENTS.md 如何到达 child

Codex 使用两条不同路径。

#### 用户级 `$CODEX_HOME/AGENTS*.md`

root host 创建 `CodexHomeUserInstructionsProvider`，优先读取 `AGENTS.override.md`，否则 `AGENTS.md`：

- `codex-rs/codex-home/src/instructions/mod.rs:12-85`

spawn child 时，`instructions_for_spawn` 从 live parent 取得 `parent.session.inherited_instructions()`：

- `codex-rs/core/src/thread_manager.rs:1754-1786`

`inherited_instructions()` 只复制已经应用的 user/thread 文本以及明确允许分享的 thread provider，故意不把
`user_provider` 传给 child：

- `codex-rs/core/src/agents_md_manager.rs:152-163`

结论：child 继承的是父线程已经解析的用户级规则**文本快照**，不会自行重读 `$CODEX_HOME/AGENTS*.md`。
如果 host 在父线程首次 instruction refresh 前就 spawn，理论上可能继承不到该文本；源码未证明所有 host 都消除了这一时序窗口。

#### 项目级 AGENTS.md

每个 child 有自己的 `AgentsMdManager`/cache。refresh 时根据 child environment selections 和 cwd 调用
`load_project_instructions`：

- `codex-rs/core/src/agents_md_manager.rs:60-137`
- `codex-rs/core/src/agents_md.rs:45-120`

它从项目根到 child cwd 重新发现 `AGENTS.override.md` / `AGENTS.md`，服从 `project_doc_max_bytes`；
显式 untrusted 项目会跳过项目文档。也就是说项目规则不是简单复制父线程渲染后的文本。

### Persistence、resume 与 steer

child 通过正常 `Session`/thread machinery 创建，拥有独立 `ThreadId`、`ThreadSource::Subagent`、
`parent_thread_id` 和 agent graph edge。非 ephemeral 时正常写入 rollout/thread store。

V2 可以从 stored thread 以 `InitialHistory::Resumed` 重新装载被 evict 的 child；V1 也有 `resume_agent` 路径。
后续消息通过 `send_input` 或 V2 inter-agent communication 发送，child 保留自己的历史。

关键入口：

- `codex-rs/core/src/agent/control/spawn.rs:632-840`
- `codex-rs/core/src/agent/control/spawn.rs:323-620,1162+`
- `codex-rs/core/src/agent/control.rs:186,287`

## Codex CLI flags 与本仓库 adapter

`codex-rs/exec/src/cli.rs:35-45` 的 help text 已直接消除了之前的不确定性：

- `--ephemeral`：不把 session files 持久化到磁盘；该 config 被 child clone，因此 native child 也不持久化。
- `--ignore-user-config`：不加载 `$CODEX_HOME/config.toml`，auth 仍使用 `CODEX_HOME`。
- `--ignore-rules`：不加载用户或项目的 execpolicy `.rules` 文件。

`--ignore-rules` 进入 exec-policy loader，而 AGENTS.md 由 `AgentsMdManager`/instructions provider 独立加载，
所以它**不抑制 AGENTS.md**。

`--ignore-user-config` 也不直接抑制 AGENTS.md：全局 AGENTS provider 从 `CODEX_HOME` 直接读取文件；项目 AGENTS
按 cwd 发现。它会删除 config.toml 中的配置层，包括其中可能存在的项目 trust 声明，但“没有 trust 声明”不等于
`untrusted`；只有显式 `Untrusted` 才会在 `agents_md.rs:63-65` 跳过项目文档。managed 等更高层配置仍可能把项目标为 untrusted。

## pi-subagents 的 external CLI profiles

`agents/claude-code.md` 与 `agents/codex-exec.md` 都声明：

```yaml
runner:
  type: external-cli
  promptDelivery: stdin
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
```

但 external-cli 路径发送的全部 Pi-authored prompt 是：

```text
<System instructions>
{profile body}

<Task>
{task}
```

见：

- `src/runs/shared/external-cli-runner.ts:26-28`
- `src/runs/background/subagent-runner.ts:904-920,995`

native Pi child 的 `noContextFiles: !inheritProjectContext` 只存在于 native child launch：

- `src/runs/shared/child-launch.ts:253,310-312`

所以 external profile 的 `inheritProjectContext: true` **不会让 Pi 注入项目规则**。规则是否出现取决于外部 CLI
根据启动 cwd 和自身 flags 的加载行为。

### `codex-exec` profile 的实际含义

本仓库启动：

```text
codex exec --ephemeral --ignore-user-config --ignore-rules \
  --skip-git-repo-check -s read-only -c approval_policy="never" ... -
```

见 `src/runs/shared/codex-exec-adapter.ts`。

根据上述 Codex 源码：

- 它是一个新的 root `codex exec` session，不是父 Pi 会话中的 native Codex child；
- Pi 不传父历史，只传 profile instructions + task；
- session 不持久化；
- config.toml 与 execpolicy `.rules` 被忽略；
- **global/project AGENTS.md 仍可由该 Codex root session 正常加载**，除非项目被其他配置层显式标为 untrusted；
- 若这个 root session 内部再 spawn Codex native child，V1/V2 的 context 规则及 ephemeral 继承才适用。

### `claude-code` profile

本仓库启动一个 `claude -p` one-shot session，并禁用 persistence、工具和 MCP（writer profile 允许有限文件工具）。
Pi 同样不注入项目 context。Anthropic 的 subagent 文档描述的是 session 内原生 subagent，不能直接证明
`claude -p --setting-sources user` 对 CLAUDE.md/AGENTS.md 的具体装载行为；该点仍需单独验证。

## 对 pi-subagents 的直接启示

1. **不要把 external-cli profile 描述成原生 Claude/Codex subagent。** 它们是 fresh one-shot CLI handoff。
2. **`inheritProjectContext` 在 external-cli profile 上当前是静默 no-op。** 应选择一种明确契约：
   - adapter 由 Pi 确定性注入解析后的项目 context；或
   - external runner 禁止/忽略该字段，并明确规则由外部 CLI 自主发现。
3. **不能再把 `codex-exec --ignore-rules` 解释成忽略 AGENTS.md。** 它只针对 execpolicy `.rules`。
4. **讨论 Codex 是否继承父历史时必须标注 V1/V2。** 当前源码默认 V1 fresh；V2 启用后默认 filtered full-history fork。
5. **cwd 对两类系统都重要，但语义不同。** Pi-native child 用 cwd 加载 Pi project context；Codex native child 用自己的
   cwd/environment 重新发现项目 AGENTS；external CLI 则完全依赖外部 root process 的 cwd 发现。

## 剩余不确定点

- Claude `-p --setting-sources user` 是否装载哪些层级的 CLAUDE.md/AGENTS.md，尚未由对应 CLI 源码或专门运行实验验证。
- Codex 不同 host 是否都保证父 thread 在第一次 spawn 前已 refresh 用户 instructions；源码存在继承空 snapshot 的理论时序窗口。
- Codex V2 当前 default-disabled；未来发布若改变 feature default，默认 history 语义会随之改变。
