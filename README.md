# LANtern · 局域网模型网关

> 把本机 **DeepSeek Harness** 里已注册的全部 AI 模型，以 **OpenAI / Anthropic 兼容接口**开放给同一局域网。
> 自带 API Key、限流熔断、能力闸门、四档推理契约、故障转移与用量统计。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/github/package-json/v/5115qwq/dsh-lantern?label=version)](https://github.com/5115qwq/dsh-lantern/releases)
[![Platform](https://img.shields.io/badge/DSH-%E2%89%A50.1.5-7c3aed.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Tests](https://github.com/5115qwq/dsh-lantern/actions/workflows/tests.yml/badge.svg)](https://github.com/5115qwq/dsh-lantern/actions/workflows/tests.yml)

> **本仓库是 [Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern) 的改版（fork）。**
> 原版由 [@Saretheya](https://github.com/Saretheya) 编写，采用 MIT 许可。
> 本版在原版基础上做了大量修复、能力补齐与界面重构，详见 [版本沿革](#版本沿革与致谢)。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [核心特性](#核心特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [API 参考](#api-参考)
- [核心概念](#核心概念)
  - [四档推理契约](#四档推理契约)
  - [能力闸门：unknown ≠ unsupported](#能力闸门unknown--unsupported)
  - [故障转移与健康冷却](#故障转移与健康冷却)
  - [自定义模型](#自定义模型)
  - [API Key](#api-key)
- [配置参考](#配置参考)
- [用量统计](#用量统计)
- [诊断与排障](#诊断与排障)
- [已知限制](#已知限制)
- [安全须知](#安全须知)
- [版本沿革与致谢](#版本沿革与致谢)
- [许可](#许可)

---

## 它解决什么问题

DeepSeek Harness 在本机会注册许多 AI 模型 —— 可能来自多个 provider、多个账号、多个额度池。
但这些模型**默认只有本机能用**：手机、平板、另一台电脑、局域网里的其他工具都访问不到。

LANtern 把 DSH 的模型目录**翻译成标准 API** 暴露到局域网：

```
┌──────────────────────────────────────────────────────┐
│  局域网内的任意客户端                                 │
│  手机 App · IDE 插件 · 脚本 · 另一个 DSH 实例           │
└───────────────────┬──────────────────────────────────┘
                    │  http://192.168.1.x:3080/v1
                    ▼
┌──────────────────────────────────────────────────────┐
│  LANtern（本插件）                                     │
│  鉴权 → 限流 → 能力闸门 → 四档推理 → 故障转移 → 记账    │
└───────────────────┬──────────────────────────────────┘
                    │  ctx.llm.stream(...)
                    ▼
┌──────────────────────────────────────────────────────┐
│  DeepSeek Harness（本机）                              │
│  provider · 模型 · 额度 · 上游凭证 —— 全部保持不变      │
└──────────────────────────────────────────────────────┘
```

**关键设计：插件不复制、不代理、不落盘任何上游凭证。**
它只读取 DSH 已经注册的模型目录，通过 DSH 自身的通道（`ctx.llm.stream()`）发起请求。
所有 SSE 流解码、调用契约与产物都留在 DSH 内，本插件只做**协议翻译与策略控制**。

---

## 核心特性

| 特性 | 说明 |
|---|---|
| **三协议兼容** | OpenAI Chat Completions · Anthropic Messages · OpenAI Responses —— 同一套模型三种写法都能用 |
| **流式与非流式** | 两条路径共享同一套故障转移与降级判据，不会出现"流式能用、非流式报错" |
| **四档推理契约** | 对外统一暴露 `minimal` / `low` / `medium` / `max`，内部自动映射到各模型真实的词表 |
| **能力闸门** | 参数支持情况分「支持 / 不支持 / **未知**」三态；`未知` 照常下发，绝不当作不支持 |
| **故障转移** | 一个对外模型可绑定多个上游；按健康度排序，失败自动切换 |
| **健康冷却** | 失败上游进入指数退避冷却；冷却期内直接跳过，不浪费一次超时 |
| **后台自检** | 全部上游冷却时立即返回 503，同时后台探测恢复，一旦可用立刻解除 |
| **API Key** | 每个 Key 独立限流限额；明文可随时查看；生成即永久 |
| **用量统计** | 按模型 / Key / 上游 / 类型 / 时间多维统计；HTML 报告 + CSV + PNG 导出 |
| **附件账本** | 只追踪本插件创建的附件，到期自动回收（默认 dry-run 预览） |
| **完全可观测** | 30+ 个 `X-Lantern-*` 响应头，逐次解释"为什么得到这个结果" |

---

## 安装

在 **设置 → 插件 → 添加插件** 中粘贴以下**任一**形式：

```
https://github.com/5115qwq/dsh-lantern
```

```
github:5115qwq/dsh-lantern
```

安装完成后**重启 DeepSeek Harness**。

> **手动安装**：从 [Releases](https://github.com/5115qwq/dsh-lantern/releases) 下载 `dsh-lantern-vX.Y.Z.zip`，
> 解压后将 `dsh-lantern/` 整个目录放入
> `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\`，然后重启 DSH。
> 两种方式安装的内容完全一致。

### 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | ≥ 0.1.5（需要 `dsh-llm` 与 `dsh-client-ui-slots`） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |
| 网络 | 插件本身不访问外网；请求全部经 DSH 转发 |

---

## 快速开始

### 1. 生成 API Key

打开 DSH → **设置 → LANtern → API Key 管理** → 输入标签 → 点「生成 Key」。

生成后列表显示指纹。**明文已持久化保存，随时可以点「查看」或「复制」重新获取 —— Key 不会过期。**

### 2. 确认监听

**监听与端口** 提供两种模式：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `reuse` | 复用 DSH 已监听的端口，仅暴露 `/v1/*` | 推荐。不额外占用端口，与 DSH 共存 |
| `standalone` | 插件自行监听一个独立端口 | DSH 只监听回环，但需要局域网访问时 |

> **注意**：`reuse` 模式的绑定地址由 DSH 启动参数 `--host` 决定，插件无权更改。
> 若 DSH 以默认 `--host 127.0.0.1` 启动，局域网将无法连接 ——
> 面板会如实显示**实际**绑定地址，而非配置中期望的值。
> 如需局域网访问，请以 `--host 0.0.0.0` 启动 DSH，或改用 `standalone` 模式。

### 3. 客户端接入

**OpenAI SDK（Python）**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://192.168.1.100:3080/v1",
    api_key="sk-你的明文",
)

resp = client.chat.completions.create(
    model="你的模型名",
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=1000,
)
print(resp.choices[0].message.content)
```

**Anthropic SDK（Python）**

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://192.168.1.100:3080",
    api_key="sk-你的明文",
)

msg = client.messages.create(
    model="你的模型名",
    max_tokens=1000,
    messages=[{"role": "user", "content": "你好"}],
)
print(msg.content[0].text)
```

**Node.js（OpenAI SDK）**

```js
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'http://192.168.1.100:3080/v1',
  apiKey: 'sk-你的明文',
})

const stream = await client.chat.completions.create({
  model: '你的模型名',
  messages: [{ role: 'user', content: '数到十' }],
  stream: true,
})
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
```

**curl**

```bash
# 列出可用模型
curl http://192.168.1.100:3080/v1/models \
  -H "Authorization: Bearer sk-你的明文"

# 对话
curl http://192.168.1.100:3080/v1/chat/completions \
  -H "Authorization: Bearer sk-你的明文" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "你的模型名",
    "messages": [{"role": "user", "content": "你好"}],
    "max_tokens": 500
  }'

# 流式
curl -N http://192.168.1.100:3080/v1/chat/completions \
  -H "Authorization: Bearer sk-你的明文" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "你的模型名",
    "stream": true,
    "messages": [{"role": "user", "content": "数到十"}]
  }'
```

---

## API 参考

### 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 协议 |
| `POST` | `/v1/messages` | Anthropic Messages 协议 |
| `POST` | `/v1/responses` | OpenAI Responses 协议 |
| `GET` | `/v1/models` | 模型列表（OpenAI 格式，附能力扩展字段） |
| `GET` | `/v1/models/{id}` | 单个模型详情 |
| `GET` | `/v1/lantern/health` | 健康检查（含运行时内存分段） |

三条对话协议**共享同一套内核**：鉴权、限流、能力闸门、四档推理、故障转移、记账。
协议层只负责格式翻译，这是刻意设计 —— 否则各条协议的行为会逐渐分叉。

### `/v1/models` 扩展字段

除标准 OpenAI 字段外，每个模型附带网关能力信息：

```jsonc
{
  "id": "your-model-name",
  "object": "model",
  "owned_by": "lantern",
  "reasoning_efforts": ["minimal", "low", "medium", "max"],

  "x-lantern": {
    "custom": true,                                   // 是否自定义模型
    "bindings": ["真实模型名@provider"],                // 上游绑定
    "capabilities": {
      "contractLevels": [                             // 每档实际下发的词
        { "level": "minimal", "word": "low" },
        { "level": "low",     "word": "high" },
        { "level": "medium",  "word": "high" },
        { "level": "max",     "word": "max" }
      ]
    },
    "capabilitiesByBackend": [
      { "backend": "#1", "reasoningEfforts": ["low", "high", "max"] }
    ]
  }
}
```

`contractLevels[].word = null` 表示该模型不支持这一档，请求时会自动降级到最近的可用档。

---

## 核心概念

### 四档推理契约

#### 问题

各家上游的推理强度词表互不相同：

| 上游类型 | 词表示例 |
|---|---|
| A | `light` / `high` / `extra_high` |
| B | `low` / `high` / `max` |
| C | 仅 `high`（单一档） |
| D | 完全不支持推理参数 |

若直接透传客户端传入的值，就会出现"客户端写 `medium`，上游不识别 → 静默失效"。

#### 方案

**对外只暴露四档，对内按每个模型自己的词表换算。**

```
客户端请求    →    目标位置    →    上游收到
────────────────────────────────────────────────
minimal           0/3              词表[0]
low               1/3              词表[round(1/3 × (n-1))]
medium            2/3              词表[round(2/3 × (n-1))]
max               3/3              词表[n-1]
```

**实际映射示例：**

```
模型 A（词表 light/high/extra_high）
  minimal → light (low)
  low     → light (low)
  medium  → high
  max     → extra_high (max)

模型 B（词表 low/high/max）
  minimal → low
  low     → low
  medium  → high
  max     → max
```

#### 三协议写法统一

```jsonc
// OpenAI Chat Completions
{ "reasoning_effort": "medium" }

// OpenAI Responses
{ "reasoning": { "effort": "medium" } }

// Anthropic Messages
{ "thinking": { "type": "enabled", "budget_tokens": 8000 } }
```

#### 多上游时的口径

当一个对外模型绑定多个上游、而各家词表不同时，网关会**为链上每个后端分别换算**：

- `X-Lantern-Effort-Served` —— 聚合口径（链上多数决定的位置）
- `X-Lantern-Effort-Head` —— **实际下发给第一个后端**的词

> 两个头分开，是因为它们可能不同：比如链上有 3 家、词表档位数不同，
> 聚合口径可能是 `high`，但第一家的同位置词恰好叫 `extra_high`。

**若某个绑定的词表全是开关词**（如 `off` / `on`），无法映射到四档，
网关会明确返回 `switch-only` 错误，**而不是静默降级**。

---

### 能力闸门：`unknown ≠ unsupported`

#### 三态而非两态

每个能力维度（图片输入、工具调用、并行工具、推理参数、缓存统计……）有三种状态：

| 状态 | 含义 | 处理 |
|---|---|---|
| `supported` | 确认支持 | 正常下发 |
| `unsupported` | **确认**不支持 | 剥离该参数，并通过响应头与面板明确告知 |
| `unknown` | **无法确认** | **照常下发**，交由上游判断 |

**`unknown` 绝不等同于 `unsupported`。** 这是本项目的设计铁律。

#### 能力信息的来源

1. **静态声明** —— DSH provider 自报的 `inputModalities` 等
2. **运行时学习** —— 真实调用失败后，记录"该上游不支持某能力"
3. **主动探测** —— 面板上的「功能测试」「性能测试」按钮
4. **人工覆盖** —— 直接编辑 `data/capabilities.json`

#### 剥离参数时一定告知

```http
X-Lantern-Dropped-Params: tools,tool_choice
X-Lantern-Capability-Unverified: parallel_tool_calls
```

**不会静默丢弃任何参数。** 客户端可明确得知哪些参数未生效、以及原因。

---

### 故障转移与健康冷却

#### 链式转移

一个自定义模型可绑定多个上游：

```jsonc
{
  "name": "your-model-name",
  "bindings": [
    "真实模型名@provider-a",
    "真实模型名@provider-b",
    "另一模型名@provider-c"
  ]
}
```

请求在某档失败后自动尝试下一档。响应头记录链路情况：

```http
X-Lantern-Failover-Chain: 3
X-Lantern-Served: #2
X-Lantern-Attempt-Codes: #1=backend_timeout(+600s),#2=ok
```

#### 冷却策略

| 失败类型 | 是否冷却 | 退避方式 |
|---|---|---|
| 首字节超时 / `429` / `5xx` | ✅ | 指数退避（默认 600s 起，上限可配） |
| 只有思考、无正文 / 完全空回答 | ✅ | **固定基础冷却，不做指数翻倍** |
| 客户端主动取消 | ❌ | — |
| 4xx 参数错误 | ❌ | — |

> **空回答为何不翻倍**：这类失败通常源于本次 `max_tokens` 预算不足，
> 会随客户端参数调整而自愈，不属于"后端故障"。
> 若同样做指数退避，一次小预算请求就可能让该模型长时间不可用。

#### 全部冷却时

**立即返回 503**（不阻塞等待），同时后台开始探测：

```json
{
  "error": {
    "message": "所有上游都在冷却中，请稍后重试",
    "code": "model_unavailable",
    "allCooling": true
  }
}
```

探测成功即刻解除该档冷却，后续请求立刻可用。

---

### 自定义模型

#### 存在的意义

DSH 内的模型以 `模型名@provider` 形式存在。同一模型可能分布在多个 provider 上，
而客户端通常只希望认一个名字。

**自定义模型 = 一个对外名称 + 一组上游绑定**，客户端只见其名，内部自动路由与转移。

#### 暴露模式

| `customOnly` | 行为 |
|---|---|
| `true`（推荐） | **只暴露自定义模型** —— 目录干净、可控 |
| `false` | 暴露 DSH 目录中的全部模型（可能上百个） |

#### 命名规则

模型名仅可包含字母、数字、下划线、点、连字符、斜杠，
**不可包含 `@`** —— `@` 是真实公开名的分隔符。

---

### API Key

#### 生成与查看

面板 → **API Key 管理** → 输入标签 → 「生成 Key」。

**Key 生成即永久有效，不会过期。**

每行提供「查看」与「复制」按钮 —— **明文持久化保存在 `data/keys.json`**，任何时候都可重新获取。

> **为何保存明文**：若仅存哈希，忘记明文后唯一的补救方式是重新生成，
> 客户端需重新配置。反复遗忘意味着反复更换 Key，实际使用成本高于明文落盘的代价。
> 而 `data/` 目录本身位于本机，能够读取它的人同样能修改配置、看到 DSH 的上游凭证，
> 因此明文落盘**不扩大攻击面**。
>
> 仍保留两条边界：明文**不出现在**任何对外 API 响应中，也**不写入日志**。

#### 独立限额

每个 Key 可单独设置：

- `perKeyRpm` —— 每分钟请求数
- `perKeyTpm` —— 每分钟 token 数

#### 停用与删除的语义

| 操作 | 效果 |
|---|---|
| **停用** | Key 本身不变，立即拒绝；重新启用后客户端无需修改配置 |
| **删除** | 不可恢复。历史用量记录保留并标记为「已删除」 |

#### 匿名访问

`auth.allowAnonymous: true` 时，同网段任何客户端无需 Key 即可使用。
**面板会显著提示该风险。** 不建议在非完全可信的网络中开启。

---

## 配置参考

配置文件：`data/config.json`（可通过面板修改，也可直接编辑后重启）

### `enabled`

总开关。关闭后所有 `/v1/*` 端点返回 404。

### `listenEntries[]`

```jsonc
[
  { "id": "default", "mode": "reuse", "bind": "127.0.0.1", "port": 3080, "enabled": true }
]
```

| 字段 | 说明 |
|---|---|
| `mode` | `reuse`（复用 DSH 端口）/ `standalone`（独立端口） |
| `bind` | 绑定地址。`0.0.0.0` = 全部网段，`127.0.0.1` = 仅本机 |
| `port` | `standalone` 模式的端口号（`reuse` 时自动探测） |
| `enabled` | 是否启用该条目 |

### `protocol`

```jsonc
{ "openai": true, "anthropic": true, "responses": true }
```

关闭某协议后，对应端点返回 404。

### `limits`

| 字段 | 默认 | 说明 |
|---|---|---|
| `maxConcurrent` | `100` | 全局并发上限 |
| `reserveForLocal` | `1` | 为本机 DSH 自身对话保留的槽位 |
| `perKeyRpm` | `100` | 每 Key 每分钟请求数 |
| `perKeyTpm` | `80000` | 每 Key 每分钟 token 数 |
| `maxTokensCap` | `0` | `max_tokens` 上限（`0` = 不限制） |
| `maxBodyBytes` | `4194304` | 请求体字节上限（4 MB） |
| `requestTimeoutMs` | `600000` | 首字节超时（10 分钟） |
| `maxConcurrentTools` | `8` | 单次请求并行工具调用上限 |
| `breaker.enabled` | `true` | 熔断器总开关 |
| `breaker.consecutiveRateLimits` | `20` | 连续限流多少次触发熔断 |
| `breaker.cooldownSec` | `60` | 熔断冷却时长 |
| `backendHealth.enabled` | `true` | 后端健康记忆开关 |
| `backendHealth.cooldownSec` | `3600` | 基础冷却时长 |
| `backendHealth.maxCooldownSec` | `7200` | 指数退避上限 |

> **超时语义为「首字节超时」**：收到第一个实质内容块（正文 / 思考 / 工具调用）后即清除计时器。
> 对长思考模型而言，思考数十秒后才开始输出正文属正常行为，不会被误判超时。

### `auth`

```jsonc
{ "format": "sk", "allowAnonymous": false }
```

`format` 可选 `sk` · `sk-hex` · `sk-lantern`。

### `cors`

```jsonc
{
  "enabled": false,
  "origins": ["http://localhost:3000"],
  "allowCredentials": false
}
```

### `exposure`

```jsonc
{ "maskTopology": true, "maskInternalHints": true }
```

`maskTopology` 控制健康检查是否暴露上游拓扑（provider 名称、模型映射、熔断细节）。
**分享截图或对外排障时建议保持开启。**

### `customOnly`

`true` 时只暴露自定义模型（推荐）。`false` 时暴露 DSH 目录中的全部模型。

### `allowImageInput`

是否允许图片输入。关闭时图片相关请求会被明确拒绝，而非静默丢弃。

### `usage`

```jsonc
{
  "enabled": true,
  "reuseWithinSec": 60,
  "keepReports": 20,
  "maxLedgerBytes": 16777216
}
```

### `perfTest`

```jsonc
{ "timeoutMs": 20000 }
```

面板「性能测试」的单次超时。

### `attachments`

```jsonc
{
  "dryRun": false,
  "reclaimDelayMs": 300000,
  "sweepIntervalMs": 300000,
  "checkSessionRefs": true
}
```

附件账本仅追踪**本插件创建**的附件，不影响 DSH 自身的附件。

---

## 用量统计

### 面板

按 **模型 / API Key / 上游 / 调用类型 / Key×模型** 多维统计，包含：

- 今日 / 本周 / 本月 / 今年 四张概览卡
- 本月环比与日均
- 每个模型的迷你走势图
- 汇总口径可切换（本月当期 / 最近 1、7、30、90 天）
- 已删除的 Key 与已下线的模型默认隐藏，可按需展开查看历史

**仅统计经由本插件的调用**，不含本机 DSH 自身的对话。

### HTML 报告

面板 →「生成报告」→ 打开生成的 HTML 文件。
报告为**自包含单文件**，可离线打开、可直接发送。

内容包含 9 张表：

1. 概览卡片
2. 按模型
3. 按上游
4. 按 API Key
5. 按调用类型
6. 每日 / 每周 / 每月 / 每年趋势（图表 + 桶汇总）
7. 明细 Top 100

**支持导出：**

- **CSV** —— 全部明细（非仅 Top 100），带 UTF-8 BOM，Excel 打开不乱码
- **PNG** —— 当前趋势图（2× 缩放，白底，可直接插入文档）

### 账本

`data/usage.jsonl`，一行一次调用，追加写入。

| 配置 | 默认 | 说明 |
|---|---|---|
| `usage.enabled` | `true` | 关闭后完全不记账 |
| `usage.maxLedgerBytes` | `16 MB` | 超过后自动归档，归档部分不计入统计 |
| `usage.keepReports` | `20` | 保留最近 20 份 HTML 报告 |

---

## 诊断与排障

### 响应头

每个头都在解释"为什么得到这个结果"，而非调试残留。

| 响应头 | 含义 |
|---|---|
| `X-Lantern-Served` | 最终服务的是链上第几档 |
| `X-Lantern-Attempts` | 总尝试次数 |
| `X-Lantern-Attempt-Codes` | 每档结果，如 `#1=backend_timeout(+600s),#2=ok` |
| `X-Lantern-Failover-Chain` | 链长 |
| `X-Lantern-Failover-Skipped` | 被跳过的绑定及原因 |
| `X-Lantern-Effort-Contract` | 客户端请求的档位 |
| `X-Lantern-Effort-Served` | 聚合口径下实际服务的词 |
| `X-Lantern-Effort-Head` | 实际下发给第一档的词 |
| `X-Lantern-Effort-Votes` | 各后端的换算结果 |
| `X-Lantern-Effort-Winner` | 中标结果与模式（`scaled` / `exact`） |
| `X-Lantern-Dropped-Params` | 被剥离的参数 |
| `X-Lantern-Capability-Unverified` | 能力未知、但仍照常下发的参数 |
| `X-Lantern-Message-Roles` | 实际下发的消息角色序列 |
| `X-Lantern-Tools-Sent` | 工具定义是否真正下发 |
| `X-Lantern-Queue-MS` | 排队等待时长 |
| `X-Lantern-Concurrency` | 并发占用情况 |
| `X-Lantern-Max-Tokens` | 实际下发的 `max_tokens` |
| `X-Lantern-Warnings` | 告警汇总 |

### 错误码

**HTTP 状态**

| 状态 | 场景 |
|---|---|
| `400` | 参数错误（非法档位、空 messages、JSON 格式错误） |
| `401` | Key 无效 / 未提供 / 已停用 |
| `404` | 模型不存在 / 端点不存在 / 协议已关闭 |
| `429` | 触发限流 |
| `503` | 全部上游冷却 / 上游返回空内容 / 熔断中 |

**`error.code`**

| 码 | 含义 |
|---|---|
| `invalid_api_key` | Key 无效 |
| `model_not_found` | 模型不存在 |
| `model_unavailable` | 模型存在但当前不可用（全部冷却 / 无可用绑定） |
| `invalid_request_error` | 参数问题 |
| `overloaded_error` | 上游过载 / 熔断中 |
| `upstream_empty_completion` | 上游返回空内容 |
| `cors_origin_not_allowed` | 跨域来源不被允许 |

**内部失败码**（出现在 `X-Lantern-Attempt-Codes`）

| 码 | 含义 | 是否冷却 |
|---|---|---|
| `backend_timeout` | 首字节超时 | ✅ |
| `reasoning_only_empty` | 仅有思考内容、无正文 | ✅（不翻倍） |
| `empty_completion` | 完全空回答 | ✅（不翻倍） |
| `tool_markup_leaked` | 工具标记泄漏到正文 | ✅ |
| `binding_offline` | 绑定的上游当前不可用 | ❌ |
| `switch-only` | 词表全为开关词，无法映射档位 | ❌ |

### 常见问题

**局域网无法连接**

1. 检查监听模式 —— `reuse` 模式下绑定地址由 DSH 的 `--host` 决定
2. 检查系统防火墙是否放行端口
3. 面板「监听与端口」显示的是**实际**绑定地址，可据此确认

```powershell
# 确认监听状态
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

**客户端返回 401**

- 确认 Key 未被停用（面板状态应为「启用」）
- 确认使用 `Authorization: Bearer sk-xxx` 或 `x-api-key: sk-xxx`
- 确认没有多余的空白字符

**首次请求特别慢**

可能原因：

- 上游本身响应慢（思考型模型思考数十秒属正常）
- 该档位正在冷却（查看 `X-Lantern-Attempt-Codes` 中的 `(+600s)` 标记）
- 故障转移正在逐档尝试（查看 `X-Lantern-Attempts`）

**返回 503「所有上游都在冷却中」**

等待冷却到期，或在面板「健康与诊断」中点击「清空记忆」立即重置。

**`max_tokens` 似乎未生效**

DSH 内核行为，非本插件所致。插件会原样透传 `max_tokens`（仅在超过 `maxTokensCap` 时收缩）。
响应头 `X-Lantern-Max-Tokens` 可确认实际下发的值。

**思考型模型只输出思考、没有正文**

增大 `max_tokens`。思考内容会消耗大量 token，预算不足时正文可能一字不剩。
插件具备预算保护（自动放大重试一次），但仍建议给予充足预算。

**用量统计中出现已删除的模型**

打开「显示已删除 / 已下线」开关即可查看。这些条目默认隐藏 ——
账本是追加式流水，删除模型不会抹除历史记录，但也不应干扰当前视图。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| `reuse` 模式绑定地址 | 由 DSH 启动参数决定，插件无权更改 |
| `max_tokens` 上限 | 最终由上游决定，插件只能收缩不能放大 |
| 单一档位词表的上游 | 无法表达多档差异，四档会塌缩到同一词（见 `contractLevels`） |
| 附件回收 | 默认 `dryRun`，需手动关闭才会真正删除 |
| 用量账本 | 超过上限自动归档，归档部分不再计入统计 |

---

## 安全须知

### 攻击面

开放到局域网意味着**同网段任何客户端都可能访问**。请务必：

1. **务必设置 API Key** —— 不要启用 `allowAnonymous`，除非完全信任所在网络
2. **不要将 `0.0.0.0` 暴露到公共网络** —— 家庭局域网可以，公共 WiFi 或办公网络不行
3. **定期查看用量统计** —— 异常调用量是异常访问的第一信号
4. **保持 `exposure.maskTopology` 开启** —— 分享截图时不会泄露上游拓扑

### 数据目录位置

> **插件的数据存放在插件包之外**，默认路径：
>
> ```
> ~/.dsh/lantern-data/
> ```
>
> 可用环境变量 `LANTERN_DATA_DIR` 指定其他位置。
>
> **为什么不在包内**：插件以包的形式安装时，包管理器会在重装/升级时
> **整体替换包目录**。早期版本把数据放在 `<插件根>/data/`，一次 DSH 重启
> 触发的重装导致 API Key、用量账本、自定义模型配置全部被清空。
> 移到包外后，重装与升级都不再影响数据。
>
> 多 profile 共享同一份数据（同一台机器上没必要各存一份 Key）。
> 若包目录内仍存在旧版 `data/`，首次启动会自动复制到新位置（不覆盖已有文件）。

### `~/.dsh/lantern-data/` 目录内容

| 文件 | 内容 | 敏感度 |
|---|---|---|
| `config.json` | 插件配置 | 低（不含上游凭证） |
| `keys.json` | **API Key 明文与哈希** | **高** |
| `usage.jsonl` | 调用流水（模型名、token 数、Key 指纹） | 中 |
| `capabilities.json` | 能力探测结果 | 低 |
| `attachment-ledger.json` | 附件引用 | 低 |

> `keys.json` 含明文密钥，备份 / 截图 / 分享时请务必注意。
>
> **上游凭证永远不在此目录** —— 它们保存在 DSH 自身的配置中，本插件不读取、不复制。

---

## 版本沿革与致谢

### 本项目来源

本仓库是 **[Saretheya/dsh-lantern](https://github.com/Saretheya/dsh-lantern) 的改版（fork）**。

- **原作者**：[Saretheya](https://github.com/Saretheya)
- **源仓库**：https://github.com/Saretheya/dsh-lantern
- **原版许可**：MIT
- **原版最后提交**：2026-10-03

感谢原作者完成了整个插件的架构设计与基础实现 ——
三协议兼容层、模型目录抽象、能力学习机制、四档推理契约的雏形均来自原版。
没有这些基础工作，本版的工作量会大得多。

### 本版的主要改动

| 方向 | 内容 |
|---|---|
| **修复** | 修复系统消息构造导致的 `content.some is not a function` 崩溃；修复推理档位在纯开关词表下静默关闭思考的问题；修复超时被误记为"空回答"导致排障方向错误 |
| **可靠性** | 冷却机制统一为「跳过而非重排」；空回答类失败不再指数翻倍（避免小预算请求锁死模型）；全部冷却时改为立即 503 + 后台自检 |
| **能力** | 完善能力闸门三态判定；补齐四档推理在三条协议下的一致性；工具调用与并行工具的能力判定 |
| **统计** | 用量统计重写（按用户视角的模型名聚合、环比与日均、迷你走势图、时间范围筛选）；HTML 报告重写（体积从 440 KB 降至 57 KB）；新增 CSV 与 PNG 导出 |
| **界面** | 面板分区折叠、Key 批量操作与搜索排序、相对时间显示、诊断页合并、窄屏适配 |
| **工程** | 新增 792 项离线回归测试（含模块完整性、面板字段对齐、消息构造形状三类守卫）；移除已下线功能的死代码 |

### 版本号说明

本仓库自 **1.0.0** 起独立编号（原版为 `0.1.x`），以区分两套代码基。
当前版本见上方徽章与 [Releases](https://github.com/5115qwq/dsh-lantern/releases)。

### 更新日志

每个版本改了什么，见 [CHANGELOG.md](./CHANGELOG.md)。

### 许可

沿用原版 [MIT License](./LICENSE)。

---

<p align="center">
  <sub>让本机已注册的模型额度，为整个局域网所用。</sub>
</p>