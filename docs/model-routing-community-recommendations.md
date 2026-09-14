# `modelClass` 的社区路由实践与落地建议

> 调研日期：2026-08-19（Asia/Shanghai）。本文的“社区/官方事实”只引用供应商
> 官方文档；“本项目设计推论”是针对 `pi-subagents` 的建议，不是这些供应商对
> Pi 或任何本机模型的承诺。本文的本机候选表仅结合当前 registry/配置事实与公开
> 官方能力说明；它不是本机基准测试、可用性探测或价格承诺。

## 结论

`modelClass` 应继续是**稳定的逻辑路由名**，而不是一个具体模型的别名；但其语义
应从“快/中/聪明的总排名”收紧为“任务意图 + 最低能力/政策约束”。候选模型只是
满足该契约的、按优先级排列的运行时实现。一次调用应先在同一逻辑类的合格候选中
选择和故障切换，再在显式允许时跨类；候选必须按能力、数据/区域政策、以及独立
故障域过滤，不能仅按模型字符串或供应商名轮换。

这与 LiteLLM 的 `model_name` 逻辑组和组内加权故障切换、OpenRouter 的
“provider 内路由”与“model 间 fallback”两层划分相符；AWS、Google 和
Cloudflare 则进一步说明：路由可按质量/成本、请求元数据、配额和约束发生，但每种
自动选择都必须有明确的可观测结果与版本化配置。补充的 OpenRouter Pareto、Copilot
Auto 和 Cursor Router 证据给出更直接的判断：**质量档位可以是一个受限、已评测领域
（如 coding）的选择阈值；`modelClass` 本身仍应是任务/能力契约，而 quality/cost/
latency 是对该契约内候选的独立优化偏好。**

## 当前 `pi-subagents` 基线（仓库事实，非外部证据）

本节核对的是 2026-08-19 的工作树（`package.json` 为 `0.50.0`，HEAD
`a7950f3b4dc88ef3b9062caf4eb1f3ee6111bb7e`）。当前实现已经有一个可靠的最小
基础：

- `modelPools.<class>` 是**有序、非空、去重的字符串候选数组**；用户池与项目池
  按类整体替换。[`model-routing.ts`](../src/shared/model-routing.ts) 中只有名称和
  字符串候选，没有每候选能力、区域、凭据或健康元数据。
