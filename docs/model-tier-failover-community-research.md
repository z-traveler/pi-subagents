# `fast` / `medium` / `smart` 模型层级与同级故障切换：社区/上游调研

> 调研日期：2026-08-18（Asia/Shanghai）。仅使用官方文档、官方源码和官方发布信息。
>
> 结论中的“社区事实”均可追溯到下方链接；“设计推断”是将这些事实移植到
> `pi-subagents` 时的建议，**不是**任何上游已经承诺的 API 或行为。

## 结论摘要

1. 将 `fast`、`medium`、`smart` 设计为**稳定的逻辑模型组/路由别名**，而不是某个
   供应商模型的同义词。LiteLLM 以同一 `model_name` 把多个部署组成可负载均衡的
   模型组；OpenRouter 也将“请求的模型”和实际服务它的 provider/model 明确区分。
   这支持“任务选择层级，运行时选择候选”的抽象，但不证明三个名称本身是行业标准。
2. 同级自动切换应先排除刚失败的候选，再在未尝试的同级候选中按显式顺序或权重
   轮换；同级耗尽后才执行显式的跨级 fallback。LiteLLM 的 `enable_weighted_failover`
   正是这一策略：失败部署加入本请求的排除集，按原权重重选同一模型组，全部尝试后
   才跨组；其同步调用路径不具备该行为。
3. 重试和 fallback 必须由**归一化错误分类 + 调用阶段**驱动，而不是“任何异常再试”。
   网络错误、408、409、429、5xx 可重试；凭据/权限、请求结构错误和不支持参数通常
   不应同请求重试。上下文超限和内容策略拒绝是单独的、显式配置的 fallback 类别。
4. 只要输出已开始流式交付，就不能“无缝”换模型；只要工具可能已产生副作用，就不能
   仅因模型/网络失败重跑整个 agent turn。需要以持久化的工具调用 ID、幂等键或已完成
   回执为边界恢复。
5. 熔断/冷却的健康单元应是**候选部署/凭据/区域**，不应把整个 `fast` 等层级拉黑。
   LiteLLM 将 cooldown 作用于单个部署，并有可选的后台健康检查；这是最直接的上游
   先例。

## 研究边界与版本语境

- 这是“已选技术如何做”的资料调研，不是选择 LLM 网关或为 `pi-subagents` 决定具体
  模型的建议。
