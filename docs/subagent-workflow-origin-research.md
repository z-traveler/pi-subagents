# 调研：Pi 中 “subagent workflow” 的来源

**结论（2026-08-18）**：本机 Pi 会话里可执行的子代理和 `workflowScript`
工作流由已安装的 **`pi-subagents` 扩展**实现；Pi 核心提供的是扩展/包加载机制，
不是一个原生的 `subagent` 工具。用户级 `leader` agent 和该包自带的 skill/prompts
会进一步规定、并在回复中表述具体的团队工作流。

## 版本与本机验证

- 稳定 Pi 为 `0.84.2`，工作树为
  `pi-core@2509b5c037d366979f2febfce4174b88aeaadc6a`。
- 生效配置将 `pi-subagents` 固定为
  `git:github.com/z-traveler/pi-subagents@v0.50.0-z1`，并设置默认子代理模型及
  `scout`、`worker`、`reviewer`、`oracle` 覆盖。
  [本机配置](/home/z/.pi/agent/settings/settings.cliproxy.json:7)
- `PI_OFFLINE=1 ~/.local/bin/pi list` 成功列出该包，安装 checkout 是
  `/home/z/.pi/agent/git/github.com/z-traveler/pi-subagents`，其 `HEAD` 为
  `0a686dc4f5aad27825bc8847dc89bed5b84d7ebd`（`v0.50.0-z1`）。
- 上游 `v0.50.0` 标签解析为
  `c091da1d9b660c1940ef5dc78cfeeace1aecd435`（2026-08-15）；本机 fork tag 在它
  之上另有三次提交。因此，上游文档以下固定 SHA 引用，本机实现以下用本地当前
  checkout 引用。

## 1. `pi-subagents` 提供的命令、工具与工作流