- 启动时把类解析为具体候选并冻结，记录类名、来源和 pool digest；这使恢复不会随
  设置漂移而改变候选集。[`model-fallback.ts`](../src/runs/shared/model-fallback.ts)
  与 [models.md](models.md#named-model-classes-and-same-class-failover) 已明确该行为。
- 同一类按数组顺序尝试；单候选至多一次。现有分类允许 transient、
  candidate-unavailable 和 failure-domain 触发切换；context、policy、tool、control
  和 unknown 不切换。若已知有外部/未知副作用，则阻止自动切换。
  [`model-fallback.ts`](../src/runs/shared/model-fallback.ts) 是该规则的实现来源。
- 当前 `failure-domain` 只由 `provider/id` 中的 provider 段推导。因此同 provider
  的不同区域、端点或凭据会被视为同一故障域，且无法表达反过来的共享上游依赖。
  这是一项实现限制，不是任何模型能力判断。

因此本建议不是要求重做现有安全边界：应保留候选冻结、去重、模型 scope、一次一候选
和“副作用未知则不自动重跑”的现有约束。

## 官方/社区实践对照

| 一手来源 | 已证实的机制 | 可复用的结论 | 不应直接照搬的部分 |
| --- | --- | --- | --- |
| [LiteLLM Router](https://docs.litellm.ai/docs/routing) | 相同 `model_name` 是逻辑组；组内可有多个 deployment、weight、RPM/TPM 和区域。`enable_weighted_failover` 在 retryable failure 后排除刚失败的 deployment，并在同组重选；全部候选用尽才跨组。 | 把类和实际候选分离；同级重选使用请求级排除集，避免立即选回失败端点。 | 该项仅在 LiteLLM async + `simple-shuffle` 路径生效，且有其自己的 `max_fallbacks`；不能把它当作 Pi 已有行为。 |
| [LiteLLM Reliability / Fallbacks](https://docs.litellm.ai/docs/proxy/reliability) 和 [Health-check routing](https://docs.litellm.ai/docs/proxy/health_check_routing) | 常规、内容策略和 context-window fallback 是不同配置；cooldown/健康检查按 deployment 和错误类型计数，可共享状态。 | 错误类别必须决定路由动作；健康/熔断的粒度应是候选部署，而非整个 `modelClass`。 | LiteLLM 还说明所有候选不健康时会绕过健康过滤继续尝试；Pi 不应未经产品决定就采用该安全阀。 |
| [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) 与 [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) | provider fallback 与优先级 model fallback 是两层；默认可备用 provider。`require_parameters` 可排除不支持全部请求参数的 endpoint，另有数据收集/ZDR 与特定区域 endpoint 约束。 | 在选择前做能力和政策过滤；“可调用”不等于“可用于带工具、JSON、数据边界或区域要求的任务”。 | OpenRouter 的默认模型 fallback 可由任何错误触发（包括 moderation/context）；Pi 的 agent 级重跑副作用更大，应继续采用更窄的错误规则。 |
| [AWS Bedrock Intelligent Prompt Routing](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-routing.html) | 单一 endpoint 在同一模型家族内按提示预测质量，并依质量/成本选择；配置项有 fallback baseline 和 quality-difference 阈值，响应披露最终模型。 | “成本、延迟、质量”是独立目标，不能把 `smart` 当作唯一的质量/成本坐标；自动质量路由需记录最终 served model。 | 文档明确只针对英语优化，且不能按应用特有表现调整；不要假设通用质量预测适合 coding subagent 或所有语言。 |
| [Vertex AI GenerationConfig RoutingConfig](https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/GenerationConfig)（等价于题目所称的官方自动路由方案） | `autoMode` 由预训练路由模型和客户偏好决定，偏好为 `PRIORITIZE_QUALITY`、`BALANCED`、`PRIORITIZE_COST`；也可 `manualMode` 固定模型。 | 将**路由目标**（quality/cost/balanced）与**候选资格**分开建模；不应把两者混进类名。 | 这是 Google API 的 provider 内模型选择；它不定义跨 provider 故障域、agent 工具副作用或 Pi 的恢复语义。官方 [Python API 页面](https://docs.cloud.google.com/python/docs/reference/vertexai/latest/vertexai.preview.generative_models.GenerationConfig.RoutingConfig) 在 2026-05-30 仍将旧 `RoutingConfig` 标为 deprecated、建议转用 `ModelConfig`，采用时必须核对所用 SDK/API 版本。 |
| [Cloudflare AI Gateway Dynamic Routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/) 与 [JSON configuration](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/) | 命名且版本化的路由图可按请求 metadata 条件、百分比、rate/budget limit 选择模型；model node 有 timeout/retries，fallback 只在全部重试或超时后走。成功边界是“已成功开始 streaming”。 | 路由配置应可版本化、可回滚；配额/预算是路由条件，不是失败后无限重试的理由；首个流式输出是透明切换边界。 | Cloudflare Dynamic Routing 在文档中标为 Beta（页面 2026-08-07 更新），不能作为稳定 API 契约的唯一依据。 |
| [Cloudflare fallback response metadata](https://developers.cloudflare.com/ai-gateway/configuration/fallbacks/) 与 [dynamic-route response metadata](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/) | 失败/超时触发 fallback，`cf-aig-step` 表明最终成功的是第几步；动态路由还返回实际 model/provider header。 | 每次运行都应保存 requested class、候选/步骤、最终模型和切换原因。 | 这些 header 是 Cloudflare 专有；Pi 应记录提供商无关的 attempt 事件，不复制 header 名。 |

## 补充证据：质量档位、任务分类和角色分配不是同一层

| 一手来源 | 已证实的机制 | 对 `modelClass` 问题的结论 |
| --- | --- | --- |
| [OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router) | 这是**仅限 coding** 的路由器：`min_coding_score` 映射到 low/medium/high 的 Artificial Analysis coding-percentile band（`<0.33`、`0.33–<0.66`、`>=0.66`）。它在所选档位内按价格（或 `:nitro` 的 p50 吞吐）选主候选和最多两个同档 fallback；fallback 只处理 transient/provider rate-limit。模型与 provider 可按 session 固定，以维持上下文一致性和 prompt cache。 | 质量档不是禁忌，但必须绑定一个可说明的**单领域测量轴**、候选 shortlist、选择法和漂移说明。它不能替代 `tools`、structured output、区域/数据政策、或 agent 副作用合同；Pareto 自己也声明只适合 coding，且百分位会随候选集更新而漂移。 |
| [GitHub Copilot Auto model selection](https://docs.github.com/en/copilot/concepts/models/auto-model-selection) | task-optimization 把实时 health/availability 和 task complexity 结合；先受计划与管理员、数据驻留/FedRAMP 等政策过滤。路由仅发生在自然 cache boundary，官方说明 mid-session switch 会增加成本而没有相称质量提升，并显示实际 served model。 | 路由器应把“能否使用”置于质量优化之前，并把**连续会话/cache**视为强约束。Pi 已冻结 launch pool；不要在长 agent turn 内为追求更高 `smart` 档悄悄更换模型。 |
| [Cursor Router 发布说明](https://cursor.com/blog/router) | 其分类器综合 query、context、task complexity 和 domain：简单任务偏向价格效率，UI 更新偏向“taste”，复杂长周期任务偏向 frontier reasoning；`Intelligence`、`Balance`、`Cost` 是用户选择的成本—智能 Pareto 优化模式。 | Cursor 把**任务路由 taxonomy**与**优化偏好**分开，正是 Pi 应采用的形状：`recon`/`execution`/`reasoning`/`judgment` 回答“此任务需要什么”，而 `cost`/`balanced`/`quality` 回答“在合格候选间如何取舍”。Cursor 的具体模型分类与收益是其自有线上数据，不可迁移为 Pi 的质量结论。 |
| [Continue model roles](https://docs.continue.dev/customize/model-roles/00-intro) 与 [Aider architect/editor mode](https://aider.chat/docs/usage/modes.html) | Continue 把 chat、autocomplete、edit、apply、embed、rerank 分配为显式角色。Aider 可以把解决方案设计交给 architect model、把具体文件编辑交给 editor model；角色可相同或不同。 | 成熟工具通常按**操作角色/输出责任**分配模型，而不是只设全局“聪明度”。`modelClass` 应服务 agent 的工作合同；不要把 agent 名本身、模型名和质量档绑定为同一概念。 |
| Oh My Pi（外部上游源码，补充而非本机事实） | `modelRoles` 映射角色到模型，内建 `smol`、`slow`、`vision`、`plan`、`designer`、`tiny`、`task`、`advisor` 等；其 fallback chain 可按角色、模型精确选择器或 `provider/*` 设置。 | 角色分配与故障切换可以并存，但角色不是质量档：例如 `vision` 表示能力，`advisor` 表示职责，`smol`/`slow` 才近似资源/能力偏好。见 `can1357/oh-my-pi@565d53515b54df32fada2564d1fe9caf1a17b738:docs/settings.md:L355-L377` 和 `can1357/oh-my-pi@565d53515b54df32fada2564d1fe9caf1a17b738:docs/settings.md:L468-L479`；该项目最新 release 为 v17.3.7（2026-08-18）。 |

这里的 Oh My Pi 是公开上游的 pinned-SHA 源码证据；本机此前未发现可读取的 Oh My Pi
工作树，故它不代表本机配置或安装状态。

## 已验证的模型族示例：候选准入证据，而非 taxonomy

以下将公开官方资料与本机 `models.json`、`settings.static.json` 和 `/home/z/fact/cliproxy`
的配置事实结合。它们足以给出**暂定候选顺序**，但不替代针对 agent prompt、工具链和
真实工作负载的本机 eval；“配置已登记”也不等于本次调研重新完成了一次 live probe。

- [OpenAI GPT-5.6 官方模型指南](https://developers.openai.com/api/docs/guides/latest-model) 与
  [GPT-5.6 发布说明](https://openai.com/index/gpt-5-6/)
  将 `gpt-5.6-sol` 定位为 frontier capability、`gpt-5.6-terra` 定位为 intelligence/cost
  balance、`gpt-5.6-luna` 定位为高吞吐/成本敏感工作负载，并要求独立设置
  `reasoning.effort`。这支持把能力档位和思考预算作为**候选的属性/优化偏好**，而不是
  把 `reasoning` 类硬编码为某一模型；官方建议以代表性任务比较 effort，而非从名称推断。
- [Anthropic Claude Fable 5 官方说明](https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5)
  将其定位为 demanding reasoning 与 long-horizon agentic work，并同时说明安全 classifier
  refusal、fallback 处理以及 30-day retention/ZDR 不可用。这个例子直接说明：即使候选
  符合 `reasoning` 或 `judgment` 的能力目标，也可能被 data-policy 或 refusal contract
  排除，不能只因“聪明”就放进 pool。它**不在当前本机 registry**，所以不是下表的当前
  候选；将来加入前仍需同时完成 privacy/refusal/兼容性验证。
- [OpenAI GPT-5.3-Codex-Spark 发布说明](https://openai.com/index/introducing-gpt-5-3-codex-spark/)
  将其定义为 real-time coding 的小型、超低延迟模型：128k、text-only，默认工作方式是
  最小目标编辑且不会自动跑测试；发布时仍是 research preview，容量不足时可排队/限流。
  本机 registry 已登记 `cliproxy/gpt-5.3-codex-spark`，而 `/home/z/fact/cliproxy` 也列为
  支持模型。因此它适合一个明确的 `realtime-code` 合同（交互式小改、快速反馈），而不应
  被放进要求图像、超过 128k context 或默认完整验证的通用 `recon` pool。
- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 和
  [V4 发布说明](https://api-docs.deepseek.com/news/news260424/) 确认 `deepseek-v4-flash`
  / `deepseek-v4-pro` 均支持 1M context、thinking/non-thinking、JSON、tool calls、
  Responses/Anthropic APIs；官方将 Flash 描述为更快/经济、简单 agent task 与 Pro 接近，
  将 Pro 描述为增强 agentic coding/reasoning。二者均已在本机 `cliproxy` registry 登记；
  facts 还记录 DeepSeek 两模型的 `/v1/models` 和 chat/responses 调用已经验证。但本机
  `models.json` 标注 DeepSeek transport 为 `openai-completions`、不支持 developer role，
  并要求保留 reasoning content；这些是更强的候选兼容约束。

### 当前本机可配置候选的暂定顺序（不改配置）

本表是下一个小型 eval 的起点，而不是质量承诺。具体模型字符串来自当前
`~/.pi/agent/models.json`；当前 stable profile 的既有 `fast`/`medium`/`smart` 只列出其中
一部分。GitHub 的[官方模型任务比较](https://docs.github.com/en/copilot/reference/ai-models/model-comparison)
也把 Luna 归于快速简单任务、Terra 归于日常 agent/coding、Sol 和 GPT-5.5 归于深推理/调试；
这与下列**任务合同**排序相符，但不是对本机 gateway 质量的背书。

| 建议任务合同（建议类名） | 暂定候选顺序 | 为什么这个顺序可被公开/本机事实支持 | 必须先验证的条件 |
| --- | --- | --- | --- |
| 只读侦察、检索、机械总结（`recon`） | `cliproxy/deepseek-v4-flash:off` → `cliproxy/gpt-5.6-luna:off` | 保留当前 `fast` 顺序：DeepSeek 将 Flash 定位为 fast/economical，Luna 是 OpenAI 的高吞吐/成本敏感 tier。 | `:off` 的实际 transport 行为、工具格式与两者在真实检索 prompt 上的延迟/成功率。 |
| 小而即时的代码改动（`realtime-code`） | `cliproxy/gpt-5.3-codex-spark` → `cliproxy/deepseek-v4-flash:off` → `cliproxy/gpt-5.6-luna:off` | Spark 的官方定位恰为低延迟 real-time coding；后两者提供当前已登记的快/经济候选。 | Spark research-preview 的访问/队列；128k/text-only 限制；是否显式要求跑测试，避免其轻量默认行为漏掉验证。 |
| 目标清晰的常规实现（`execution`） | `cliproxy/gpt-5.6-terra:medium` → `cliproxy/deepseek-v4-pro:high` → `cliproxy/gpt-5.5:high` | Terra 是 OpenAI 的 balanced everyday tier；V4 Pro 官方强调 agentic/coding/reasoning，GPT-5.5 是当前本机已有的深推理备用。 | DeepSeek 不支持 developer role、需要 reasoning-content 的多轮/工具兼容；每个候选对本项目 edit/test harness 的通过率。 |
| 有明确验收条件的困难调试、复杂审查（`reasoning`） | `cliproxy/gpt-5.6-sol:high` → `cliproxy/gpt-5.5:high` → `cliproxy/deepseek-v4-pro:high` | Sol 是 GPT-5.6 的旗舰/最高推理 ceiling；GitHub 同时把 Sol 与 GPT-5.5 指向 deep reasoning/debugging，Pro 是有官方 agentic/reasoning 声明的第三候选。 | 高 effort 的成本/时延预算、工具副作用后续跑语义，以及 Pro 与 Pi transcript compatibility。 |
| 模糊需求、设计/UX/权衡建议（`judgment`） | `cliproxy/gpt-5.6-sol:medium` → `cliproxy/gpt-5.6-terra:medium` | OpenAI 将 Sol 说明为有更强 design judgment，Terra 为 everyday balanced tier；当前 registry 两者均支持 image input。 | 用人工 rubric 评测“澄清问题质量、约束遵守、可执行性”；若将来加入 Fable，先检查 30-day retention 与 refusal/fallback 合同。 |

**故障域限制：** 表中所有当前候选都经 `cliproxy`（`127.0.0.1:8317`）进入。因此它们可能
在上游模型/提供方限流或不可用时提供候选差异，但共享 gateway 进程、网络入口、认证和
运行时这一单一故障域；这不是独立高可用 fallback。跨 provider 的真正隔离必须增加一个
不经该 gateway 的、满足同一能力/数据政策的候选，并以显式 `faultDomain` 标注。

## 对 `fast` / `medium` / `smart` 的批判

这三个名称可以作为兼容层的短名，但不能成为唯一 taxonomy：

1. **它们混合了互不等价的维度。** `fast` 可指低 TTFT、高吞吐、低成本、低思考
   设置，甚至低队列时间；`smart` 可指推理、代码、工具调用、长上下文或人类意图判断。
   Bedrock 和 Vertex 的官方接口至少把质量与成本分开，而 OpenRouter 还把参数支持、
   数据策略和 endpoint/区域分开。
2. **`medium` 没有可审计含义。** 它很容易退化成“默认池”。一旦任务要求结构化输出、
   图像、长上下文、工具调用或特定数据边界，就无法仅由中档标签判断每个候选是否合格。
3. **三档暗示可全序比较。** 不同候选可能在一个任务上更快、在另一个任务上更可靠；
   同一 provider 的不同凭据/区域可能共享故障，也可能独立。不能从名字推出可安全
   fallback 的替代关系。
4. **它们不表达操作边界。** 一个会执行外部写入的 agent 与只读侦察 agent 的 fallback
   风险不同。当前实现已有 effect 分类保护，taxonomy 应显式保留该区分，而不因
   `smart` 之类的标签放宽它。
5. **受限质量档不能外推为通用类别。** Pareto 的 low/medium/high 是 coding percentile
   threshold，候选集合和百分位会随上游 benchmark/candidate catalog 漂移；它提供的是
   “在已经符合 coding 合同的候选中取最低质量下限”，不是 `modelClass` 的通用定义。

上述批判针对抽象和当前字符串池的表达力，**不是**对任何具体候选模型的质量评价。

## 推荐 taxonomy：类是任务契约，约束和目标是正交字段

### 1. 先采用四个核心逻辑类，按需增加一个实时编辑类

类名只是稳定 API；部署者可将其映射到自己的模型，代码不应内置具体 provider/model：

| 推荐类 | 任务契约 | 可作为当前名称的迁移关系 |
| --- | --- | --- |
| `recon` | 只读侦察、检索、枚举、机械总结；优化低等待/成本，允许较小上下文。 | `fast` 的首选后继 |
| `execution` | 目标清晰的常规实现、局部代码审查、可验证的多文件任务；要求工具调用和基础代码可靠性。 | `medium` 的首选后继 |
| `reasoning` | 已有明确目标/验收条件的困难分析、复杂调试或高风险审查；优化质量，但不把开放式产品判断混入其中。 | `smart` 的首选后继 |
| `judgment` | 需求仍模糊、设计/UX/写作或权衡本身是任务；默认 fresh context，并将结论作为建议而非自动写入。 | 当前文档所称 “taste and intent” 的显式替代 |

只有实际存在“有界、交互式的小代码改动”工作流时，再增加可选的 `realtime-code`：它优先
低 TTFT/高吞吐，但任务合同必须显式说明是否需要测试。不要为了安置 Spark 而预建一个
没有 agent 消费者的类。

当前 builtin 的保守映射建议是：`scout → recon`、`worker → execution`、
`reviewer → execution`、`oracle → reasoning`。高风险或发布前 review 再按次提升为
`reasoning`；`judgment` 只给专门的 planner/shaper/UX agent。这样可避免普通 reviewer
长期占用最高推理池，也不把“审查职责”误写成固定的模型能力等级。

这不是固定的全球标准。`modelClass` 解析已经允许 kebab-case 自定义名称，故应保留
`fast`、`medium`、`smart` 一到两个发布周期作为兼容别名（分别指向上述配置池），
而不是把它们移除或赋予隐式跨类 fallback。

### 2. 将下面三类信息从类名中拆出

- **required capabilities（硬过滤）**：最小 context、tools、structured output、vision、
  streaming、thinking/推理模式、所需协议/参数。不能满足就不进入候选集。
- **policy / placement（硬过滤）**：数据保留/零保留、区域、允许 provider、凭据槽位、
  模型 scope、预算上限。OpenRouter 的 `require_parameters` 与数据策略过滤是此顺序的
  直接先例。
- **routing objective（选择目标）**：在合格候选之间选择 `latency`、`cost`、`balanced`、
  `quality` 或固定 priority。它类似 Vertex 的 quality/cost/balanced 偏好，不应改变
  任务契约本身。

在当前配置格式仍是 `string[]` 时，第一步只需在 agent/任务合同中声明这些要求、在
preflight 校验可用候选是否覆盖；不要先发明一套未经验证的 per-model 打分。后续若需要
选择元数据，再把候选升级为具名对象（例如 `candidateId`、`model`、`faultDomain`、
`capabilities`、`policyTags`、`priority/weight`），并保留字符串数组的兼容解析。

## fallback 与故障域约束

以下为本项目设计推论；其中安全边界与上表官方事实一致，但数值、字段名和默认值需要
在实现前另行确定。

1. **选择顺序。** `modelClass` → 能力/政策过滤 → 排除本请求已失败及 cooldown 的候选
   → 同类候选 → 仅在显式 `crossClassFallback` 时跨类。候选池为空应报告
   capability/policy 配置错误，不应悄悄降级。
2. **同类切换。** 每个候选最多一次；同一请求持有 exclusion set。选 priority 还是
   weight 必须二选一并写入类的合同，不能让“数组顺序”同时承担优先级、质量与健康含义。
3. **故障域粒度。** 至少区分 `provider + endpoint/region + credential-slot`；只有
   `failure-domain` 错误才跳过同域候选。401/403/账单/配额不能靠同一凭据槽位重试，
   但可以由明确允许的独立凭据/供应商候选接手。当前按 provider 的粗粒度规则是安全的
   下限，却会牺牲同 provider 的独立区域恢复能力。
4. **错误类别。** 连接错误、408/409/429、5xx、明确的 provider overload/unavailable
   且尚未产生可见输出/副作用时，才可同类切换。请求格式/不支持参数先修配置；context
   只走显式更大窗口路径；policy 拒绝不用于绕过安全规则；取消、deadline、预算耗尽和
   unknown 默认不重试。
5. **流式与副作用。** 首个流 token 或首个 tool-call delta 后，禁止透明切换；外部/未知
   副作用后禁止重跑整个 agent turn。要恢复，需有持久化的 tool call id、幂等键和回执
   查询。Cloudflare 将“成功开始 streaming”视作成功分支，正说明切换边界不能设在完整
   响应结束以后。
6. **健康。** 未来若加 circuit breaker，应按 `candidateId/faultDomain` 而不是类名维护，
   记录最后错误、截止时间和 half-open probe。429 与 401 不应同等冷却；LiteLLM 的
   health-check 文档也分别对待 transient 和 hard failure。没有共享运行拓扑/指标前，
   不要预设 Redis 或具体阈值。
7. **可观测性。** 每个 attempt 至少记录 `runId`、`requestedClass`、pool digest、候选
   ID/model、fault domain、过滤原因、错误类别、是否已开始流、effect class、下一步和
   最终 served model。池冻结已有前半部分，新增字段应以此为基础。

## 渐进落地建议（不改变当前代码的本报告结论）

1. **先稳住已实现的契约。** 保留现有有序 pool、冻结 digest、严格 model scope、一次
   一候选、effect guard 与不对 context/policy/unknown 盲切换的行为；补齐文档中
   `fast`/`medium`/`smart` 不是质量排名的说明。
2. **引入别名而不破坏用户配置。** 在示例和 builtin role 文档优先使用
   `recon`/`execution`/`reasoning`/`judgment`；保留旧三名可配置。只有存在专用消费者时
   才增加 `realtime-code`。只在用户明确声明 `crossClassFallback` 时才允许旧类之间迁移。
3. **在 preflight 加合同校验。** 先从 agent/任务级 `requiredCapabilities`、`policyTags`
   和 `routingObjective` 开始；若本机 registry 无法证明某能力，按“未知”拒绝需要该
   能力的候选，而不是猜测。此步不需要健康评分或自动质量预测。
4. **再细化候选和故障域。** 在已有 attempt artifact 上加入稳定 candidate ID 与显式
   fault-domain 标签；为同 provider 的独立区域/凭据写针对性测试。没有证据时宁可声明
   共享故障域。
5. **最后才评估动态选择。** 有真实运行指标和可重复 eval 后，才考虑同类权重、健康
   cooldown、latency/cost policy 或渐进 rollout。借鉴 Bedrock/Vertex 的目标维度，不把
   供应商的质量预测算法嵌入 Pi。每一步应测：候选过滤、错误分类、已流/副作用阻断、
   frozen resume、可观测 attempt 序列与 model-scope 回归。

## 版本、检索充分性与风险

- LiteLLM 和 OpenRouter 文档于 2026-08-19 读取；二者更新频繁，采用特定字段前应与
  实际锁定版本/网关配置复核。LiteLLM 的组内 weighted failover 还有 async-only 限制。
- Bedrock 文档检索时标有 preview/default-router 限制；其英语优化和非应用特化限制适合
  作为“不要过度承诺自动质量路由”的证据，不能据此推断其它平台行为。
- Google 证据来自官方 REST `v1beta1` 参考和官方客户端参考；后者在 2026-05-30
  将旧 `RoutingConfig` 标为 deprecated，而 REST 页面仍将 `modelConfig` 标为 deprecated
  并指向 `routing_config`。两份官方页面的迁移措辞相冲突，故本文只采用它们共同确认的
  auto/manual 与 quality/cost/balanced 语义；具体字段应以锁定 SDK/API 的最新参考为准。
- Cloudflare Dynamic Routing 页面标为 Beta；仅将其用作版本化路由图、流开始边界和
  观测字段的参考，不把 Beta API 当作依赖选择建议。
- Pareto、Copilot Auto 与 Cursor Router 在 2026-08-19 获取。Pareto 的 coding score
  依赖其所引用的第三方 benchmark percentile；Cursor 的成本/满意度数字来自 Cursor
  自己的线上 A/B 说明。两者都只支持“分离任务分类和优化目标”的设计推论，不构成
  `pi-subagents` 候选质量或成本的证据。
- OpenAI GPT-5.6 与 Anthropic Fable 5 的例子来自当日读取的官方模型文档；模型可用性、
  价格、数据保留、safety fallback 及模型 ID 均可能按账户、region 和 API 版本变化，
  因此没有直接写入默认 pool。
- 本机 `models.json` 目前把 GPT-5.6 Sol/Terra/Luna 的 context window 登记为 272k，
  而 OpenAI 当前官方模型页列为 1.05M；路由 preflight 应以较小的本机已登记值为准，
  直到 cliproxy 的实际 transport/probe 证实更大窗口可用。该差异正是 capability contract
  不能从供应商模型名称推断的实例。
- 所有表内顺序都受 `cliproxy` 这个共同 ingress/auth/runtime 约束。它们可用于模型级
  降级实验，但在引入独立入口前不能通过 model fallback 获得 gateway 级可用性保证。
- 已检查 `/home/z` 下的项目与常见命名目录，未找到可读取的本地 Oh My Pi 仓库；因此
  本文没有声称存在或复用本机的角色路由实现。公开上游 Oh My Pi 只以 pinned-SHA
  源码作为补充比较；`/home/z/.trash` 中的历史评估文档不是可验证的源码仓库，未作为证据。
- 检索充分性：已覆盖题目要求的 LiteLLM、OpenRouter、AWS Bedrock、Google Vertex 等价
  自动路由方案，以及 Cloudflare，并补充 OpenRouter Pareto、GitHub Copilot Auto、Cursor、
  Continue、Aider、OpenAI 和 Anthropic。所有重要外部结论均有官方链接；唯一 OSS
  源码引用为 pinned-SHA 的 Oh My Pi。未使用教程、博客转述或未固定的第三方代码。

## 可复用摘要

把 `modelClass` 视为**可审计的任务契约**而非“模型聪明度”。先过滤能力、政策和故障域，
再在同类候选中一次性切换；跨类必须显式；流式首输出和外部副作用之后不透明 failover。
保留 `fast`/`medium`/`smart` 兼容性，但逐步迁向 `recon`、`execution`、`reasoning`、
`judgment`；仅在有明确消费者时增加 `realtime-code`。同时把能力、政策、路由目标和
候选健康从类名中拆开。