- LiteLLM 官方文档仓库检查在
  [`2fd55abb…`](https://github.com/BerriAI/litellm-docs/tree/2fd55abbddc1f61c1a888c65bb10e48c7f850f27)
  （2026-08-18）；PyPI/GitHub 最新发布为
  [`v1.97.0`，2026-08-16](https://github.com/BerriAI/litellm/releases/tag/v1.97.0)。文档
  `main` 比该 release 晚两天，因此新字段在采用前应再次核验对应安装版本。
- LangGraph 官方最新 release 为
  [`1.2.11`，2026-08-11](https://github.com/langchain-ai/langgraph/releases/tag/1.2.11)。
  其 fault-tolerance 文档注明：每节点 timeout/error handler 需要 `>=1.2`，且当时仍有
  alpha 限制；重试策略本身同时适用于 Python/TypeScript。
- Vercel AI SDK 官方仓库检查在
  [`404a9d9b…`](https://github.com/vercel/ai/tree/404a9d9b6b0a39e7ee544a1609a1ec104d08d9da)
  （2026-08-18）；npm `ai` 最新为 `7.0.66`。其仓库 `main` 示例同样不应被误当成所有
  已安装版本的兼容性保证。
- OpenAI Node SDK 最新发布为
  [`v7.5.0`，2026-08-17](https://github.com/openai/openai-node/releases/tag/v7.5.0)。
  OpenAI 的重试结论下面以该官方 SDK README 为准。

## 来源对照表（社区事实）

| 来源（均为一手） | 模型池/别名 | 重试、同级轮换与冷却 | 副作用/可观测性 | 对本题的可移植事实 |
| --- | --- | --- | --- | --- |
| [LiteLLM Router](https://github.com/BerriAI/litellm-docs/blob/2fd55abbddc1f61c1a888c65bb10e48c7f850f27/docs/routing.md) | 相同 `model_name` 是别名/模型组，选择组内多个 deployment；文档推荐生产环境使用 `simple-shuffle`。 | 有 weight、order 和 `enable_weighted_failover`；后者在同组排除已失败 deployment，耗尽才跨组。 | 可查询 healthy deployments；生产多实例可用 Redis 共享 cooldown/用量状态。 | “tier → 候选池”，而不是“tier → 单一模型”；请求级 exclusion 防止立即挑回刚失败的端点。 |
| [LiteLLM Reliability / Fallbacks](https://github.com/BerriAI/litellm-docs/blob/2fd55abbddc1f61c1a888c65bb10e48c7f850f27/docs/proxy/reliability.md) | 普通 fallback 按 `model_name` 有序跨组。 | 每组 `num_retries` 后按 fallback 链继续；普通、内容策略、上下文窗口 fallback 分开。 | 要求在非生产环境触发真实 provider 错误测试 proxy fallback。 | 要把“同级重选”“跨级”“上下文扩大”“内容策略替代”做成不同规则，不能合成一个无条件 fallback。 |
| [LiteLLM Health-check routing](https://github.com/BerriAI/litellm-docs/blob/2fd55abbddc1f61c1a888c65bb10e48c7f850f27/docs/proxy/health_check_routing.md) | 健康状态按 deployment 维护。 | 后台检查可主动移出不健康部署；可按错误类型阈值 cooldown，且可把 429/408 视为瞬态健康检查错误。 | 文档列出健康/cooldown 状态和 debug 日志；健康失败与请求失败可共享计数。 | circuit scope 应精确到 endpoint/credential，记录阈值、TTL、最后错误；不要因为一个候选故障禁用整个 tier。 |
| [LiteLLM Routing Groups UI](https://github.com/BerriAI/litellm-docs/blob/2fd55abbddc1f61c1a888c65bb10e48c7f850f27/docs/proxy/ui/routing_groups.md) | 可在 dashboard 管理组与各组策略；一个 model 只能属于一个组。 | 分组仍保留顶层默认策略。 | UI 不必编辑原始配置文件。 | 配置界面应展示 tier 成员和实际策略，并拒绝重名/重叠/空池等歧义配置。 |
| [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) 与 [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks) | 多 provider 的同模型路由与按顺序的模型 fallback 是两层机制；`allow_fallbacks` 默认允许备用 provider。 | 默认跨顶级 provider 负载均衡；模型 fallback 按优先级。 | 请求可限制参数支持、数据收集、ZDR 等路由约束。 | 候选池必须先按能力、数据处理、区域和工具支持过滤，再轮换；“可用”不等于“允许给这个任务用”。 |
| [OpenRouter Errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) 与 [Router Metadata](https://openrouter.ai/docs/guides/features/router-metadata) | 返回实际路由上下文。 | 429/503 可携带 `Retry-After`；`provider_unavailable` 可触发 provider fallback。流开始后不能静默切换。 | opt-in metadata 给出 requested、实际 attempt、每次 endpoint/status、策略和 pipeline。 | 尝试日志必须包含 `requestedTier`、候选、attempt、错误、回退原因和最终模型；stream 首 token 是 failover 边界。 |
| [OpenAI Node SDK — Retries](https://github.com/openai/openai-node#retries) | 不涉及池。 | 默认短指数退避重试两次：连接、408、409、429、`>=500`；可按 client/request 设 `maxRetries`。 | 错误带 `request_id`；请求选项支持 `idempotencyKey`（见 [类型定义](https://github.com/openai/openai-node/blob/main/src/internal/request-options.ts)）。 | 默认分类可作为保守起点，但外层路由器应关闭/计入 SDK 内部重试，避免两个退避器叠加后失控。 |
| [LangGraph Fault Tolerance](https://docs.langchain.com/oss/python/langgraph/fault-tolerance) | 不涉及池。 | `RetryPolicy` 有 `retry_on`、次数、初始间隔、倍率、最大间隔、jitter；默认 HTTP 仅重试 5xx，可在第二次尝试切到 fallback。 | timeout 后清理本次 attempt 的 buffered writes；重试耗尽后才执行 handler/补偿。 | 将“选择下一个同级候选”放在受限 retry policy 后，而不是 catch-all；每轮要有 timeout、jitter 和总 deadline。 |
| [LangGraph Functional API — Idempotency](https://docs.langchain.com/oss/python/langgraph/functional-api) 与 [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 不涉及池。 | 任务结果 checkpoint；重放时可能再次执行未成功完成的 task。 | 官方明确要求把 API/副作用包进 task，并用 idempotency key 或先查已有结果避免重复；checkpoint 可保存已完成 task 的写入。 | 模型切换/恢复必须从已持久化的工具回执继续；任何“调用外部系统后响应丢失”都标记为 unknown，不可盲重试。 |
| [Vercel AI Gateway provider 官方源码](https://github.com/vercel/ai/blob/404a9d9b6b0a39e7ee544a1609a1ec104d08d9da/content/providers/01-ai-sdk-providers/00-ai-gateway.mdx) | `creator/model-name` 模型 ID 通过一个 gateway interface 使用；支持 custom provider 和 BYOK model mapping。 | Gateway 官方文档说明可配置 provider 选择和备用 provider（[Provider Options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)）。 | 源码文档将 AI Gateway usage observability 放在 Vercel dashboard；官方示例能读取 fallback 后的实际 `modelId` 与 provider iterations（[示例](https://github.com/vercel/ai/blob/404a9d9b6b0a39e7ee544a1609a1ec104d08d9da/examples/ai-functions/src/generate-text/anthropic/server-side-fallback.ts)）。 | UI 应显示逻辑 tier、最终 provider/model、价格/用量归因，而非只显示用户最初选择的 tier。 |

## 可移植原则（面向 `pi-subagents` 的设计推断）

以下是基于上表的建议接口/语义，不是对现有实现的描述。

### 1. 层级是选择契约，候选是运行时部署

建议把逻辑名固定为 `fast` / `medium` / `smart`，每个 tier 是有序候选池。候选至少需有：

- 稳定 `candidateId`，以及 provider、实际模型/部署、区域或凭据槽位；
- 能力约束：上下文窗口、图像/工具/结构化输出/流式、数据保留或区域要求；
- 选择参数：priority 或 weight（两者的组合要有明确语义）；
- 健康键：通常为 deployment + credential/region，而非 tier 名。

任务和 agent 配置只引用 tier；运行记录必须同时保存 tier 与最终候选。这借鉴的是
LiteLLM 的别名/部署分离和 OpenRouter 的 requested-vs-served metadata，**并不表示**不同
厂商的“快/中/聪明”质量可天然互换。对工具调用、JSON schema、上下文或推理能力有硬性
要求的任务，应先按能力过滤；池为空时显式报配置/能力错误，不能降到不兼容候选。

### 2. 一个保守的故障状态机

```text
选 tier → 过滤能力/策略/非冷却候选 → 选候选
  ├─ 请求尚未承诺、发生可重试瞬态错误
  │    → 记 attempt + 排除该候选 → 同 tier 的下一个未尝试候选
  ├─ 同 tier 耗尽
  │    → 只按显式 cross-tier policy（否则失败）
  ├─ 已向调用方交付首个流 token
  │    → 终止流并报告中途失败；不可透明 failover
  └─ 已发起有副作用工具、结果不确定
       → 不重跑 agent turn；读取工具回执/以幂等键核对，再决定恢复或人工处理
```

建议限制为：每候选一次、每 tier 有小的 attempt 上限、整次 agent run 有 deadline 和预算。
“每候选一次”对应 LiteLLM 的 request-local exclusion；它避免相同坏端点反复被权重随机数
选中。若要先在同一候选 retry，也必须只有在连接尚未建立等低歧义错误时使用，并将 SDK
的内部重试纳入同一 attempt budget。

### 3. 错误分类不是单一的 HTTP 状态表

| 类别 | 建议动作 | 依据与限制 |
| --- | --- | --- |
| 连接失败、408、409、429、5xx、provider overload/unavailable，且未开始流/未执行工具 | 在尊重 `Retry-After`、指数退避+jitter 与总 deadline 下，换下一个同级候选；对 429/503 同时短暂降权或冷却失败候选。 | OpenAI SDK 默认把前述错误列为可重试；OpenRouter 明确给 429/503 的 `Retry-After`。各 provider 的错误含义仍要映射到内部错误码。 |
| 400/422 请求结构、模型不支持参数、无效输入 | 不重试；记录为配置/调用方错误。 | 重发同一 payload 不会修复语义错误。若为模型特定参数不兼容，应在 capability filter 阶段避免。 |
| 401/403、无效 API key、权限/配额/支付失败 | 不重试本候选；通常进入较长冷却/disabled，并报警。若另一个候选是不同凭据且策略允许，可试它。 | 这不是瞬态网络错误；OpenRouter 将凭据、credits、权限分开列出。 |
| 内容策略拒绝 | 默认不在同级盲重试；只走明确的 `contentPolicyFallbacks`，且保留拒绝原因。 | LiteLLM 将其设为独立 fallback 类；OpenRouter 也把 guardrail block 与 provider failure 分开。换模型不应被当作绕过安全策略。 |
| 上下文窗口超限 | 不在同级盲重试；先压缩/截断，或只走已验证具备更大窗口的 `contextWindowFallbacks`。 | LiteLLM 把它设为独立路径。 |
| 用户取消、deadline/budget 耗尽、工具副作用后的未知结果 | 不自动重试。 | 这是控制流或一致性边界，不是 provider 可用性问题。 |

### 4. 冷却、半开恢复与共享范围

建议用候选级 circuit：累计可重试失败达到小阈值时进入带 TTL 的 `cooldown`；429 可立即短冷却，
401/404 可长冷却并提示配置修复。TTL 到期后只允许少量 half-open 探测成功才恢复正常权重。
多进程部署应共享状态，否则每个进程都会继续打同一失效端点。LiteLLM 的实证先例是：
deployment 级 cooldown、可选 Redis 共享状态、可选后台健康检查和按错误类型阈值。

这里的 half-open、具体阈值和 TTL 是**设计推断**：所查来源证明了 deployment 级 cooldown
与健康检查，但没有给出适用于 Pi subagent 的统一数值。不要把 429 与 401 等同处理；LiteLLM
的 health-check 文档甚至允许把 429/408 从健康判定中忽略，以免短暂拥塞造成误熔断。

### 5. 幂等、工具和流式的硬边界

- 在开始模型调用前生成 `runId`、`turnId`、`modelAttemptId`；每次候选选择都记录新 attempt。
- 每个会写外部世界的工具调用应有稳定 `toolCallId` 和可传递的 `idempotencyKey`，并把
  “已提交/回执/结果未知”持久化。恢复时先以该键查询，而不是生成新的写入。
- 模型在请求工具但工具尚未执行前失败，可以换同级模型并重新规划；工具已执行后，后续
  模型只能读取已记录的工具结果。不能让新模型重新发同一写操作。
- 流式的首 token/首 tool-call delta 是透明 failover 的终点。之后只能向用户暴露失败并让
  上层决定是否从 checkpoint 继续。

这些约束直接受 LangGraph 关于 task/re-execution/idempotency 的官方警告和 OpenRouter
“已开始流不能静默切换”的限制支持；把它们应用到 `pi-subagents` 的 attempt 模型属于设计推断。

### 6. 最小但足够的可观测性与配置界面

每个完成或失败 run 应结构化记录：

- `requestedTier`、候选池版本/配置 hash、最终 provider/model/deployment；
- `attemptNo`、前序候选排除集、错误规范码/HTTP 状态、`Retry-After`、退避时间、路由决定；
- `streamStarted`、工具副作用状态、`runId`/上游 request ID、用量/成本/延迟；
- circuit 状态变化（closed/open/half-open）、冷却到期时间和健康检查来源。

这与 OpenRouter opt-in router metadata 的 attempts/pipeline、Vercel Dashboard 的 usage
observability、LiteLLM dashboard 的 routing groups 是同一可审计方向。配置 UI 建议只编辑以下
可验证的声明式数据：tier 成员、能力/策略约束、顺序/权重、同级 attempt 上限、错误类规则、
cross-tier 链和 cooldown 状态；展示最终 served model 与版本。保存前拒绝空 tier、循环 fallback、
相同候选重复、tier 成员重叠语义不清以及能力不兼容。具体 UI 形态、字段名和默认阈值均是
设计推断，尚无上游标准。

## 风险与未知项

1. **质量不是故障语义。** `fast`/`medium`/`smart` 没有跨供应商可验证的统一质量标尺；
   同 tier fallback 可能改变工具调用、输出格式、成本、隐私和推理质量。应把 capability
   contract 和评测结果作为准入条件，而不是只依据模型名称。
2. **嵌套重试风险。** provider SDK、网关和 subagent 运行器可能各自重试。若不统一预算，
   一次逻辑请求会产生多倍调用、等待和费用。要么关闭内层重试，要么读取/配置其上限并让外层
   accounting 知晓。
3. **流与写入的一致性。** 网络超时不等于 provider/工具没有完成；输出已送达后不能透明
   复用。所有副作用必须有可查询回执，无法做到时应禁用自动重试。
4. **健康状态的范围。** 单机内存 cooldown 不能保护多 Pi 进程；共享存储又引入失效、时钟、
   隔离和权限问题。是否需要它取决于实际部署拓扑，当前调研未覆盖本仓库的运行方式。
5. **版本漂移。** LiteLLM 和 Vercel 的关键说明来自 2026-08-18 的官方 `main` 文档/源码；
   合入实现时需要用锁定依赖版本重新核对字段与同步/异步差异。

## 验证证据与可复用结论

本报告逐项读取并交叉核验了：LiteLLM 官方 docs 仓库在固定 commit 的 Router、Fallback、
Health Check 与 UI 文档；OpenRouter 官方 routing/error/metadata 文档；OpenAI 官方 Node SDK
README/类型定义；LangGraph 官方 fault-tolerance、functional API、persistence 文档；以及 Vercel
AI 官方固定 commit 的 Gateway provider 文档与 fallback 示例。上述链接均在 2026-08-18 成功获取；
发布版本与日期见“研究边界与版本语境”。未使用教程、博客转载或未固定的第三方代码作为证据。

可复用的落地准则是：**tier 是稳定逻辑名，候选是带能力约束的部署池；先在同 tier 排除并
轮换，再按显式规则跨 tier；按错误类别和调用阶段决定重试；健康熔断按候选而不是 tier；工具
副作用和流式首输出之后不做透明重试；每一次路由决定都可审计。**

## `pi-subagents` 现状与差距

本仓库并非从零开始：Agent 已支持 `model` + 有序 `fallbackModels`。候选在
[`src/runs/shared/model-fallback.ts`](../src/runs/shared/model-fallback.ts) 中统一解析、规范化和
去重；foreground/background runner 均会依次启动候选，并把 `attemptedModels` 与
`modelAttempts` 写入状态和 artifact。现有 fallback 会在 rate limit、quota/billing、认证、模型
不可用、overload、网络、timeout、502–504、cold start、empty response 等文本模式命中时启动，
而明确的工具失败不会触发模型切换。

当前真正缺少的是：

1. 多个 Agent 不能共同引用一个命名候选池；每个 Agent 都要重复 `model` / `fallbackModels`。
2. 没有 `requestedPool` 或类似字段，观察面只能看到具体候选，不能回答“这是 fast 任务吗”。
3. 没有跨 run 的候选健康状态、cooldown 或 half-open；每个新 run 都会重新从第一个候选开始。
4. 当前错误分类依赖宽泛文本，其中 auth/billing/quota 与瞬态 429/5xx 混在同一 fallback 类；
   它能支持跨凭据/跨 provider 切换，却会在同一故障域中产生无效轮询。
5. fallback 是重新启动整个 child attempt，而不是只替换一次底层 LLM 请求。对已经产生文件、
   shell 或外部副作用的 Agent，这比网关/SDK 层 failover 风险更高。

还存在一层容易被忽略的重试：Pi core 默认开启 agent-turn retry，最多重试 3 次，基础退避为
2 秒（即 2s、4s、8s）；provider/SDK retry 默认是 0。证据见
[`pi-core/packages/coding-agent/docs/settings.md`](../../pi-core/packages/coding-agent/docs/settings.md)。
因此 `pi-subagents` 不应再为每个池成员增加一套“同模型 retry”；它只应在 Pi core 对当前模型
的瞬态重试耗尽后，执行**换模型 failover**。否则 N 个候选会与多层 retry 相乘。

## 推荐的 Pi-specific 方案

### 命名：用 pool，不把 tier 当模型 ID

建议配置键叫 `modelPools`，池名可由用户定义为 `fast` / `medium` / `smart`。`pool` 比 `tier`
更准确：它表达“可互换候选集合”；三个名字表达任务档位，但不暗示运行时会自动从 fast 升级到
smart。不要允许 `model: "fast"` 这种隐式写法，它会与真实/bare 模型 ID 冲突，也会让
`modelScope` 和错误信息失去模型来源。

第一版建议保持最小形状：

```json
{
  "subagents": {
    "modelPools": {
      "fast": [
        "cliproxy/deepseek-v4-flash:off",
        "cliproxy/gpt-5.6-luna:off"
      ],
      "medium": [
        "cliproxy/gpt-5.6-terra:medium"
      ],
      "smart": [
        "cliproxy/gpt-5.6-sol:high",
        "<provider>/<registered-fable-model>:medium"
      ]
    },
    "agentOverrides": {
      "scout": { "modelPool": "fast" },
      "worker": { "modelPool": "medium" },
      "researcher": { "modelPool": "medium" },
      "delegate": { "modelPool": "medium" },
      "reviewer": { "modelPool": "smart" },
      "oracle": { "modelPool": "smart" }
    }
  }
}
```

候选继续使用现有 `provider/model:thinking` 表示法，这样第一版不必把内部候选从 `string[]`
重构为新的对象协议，也能让同池不同模型采用不同 thinking。这里的 medium/smart 成员只是接口
示例，不是完成过质量评测的推荐名单。

本机当前 registry 包含 `deepseek-v4-flash`、`gpt-5.6-luna`、`gpt-5.6-terra`、
`gpt-5.6-sol` 等 cliproxy 模型，但没有 Fable 模型。实际采用 smart pool 前，必须先在
`~/.pi/agent/models.json` 注册并验证准确的 provider/model ID、API 类型、thinking 映射与凭据；
不能把示例占位符直接写入 pool，因为当前 preflight 对未知候选会立即报错。

### 解析语义

`modelPool` 应在 launch preflight 阶段展开为现有的有序模型候选，之后完整复用
`buildModelCandidates`、`modelScope`、foreground/background runner 和 artifact 记录链路。

建议优先级为：

```text
per-run model（显式单模型）
  > Agent frontmatter model / fallbackModels（现有精确配置）
  > Agent modelPool
  > subagents.defaultModelPool
  > subagents.defaultModel
  > parent session model
```

同一配置层若同时声明 `modelPool` 与 `model`/`fallbackModels`，第一版应直接报歧义错误，不做
拼接猜测。显式 per-run model 应绕过池；未来若确有需求，再单独增加 per-run `modelPool`，不要
暗中把显式模型接到某个池的尾部。

池在启动前必须全部展开和校验：空池、重复候选、未知模型、循环引用（如果未来允许池引用）、
`modelScope` 违规都应在任何 child 启动前失败。候选顺序应稳定、可预测；第一版不做随机、权重
或自动升级。

### failover 语义

第一版应保持现有含义：一个 logical child claim/run id，多次 model attempt；当前候选出现可切换
的终止错误后尝试池内下一个候选，不额外消耗 spawn budget。成功即停止；池耗尽即失败；不跨池。

建议同时收紧错误分类，至少分为：

- `transient`：连接、429、overload、502/503/504、可判定的空响应；允许同池切换。
- `candidate-unavailable`：模型 disabled/not found/unsupported；允许切换，但应报告配置问题。
- `failure-domain`：401/403、billing/quota/credit；只有下一候选属于不同 provider/凭据故障域时
  才切换，否则立即失败。
- `task/control`：工具失败、验收失败、用户停止、总 deadline/turn budget；禁止切换。
- `context/policy`：上下文超限、内容策略；第一版禁止隐式切换，留给显式专用策略。

由于当前 Pi 错误主要以文本到达，第一版可以保留 regex 兼容层，但内部输出应先归一化为上述
错误码；后续 provider/host 若暴露结构化状态，应优先使用结构化字段而不是继续扩充正则。

### 失败域与候选选择

同池模型最好跨独立故障域。当前 fast 示例的两个模型都通过 `cliproxy`，所以它们能抵抗
“某个模型不存在/拥塞”，但不能抵抗 cliproxy 本身的网络、认证或账户故障。smart 池若一个候选
走 cliproxy、另一个走独立 Anthropic 凭据，故障隔离才更真实。

第一版仍按数组顺序选择。第二版若运行数据证明持续命中失效首选项造成明显延迟，再加入
**session/process-local、候选级** cooldown：记录规范模型、失败类、`cooldownUntil`，TTL 后做一次
half-open 探测。不要在第一版引入磁盘/跨进程共享状态，也不要熔断整个 fast/medium/smart 池。

### 副作用边界

把 pool 展开复用现有 fallback，不会创造新的副作用问题，但会让该问题更常见。最低要求是把
attempt 元数据补全为：`requestedModelPool`、解析后的候选、最终模型、切换原因、Pi core retry
已耗尽的证据、tool/mutation 是否发生。

对 read-only Agent 可自动切换。对 `worker` 等写 Agent，第二候选会看到同一工作区里第一候选
可能留下的部分修改；其提示应明确为“检查当前状态并继续”，而不是假定任务尚未开始。涉及外部
不可逆工具时，除非工具具备 idempotency key/可查询回执，否则应禁用整个 child 的自动重跑。

## 可立即使用的兼容配置

在 `modelPools` 尚未实现前，现有配置已经能验证 failover 行为，只是会重复：

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": {
        "model": "cliproxy/deepseek-v4-flash",
        "thinking": "off",
        "fallbackModels": ["cliproxy/gpt-5.6-luna:off"]
      },
      "oracle": {
        "model": "cliproxy/gpt-5.6-sol",
        "thinking": "high",
        "fallbackModels": ["<provider>/<registered-fable-model>:medium"]
      }
    }
  }
}
```

先用这一形式做故障注入，可以验证：未知模型 preflight、429/503、模型 unavailable、同 provider
认证失败、跨 provider 认证失败、attempt 记录、foreground/background 一致性，以及写 Agent 在
首次 attempt 已修改工作区后的行为。不要用不存在的 Fable 占位符做正常启动测试。

## 建议的实施分期

1. **V1 — 配置去重。** 新增 `modelPools` / `modelPool`，纯展开到当前候选链；补 preflight、文档、
   status/artifact 字段和 foreground/background 对称测试。不引入权重、跨级、熔断或新 retry。
2. **V1.1 — 结构化失败类。** 收窄 auth/billing/quota 与 transient 的处理，记录 failure domain；
   保持旧 regex 为兼容输入，不改变工具/控制流失败的不切换规则。
3. **V2 — 健康反馈。** 只有实测发现重复首选故障造成显著延迟时，加入进程级候选 cooldown、
   `Retry-After`、half-open 和 fleet 可见状态。
4. **另立议题 — 副作用恢复。** 工具回执、幂等键、checkpoint continuation 属于 agent runtime
   一致性能力，不应被塞进模型池 V1。

按这个分期，V1 的本质是为已经成熟的 `fallbackModels` 增加一个深接口，而不是在
`pi-subagents` 内再造 LiteLLM/OpenRouter。
