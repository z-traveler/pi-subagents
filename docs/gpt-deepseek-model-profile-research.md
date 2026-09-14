# GPT + DeepSeek `fast` / `balanced` / `smart` 模型池调研

> 调研日期：2026-08-19（Asia/Shanghai）。范围仅限 GPT 与 DeepSeek；不包含本机 benchmark，结论复用供应商与成熟 coding-agent 产品已公开的速度/智能定位。模型 ID 以本机已声明的 `cliproxy` 注册表命名为前提，未对 cliproxy 的实际端点、计费、限额或 `reasoning_effort` 转译做 live probe。

## 结论

采用三个**模型能力档**。它们只表达速度与智能在同一 Pareto 前沿上的位置，不表达任务类型：`fast` 偏速度端，`balanced` 取折中点，`smart` 偏智能端。这个分法与 Cursor Router 的 Pareto 目标一致，也与 GitHub Copilot 对 Luna / Terra / Sol 的公开定位直接一致：Luna 偏速度，Terra 偏均衡，Sol 具有 GPT-5.6 家族最高推理上限。[Cursor Router](https://cursor.com/blog/router)；[GitHub Copilot model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison)

直接复制到 Pi 的 `settings.static.json`（或对应项目 `.pi/settings.json`）的 `subagents` 段：

```json
{
  "subagents": {
    "modelPools": {
      "fast": [
        "cliproxy/gpt-5.6-luna:low",
        "cliproxy/deepseek-v4-flash:off"
      ],
      "balanced": [
        "cliproxy/gpt-5.6-terra:medium",
        "cliproxy/deepseek-v4-flash:high"
      ],
      "smart": [
        "cliproxy/gpt-5.6-sol:high",
        "cliproxy/deepseek-v4-pro:high"
      ]
    }
  }
}
```

候选按首选到同档 fallback 排序；没有自动跨档升级。`pi-subagents` 的 model pool 本身就是有序候选数组，且 `modelClass` 可命名为任意 kebab-case 语义名，不限于示例中的 `medium`。[`z-traveler/pi-subagents@a7950f3b4dc88ef3b9062caf4eb1f3ee6111bb7e:docs/models.md:L64-L78`](https://github.com/z-traveler/pi-subagents/blob/a7950f3b4dc88ef3b9062caf4eb1f3ee6111bb7e/docs/models.md#L64-L78)

## 档位与候选顺序

| 档位 | 推荐顺序与 effort | 速度 / 智力依据 |
| --- | --- | --- |
| `fast` | 1. `gpt-5.6-luna:low`  2. `deepseek-v4-flash:off` | 速度优先。Copilot 将 Luna 明确列为较小、较快任务的轻量模型；OpenAI 将 `low` 定位为延迟敏感工作。DeepSeek 将 Flash 定位为更小、更快、更经济；关闭 thinking 进一步偏向低延迟。[Luna 官方定位](https://docs.github.com/en/copilot/reference/ai-models/model-comparison)；[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)；[DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424/) |
| `balanced` | 1. `gpt-5.6-terra:medium`  2. `deepseek-v4-flash:high` | 速度与智能均衡。OpenAI 将 Terra 定位为 intelligence/cost 的平衡点，并把 `medium` 作为平衡起点。Flash 的参数规模和响应速度明显低于 Pro，但 high thinking 保留较强推理能力，因此作为折中档 fallback，而不是智能档成员。[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)；[DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424/) |
| `smart` | 1. `gpt-5.6-sol:high`  2. `deepseek-v4-pro:high` | 智能优先。Sol 是 GPT-5.6 家族最高推理上限；DeepSeek 将 Pro 定位为强 agentic coding 与世界级推理。两者均使用 `high`，避免把 `max` 的极端延迟作为默认智能档代价。[GitHub Copilot model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison)；[DeepSeek V4 release](https://api-docs.deepseek.com/news/news260424/) |

### effort 的解释

- `:off` / `:low` / `:medium` / `:high` 是 `pi-subagents` 候选字符串中的 thinking 表示；实际请求参数是否可被 cliproxy 完整透传，仍取决于其模型注册和 API 适配。
- 对 OpenAI，`low` 优先速度/成本，`medium` 是大多数工作负载的平衡起点，`high` 是复杂、高价值推理；官方也建议复杂任务比较 `medium` 与 `high`，不应默认把所有任务拉到最高 effort。[OpenAI reasoning effort](https://developers.openai.com/api/docs/guides/reasoning)
- 对 DeepSeek V4，thinking 默认开启；官方的映射是 `low → low`、`medium/high/xhigh → high`、`max → max`。配置直接使用供应商真实支持的 `off` 或 `high`，避免用 `medium` 制造一个并不存在的中等推理档。[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

## 不应进入哪些档

| 模型 | 结论 | 原因 |
| --- | --- | --- |
| `gpt-5.6-sol` | 不进 `fast` / `balanced` | 官方定位即 highest reasoning ceiling、复杂大代码库与长程 agent；放进较低档会破坏这两档的延迟/成本约束。[官方比较](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) |
| `gpt-5.6-luna` | 不进 `smart` | 官方将其定位为 GPT-5.6 家族最低成本、小而快任务；它是 speed 轴的主力，不应被当作复杂调试的质量 fallback。[官方比较](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) |
| `deepseek-v4-flash` | 不进 `smart` | 官方虽称其推理接近 Pro、简单 agent task 可持平，但仍明确以更小参数、快响应、低成本定位；它可以分别以 off 和 high 占据速度端与折中点，不能声称与 Pro/Sol 的智能上限等价。[官方发布](https://api-docs.deepseek.com/news/news260424/) |
| `gpt-5.4-mini` / `gpt-5.4` / `gpt-5.5` | 默认池不采用 | 它们可作为后备，但会把同档链拉长到 3–4 个候选。OpenRouter Pareto Router 每档仅保留主模型加最多两个 fallback；当前只有一个统一 `cliproxy` 入口，更长的同入口链不会增加网关级高可用性，先采用每档两个候选的最小配置。[OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router) |
| `gpt-5.3-codex-spark` | 先不进任何池 | 一手资料可核实的是 **GPT-5.3-Codex**（Copilot 归为 agentic software development），不是 `gpt-5.3-codex-spark` 这个完整 ID。`-spark` 看起来是 cliproxy/本机注册别名；在没有它与官方模型、支持 effort、工具/Responses 兼容性之间的公开对应资料前，不应凭名称把它放入 fast。若以后证实它就是低延迟的 GPT-5.3-Codex 部署，先以 `fast:low` 进行单独验证后再替换 Flash。[官方已支持模型列表](https://docs.github.com/en/copilot/reference/ai-models/supported-models) |

## 路由边界与采纳说明

1. 这是**模型能力档**，不是任务分类，也不是本机 benchmark 排名。Cursor 的公开 Router 将不同目标置于 Pareto 前沿；OpenRouter Pareto Router则使用 low/medium/high 三个 coding quality tier，并在同档内选择和 fallback。这支持“先限定 GPT + DeepSeek，再按速度/智能位置分档”，但不构成针对本机 cliproxy 的性能保证。[Cursor Router](https://cursor.com/blog/router)；[OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router)
2. 所有条目共享 `cliproxy` provider。它们能提供**模型级**顺序候选，但不是独立网关/凭据/网络故障域；cliproxy 故障或其上游共同限流时，同池 fallback 也可能一起失败。不要把本配置宣称为跨提供商高可用设计。
3. DeepSeek 的工具轮次在 thinking 模式下要求将 `reasoning_content` 原样带回后续请求；否则官方 API 会返回 400。采纳 `deepseek-v4-pro` 前，应确认 cliproxy 与 Pi 的 tool-loop 保留该字段。这是接口兼容性门槛，不是 benchmark 问题。[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/)
4. DeepSeek 官方当前列出的 API 名为 `deepseek-v4-flash` / `deepseek-v4-pro`，两个模型版本分别为 `V4-Flash-0731` / `V4-Pro-0813`；文档页面说明价格可调整。GPT 的 Luna/Terra/Sol 证据来自 Copilot 的产品模型比较，OpenAI API 文档的通用 GPT-5.6 guide 仍应作为 reasoning 参数的权威来源。重新配置前应以 live registry 校验 exact ID 和 effort 支持。[深度求索型号与版本](https://api-docs.deepseek.com/quick_start/pricing/)；[OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

## 证据集

### 官方文档 / 产品比较

- [GitHub Copilot — AI model comparison](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) — 给出 GPT-5.6 Luna / Terra / Sol 的快、平衡、深推理定位，以及 GPT-5.4、5.4 mini、5.5 的任务分层。
- [OpenAI — Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) — 定义 `reasoning.effort` 的速度/成本/质量 trade-off，并给出 `low`、`medium`、`high` 的适用工作。
- [OpenAI — GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), [GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) — 确认 mini 的高吞吐定位、5.4/5.5 的复杂专业工作定位，以及相应 effort 支持。
- [DeepSeek — V4 release](https://api-docs.deepseek.com/news/news260424/), [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) — 确认 Flash / Pro 的能力与效率差异、1M context、工具支持、版本号以及 effort 映射。
- [Cursor Router](https://cursor.com/blog/router) — 公开的 Cost / Balance / Intelligence 三目标路由和按任务复杂度分配快/前沿模型的依据。
- [OpenRouter Pareto Router](https://openrouter.ai/docs/guides/routing/routers/pareto-router) — low/medium/high coding quality tier、档内选择与同档 fallback 的公开实现。

### OSS 源码 / 配置参考（补充，非模型能力证据）

- [`z-traveler/pi-subagents@a7950f3b4dc88ef3b9062caf4eb1f3ee6111bb7e:docs/models.md:L64-L78`](https://github.com/z-traveler/pi-subagents/blob/a7950f3b4dc88ef3b9062caf4eb1f3ee6111bb7e/docs/models.md#L64-L78) — `modelPools` 的有序候选数组、语义 `modelClass` 与 agent override 的可用配置形状。该固定 SHA 的提交日期为 2026-08-19；只用来证明配置语法，模型排序来自上述官方资料。

## 可复用结论

`fast = Luna low → Flash off`，`balanced = Terra medium → Flash high`，`smart = Sol high → Pro high`。这是仅沿速度与智能两轴划分、每档保留一个 GPT 主模型和一个 DeepSeek fallback、且不依赖本机 benchmark 的起始配置；未验证前提是 cliproxy 对这些 ID 和 effort 的准确映射，以及 DeepSeek thinking/tool context 的兼容性。