- 包元数据明确把它定义为“single-agent delegation and scripted multi-agent
  workflows”，并作为 Pi package 同时发布扩展入口、skills 与 prompts。
  [本机 `package.json`](../package.json#L1-L70)
  [上游发布清单](https://github.com/nicobailon/pi-subagents/blob/c091da1d9b660c1940ef5dc78cfeeace1aecd435/package.json)
- 当前扩展源码构建并注册 `subagent` 工具，随后注册 wait 工具；这是子代理运行时
  能力的直接来源。
  [注册代码](../src/extension/index.ts#L566-L644)
- 官方 README 说明扩展会将工作委派给 child Pi session，并自带 `scout`、
  `researcher`、`worker`、`reviewer`、`oracle`、`delegate`；推荐循环是
  `clarify → scout → worker → fresh reviewers → worker`。
  [官方 README](https://github.com/nicobailon/pi-subagents/blob/c091da1d9b660c1940ef5dc78cfeeace1aecd435/README.md#L41-L86)
- 当前公开执行面是 `subagent({ workflowScript: ... })`：`runs.run` 用于顺序，
  `runs.all` 用于并行；`/run` 是把单 child 翻译为 `workflowScript` 的快捷命令。
  [官方工作流文档](https://github.com/nicobailon/pi-subagents/blob/c091da1d9b660c1940ef5dc78cfeeace1aecd435/docs/workflows.md#L36-L71)
  [本机 `/run` 注册](../src/slash/slash-commands.ts#L655-L690)
- 该包的 `pi-subagents` skill 明确要求父会话使用 `workflowScript`、`runs.run` 和
  `runs.all`；`parallel-research`、`review-loop` 等 prompt 则是可重复使用的流程
  文案。这些也会让模型主动使用 “workflow” 一词。
  [skill](../skills/pi-subagents/SKILL.md#L11-L41)
  [parallel-research](../prompts/parallel-research.md#L1-L50)
  [review-loop](../prompts/review-loop.md#L1-L39)

## 2. Pi 核心原生能力与边界

Pi 核心原生支持 packages 和 extensions：package 可提供 extensions、skills、prompts，
extension 可调用 `pi.registerTool()` / `pi.registerCommand()`。这正是
`pi-subagents` 被加载的基础，而不是核心本身实现了子代理。

- [核心 package 文档](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/packages.md#L3-L6)
  [git 包安装位置](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/packages.md#L76-L93)
- [核心 extension API](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/extensions.md#L3-L16)
  [工具注册 API](https://github.com/earendil-works/pi/blob/2509b5c037d366979f2febfce4174b88aeaadc6a/packages/coding-agent/docs/extensions.md#L1347-L1355)
- 核心仓库的 `examples/extensions/subagent/` 是**需手动加载**的 example：示例文档
  要求 `--extension` 或复制进 `~/.pi/agent/extensions/` 才会生效。
  [示例说明](../../pi-core/packages/coding-agent/examples/extensions/README.md#L1-L13)
  [subagent example](../../pi-core/packages/coding-agent/examples/extensions/README.md#L29-L45)
  稳定 `pi-core/packages/coding-agent/src/**/*.ts` 中检索 `subagent` 没有命中，且
  `pi --help` 的 Built-in Tool Names 只有 `read`、`bash`、`edit`、`write`（另有
  可选只读 `grep`、`find`）。所以该 example 不是本机已启用的核心能力。

版本注意：核心 example README 仍展示旧 `tasks`/`chain` 模式；当前
`pi-subagents` 文档则说 `/chain`、`/parallel`、`/run-chain` 不注册，应使用
`workflowScript`。不要以该 example 判断当前扩展 API。
[当前文档](https://github.com/nicobailon/pi-subagents/blob/c091da1d9b660c1940ef5dc78cfeeace1aecd435/docs/workflows.md#L63-L71)
[旧 example](../../pi-core/packages/coding-agent/examples/extensions/subagent/README.md#L91-L98)

## 3. 其他扩展、提示词与 skill 造成的文案

- 用户级资源中只发现 `/home/z/.pi/agent/agents/leader.md`。它显式允许
  `subagent, subagent_wait`，将 Claude 的 team/Agent 映射为 Pi `subagent`，并规定
  无依赖工作用 `workflowScript` + `runs.all`、有依赖工作用 `runs.run`。
  它**塑造策略和措辞**，但不注册工具或启动 child process。
  [frontmatter](/home/z/.pi/agent/agents/leader.md:1)
  [运行时映射](/home/z/.pi/agent/agents/leader.md:13)
- `pi-powerline-footer` 仅读取 `subagent` 工具结果和 `pi-subagents:main-agent`
  会话标记来显示费用/agent 状态，是消费者而非执行者。
  [统计读取](../../pi-powerline-footer/token-stats.ts#L49-L71)
  [状态栏注释](../../pi-powerline-footer/segments.ts#L260-L332)
- `pi-web-access` 的 `workflow` 指 web-search curator/summary 模式
  （`none`、`summary-review`、`auto-summary`），与 `workflowScript` 和 child agent
  无关。
  [类型与参数](../../pi-web-access/index.ts#L124-L179)
  [工具实现](../../pi-web-access/index.ts#L1664-L1691)
- 未发现 `pi-ask-user` 提供子代理或 `workflowScript` 执行面；其命中的
  “workflow”是发布 CI changelog 文案。

## 最终判断与未知点

因此，若用户所说的是委派 `scout`/`worker`/`reviewer`、并行/串行 child run、
`workflowScript`、`/run` 或 `/subagents-*`，答案是：**是，运行时由
`pi-subagents@v0.50.0-z1` 实现**。如果所说的是某条固定的“先调研、再实施、再审查”
自然语言流程，则它是扩展能力加包内 skill/prompt 和用户 `leader` 提示词共同造成的。

本次未启动模型或交互式 TUI，也没有将某一条特定会话回复反查到 transcript；若要
精确归因某句文案，仍需该会话 ID 或脱敏 transcript。现有配置、安装 checkout、
扩展注册源码与 CLI/package 验证已足以回答能力来源问题。
