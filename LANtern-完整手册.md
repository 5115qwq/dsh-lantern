# LANtern 局域网模型灯塔 —— 完整功能、流程与运维手册

> 本文档记录 LANtern 插件的**全部能力、内部流程、四档推理契约、故障转移语义、验收方法与已知边界**。
> 编写依据：`dsh-lantern` 源码 + 2026-11-07/08 多轮真机实测数据。
> 所有结论都标注了**证据来源**（实测 / 源码 / 单元测试），不含推测。

---

## 目录

1. [这是什么](#1-这是什么)
2. [架构与数据流](#2-架构与数据流)
3. [快速开始](#3-快速开始)
4. [配置文件详解](#4-配置文件详解)
5. [四档推理契约](#5-四档推理契约)
6. [故障转移与轮询语义](#6-故障转移与轮询语义)
7. [能力探测与对外公布](#7-能力探测与对外公布)
8. [响应头一览](#8-响应头一览)
9. [客户端接入指南](#9-客户端接入指南)
10. [验收方法](#10-验收方法)
11. [已修复的问题清单](#11-已修复的问题清单)
12. [已知边界与不支持的场景](#12-已知边界与不支持的场景)
13. [故障排查](#13-故障排查)
14. [安全边界（渗透面实测）](#14-安全边界渗透面实测)
15. [安装、备份与升级](#15-安装备份与升级)

---

## 1. 这是什么

LANtern 是 DSH（DeepSeek Harness）的插件，在**本机**起一个 OpenAI / Anthropic / Responses 三协议兼容的 HTTP 网关，把 DSH 里已注册的模型原样开放给局域网。

```
┌──────────────┐      ┌───────────────────┐      ┌──────────────┐
│ 手机 / 平板   │ ───► │  LANtern 网关      │ ───► │  各家 API     │
│ 另一台电脑    │ ◄─── │ （本机 DSH 内）    │ ◄─── │ （已有登录态） │
└──────────────┘      └───────────────────┘      └──────────────┘
     局域网内                 你的电脑                  上行
```

**它不新增账号、不改你的 DSH 配置、不碰其它插件。** 所有数据写在插件自己的 `data/` 目录里。

### 支持的协议

| 协议 | 端点 | 说明 |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | 主通道，支持流式 |
| OpenAI Responses | `POST /v1/responses` | 新版协议，支持 `instructions` |
| Anthropic Messages | `POST /v1/messages` | Claude 客户端用，支持 `system` 字段 |
| OpenAI Models | `GET /v1/models` | 模型目录，带能力扩展字段 |

---

## 2. 架构与数据流

### 请求处理流程

```
客户端请求
   │
   ├─ 1. 鉴权（Bearer key / x-api-key）        keyStore.verify()
   │      └─ 失败 → 401
   │
   ├─ 2. 限流（perKeyRpm / perKeyTpm）          allowRate()
   │      └─ 超限 → 429
   │
   ├─ 3. 熔断检查                                breaker
   │      └─ 打开 → 503
   │
   ├─ 4. 并发槽（maxConcurrent）                 acquireSlot()
   │      └─ 满 → 503 + Retry-After
   │
   ├─ 5. 模型解析                                resolveModel()
   │      ├─ 自定义模型优先（虚拟名 → 绑定列表）
   │      └─ 真实模型（customOnly 时拒绝）
   │      └─ 找不到 → 404 model_not_found
   │
   ├─ 6. 构建故障转移链                          buildFailoverPlans()
   │      ├─ 逐绑定解析 provider/model
   │      ├─ 能力闸门筛选                        enforceCapabilityGate()
   │      └─ 按健康度重排（只重排，不移除）        orderByHealth()
   │
   ├─ 7. 逐档注解
   │      ├─ 推理档位词                          annotatePlanEfforts()
   │      └─ 输出上限                            annotatePlanMaxOutput()
   │
   ├─ 8. 消息构造                                buildMessages()
   │      ├─ system（或合并进 user，见 #155）
   │      ├─ 历史轮次
   │      ├─ 图片（附件账本）
   │      └─ 工具定义重建（从历史 toolCalls）
   │
   ├─ 9. 执行器逐档尝试
   │      ├─ 流式    streamWithFailover()
   │      └─ 非流式  collectWithFailover()
   │
   └─ 10. 聚合输出 + 响应头                       OpenAiAggregator.end()
```

### 数据目录结构

```
dsh-lantern/
├── lib/                    源码（25 个 .js）
├── data/
│   ├── config.json         主配置（模型、限流、开关）
│   ├── keys.json           API Key（明文只显示一次的哈希存档）
│   ├── usage.jsonl         用量账本（每请求一行）
│   ├── capabilities.json   能力缓存与学习结果
│   ├── media/              媒体产物目录
│   └── tmp/                临时文件
└── package.json
```

---

## 3. 快速开始

### 3.1 安装

在 **设置 → 插件 → 添加插件** 粘贴 `https://github.com/5115qwq/dsh-lantern`（或 `github:5115qwq/dsh-lantern`），然后**完全退出 DSH（含托盘）再启动**。

脚本会：
1. 复制 `dsh-lantern/` 到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\`
2. 在 `package.json` 的 `dependencies` 和 `dsh.profile.bundles` 注册
3. 保留旧 `data/`（如果之前装过）

### 3.2 首次配置

1. **设置 → LANtern** → 打开开关
2. **状态与安全 → 监听地址**
   - `127.0.0.1:3080` 只有本机能访问
   - `0.0.0.0:3080` 局域网可访问
3. **状态与安全 → API Key 管理** → 生成 Key
   - ⚠ 明文只显示一次，立刻复制
4. **状态与安全 → 自定义模型** → 新建
   - 填模型名（对外名，如 `my-gpt`）
   - 选绑定（DSH 里的真实模型，如 `deepseek-v4.1-flash@trae`）
   - 可加多个绑定 → 自动故障转移
5. **调优参数**（每个模型独立）
   - `timeoutMs` 首包超时，推荐 **15000–25000**
   - `retries` 重试次数，推荐 **2**

### 3.3 客户端填法

| 客户端类型 | Base URL | 模型名 |
|---|---|---|
| OpenAI 兼容 | `http://<IP>:3080/v1` | 你建的自定义模型名 |
| Anthropic | `http://<IP>:3080` | 同上 |
| API Key | `sk-...`（生成的那串） | — |

---

## 4. 配置文件详解

### `data/config.json` 主要字段

```jsonc
{
  "enabled": true,
  "listen": { "host": "127.0.0.1", "port": 3080 },

  "exposure": {
    "maskTopology": true      // true = 对外只报「第几档」，不报 provider 名
  },

  "capabilities": {
    "expose": true,           // false = /v1/models 不带能力扩展
    "learnNegative": true,    // 上游报错时学习「不支持某能力」
    "test": {
      "items": ["connectivity", "tools", "temperature", "jsonMode", "stop", "image"],
      "perItemTimeoutMs": 30000
    }
  },

  "limits": {
    "maxConcurrent": 8,       // 全局并发槽
    "perKeyRpm": 100,         // 每 Key 每分钟请求数
    "perKeyTpm": 80000,       // 每 Key 每分钟 token
    "maxTokensCap": 0,        // 0 = 不封顶（#145）
    "reserveForLocal": 1,     // 给本机留的槽
    "maxBodyBytes": 4194304,
    "requestTimeoutMs": 600000,
    "maxConcurrentTools": 8
  },

  "customOnly": true,         // true = 只暴露自定义模型，真实模型全隐藏

  "customModels": [
    {
      "id": "cm_hy4",
      "name": "hy4",
      "display": "hy4",
      "bindings": ["hy4free@xdpool", "hy4std@xdpool", "hy3@xdpool"],
      "enabled": true,
      "timeoutMs": 25000,           // 首包超时
      "retries": 2,                 // 全链共享重试预算
      "reasoningEfforts": [],       // 允许对外的档位白名单（空 = 不限）
      "mergeSystemIntoUser": true   // #155：把 system 合进 user（见下文）
    }
  ],

  "media": {
    "enabled": true,
    "maxFiles": 512,
    "maxFileBytesTotal": 2147483648,
    "fileTtlSec": 21600,
    "maxJobs": 256,
    "videoTimeoutMs": 660000
  }
}
```

### 关键字段说明

| 字段 | 语义 | 踩坑点 |
|---|---|---|
| `timeoutMs` | **首包超时**，不是总时长。首字吐出后定时器就停了 | 设太小会把「慢但正常」的模型判成挂掉 |
| `retries` | **全链共享**预算，不是每档各 N 次 | 按档给会让 3 档模型在真挂时打出 18 次上游调用 |
| `maxTokensCap` | `0` = 不封顶 | 曾经默认 8192，把本地 128K 压成 8K（#145） |
| `customOnly` | 解析层拒绝真实模型，不只是目录隐藏 | 只做目录过滤会让知道名字的人绕过 |
| `mergeSystemIntoUser` | 把 system 文本拼进第一条 user 消息 | 只在模型**真的**不接受 system role 时才开 |

---

## 5. 四档推理契约

### 5.1 为什么是四档

各家上游的档位词表完全不同：

| Provider | 词表 |
|---|---|
| `@xdpool` | `minimal`, `low`, `medium`, `high`, `xhigh`, `none` |
| `@trae` | `light`, `high`, `extra_high` |
| `@loomy` | `low`, `medium`, `max` |

**档位多不等于表达力强。** 用户要的是「我要这个模型最强的」而不是「我要 high 这个词」。

所以对外只暴露**四个契约档**，按**相对位置**映射到每个后端的词表：

```
契约档            位置        映射规则
──────────────────────────────────────────
minimal           0.0         落到该家第一个词
low               0.33        floor(pos × (n-1))
medium            0.67        round(pos × (n-1))
max               1.0         落到该家最后一个词（该家最强）
```

### 5.2 实测落点（2026-11-08）

```
deepseek-v4.1-flash  词表=["light","high","extra_high","none","low","medium","xhigh"]
                     minimal→light  low→high  medium→high  max→xhigh

glm-5.3              词表=["low","high","max","light","extra_high"]
                     minimal→light  low→low   medium→high max→extra_high
```

### 5.3 三种 mapping mode

| mode | 含义 | 是否算降级 |
|---|---|---|
| `native` | 该家**原生就有**这个词 | 否 |
| `scaled` | 按相对位置落词（词不同但语义对齐） | **否**（这是正常映射） |
| `degraded` | 该家撑不住这一档 | **是**，响应头会如实标注 |

⚠ `scaled` 不是降级。只有 `degraded` 才是。

### 5.4 物理上限

3 档词表**无法**表达 4 个不同档位（抽屉原理）。
`X-Lantern-Effort-Position: 2/2` 表示「你已经到这家能给的顶了」。

### 5.5 各池长度的落点（#161 后）

| 池档数 | minimal | low | medium | max | 区分度 |
|---|---|---|---|---|---|
| 2 | 第0 | 第0 | 第1 | 第1 | 2 种（必然） |
| 3 | 第0 | 第1 | 第1 | 第2 | 3 种（必然） |
| **4** | 第0 | 第1 | 第2 | 第3 | **4 种全不同** ✅ |
| 6 | 第0 | 第2 | 第4 | 第5 | 4 种全不同 ✅ |
| 7 | 第0 | 第2 | 第4 | 第6 | 4 种全不同 ✅ |

**池 ≥4 档时四档必然互不相同。** 这是 #161 的核心改进：不再用连续分位
`pos×(n-1)`（会让 4 档池上 `low` 与 `minimal` 撞车、大词表上 `medium` 偏到 `high`），
而是按 `0 / 1/3 / 2/3 / 1` 均匀分段。

### 5.6 为什么某些模型四档区分不开

**先说结论：`#161`/`#162` 之后，池 ≥4 档时四档必不相同；区分度不够是上游元数据问题。**

| 模型 | 各绑定词表 | 区分度 |
|---|---|---|
| `hy4` | #1 `["high"]` / #2 `["high"]` / #3 `["low","medium","xhigh","max","high"]` | 理论 4 种 |
| `deepseek` | #1 无词表 / #2 `["light","high","extra_high"]` | 3 种（只有 1 家有词表，3 档） |
| `glm-5.3` | 五个绑定，全是 3 档 | 3 种（抽屉原理） |
| `Seed` | `["light","high"]` × 2 | 2 种（只有 2 档） |

**关键改动（#162）**：链上投票不再「一人一票」，而是**票权 = 该后端词表档数**。
`hy4` 的 #1/#2 只声明 `["high"]`，一人一票时它们各投 `high`，会把 #3 的四档能力压成一种。

**排查工具**：响应头 `X-Lantern-Effort-Diag` 给出**每个后端读到了什么词表**：

```
X-Lantern-Effort-Diag: hy4free@xdpool:[high],hy4std@xdpool:[high],hy3@xdpool:[xxx|yyy|zzz|www|vvv]
```

| Diag 现象 | 含义 |
|---|---|
| 档数正常、词名是标准词（low/high/max…） | 映射与投票正常 |
| **档数正常、词名全是私有词** | 会走 `#167` 的并回逻辑；若仍全落同档，说明覆盖率判断需要调 |
| 档数是 0 | 取词表失败（见 `#166`） |
| 只有一个后端 | 闸门筛链只剩 1 档 |

**它不受 `maskTopology` 影响**——档位词是协议层通用词汇，不是 provider 名或上游模型名。

### 5.6.1 `#167`：私有词不该被整体踢出

历史行为：只用 `rankOf` 认得出的词参与分位，认不出的直接丢弃。

### 5.6.1b `#168` / `#169`：真正的根因（六轮排查的终点）

前五个修复（`#161`–`#167`）都没解决 `hy4` 四档全落 `high`。真正的根因是两条：

**`#168` 响应头被覆盖。** 投票算出 `low@1/5`，但随后这段代码把它覆盖掉：

```js
const head = plansWithEffort.find((p) => p.effortWord !== undefined)
res.setHeader('X-Lantern-Effort-Served', head.effortWord)   // ← 覆盖成 high
```

`find()` 取的是「第一个有词表的」，`#1` 只有 `["high"]` → 覆盖成 `high` + `1/1`。
**计算一直是对的，只是被这行盖掉了。**

现在投票值保留在 `Served`，链首逐档值改叫 `X-Lantern-Effort-Head`。

**`#169` 单档词表抢到了请求。** 闸门的 `effortState` 只看 `mapLevelToBackend(...).ok`：

```js
const mapped = mapLevelToBackend(list, wantEffort)
return mapped.ok === true ? 'supported' : 'unknown'
```

`mapLevelToBackend(['high'], 'minimal')` 返回 `ok:true`（落到 `high`）——但它
**并没有表达 minimal**，该家只有一档。于是 `#1`/`#2` 算作 `supported` 并原序排前，
**由 `#1` 接住请求，实际只发 `high`**。

现在 `total <= 1` 时降为 `unknown`（候补，排链尾但不剥夺资格），
能真正区分档位的 `#3` 会排到前面。

**诊断头**（不受 `maskTopology` 影响）：

```
X-Lantern-Effort-Diag:   hy4free@xdpool:[high],hy4std@xdpool:[high],hy3@xdpool:[low|medium|high|xhigh|max]
X-Lantern-Effort-Votes:  hy4free@xdpool=high(1),hy4std@xdpool=high(1),hy3@xdpool=low(5)
X-Lantern-Effort-Winner: low@1/5 mode=scaled
X-Lantern-Effort-Head:   high@1/1
```

四个头一起看：**Diag** 是输入（词表）、**Votes** 是投票明细、
**Winner** 是协商结果、**Head** 是链首实际会发的档位。

### 5.6.1c `#167` 的实现细节

单后端场景下这是对的（"宁可承认我只知道它有 low，也不假装 turbo 是最强"）。
但在**多绑定链**上会造成灾难：

```
hy4 三个绑定：
  #1 ["high"]                            认得出，1 档
  #2 ["high"]                            认得出，1 档
  #3 [五个私有词]                         全都认不出 → 整表被弃
结果：pool = ["high"]，四档全落 high，position = 1/1
```

**修法**：认得出的词优先，但当它们**不足以表达档位差**时
（少于 2 个，或覆盖率不足原表的一半），把认不出的词按**原始位置**并回池子。

相信厂商自己的顺序，比"当作不存在"更接近真实——厂商即使不用标准词，
词表本身通常也是从弱到强有序的。

**保守性**：认得出的词足够表达时（≥2 个且覆盖过半），行为完全不变。

### 5.6.2 `#166`：`resolveModelInfo` 返回 `null` 时的崩溃

```js
let info
try { info = await this.ctx.llm.resolveModelInfo(provider, model) }
catch { return undefined }          // ← 只接了"抛异常"
const mods = info.inputModalities   // ← 返回 null 时这里 TypeError
```

`resolveChainWordFor` 用 `try{...}catch{}` 包着 `describe()`，于是这个
TypeError 被吞成**空词表**——某个绑定明明有 5 档 reasoning，却被当成"无档案"跳过。

**修法**：`info === null || info === undefined || typeof info !== 'object'` 时返回 `undefined`。

### 5.7 默认档：`defaultReasoningEffort`

四个模型都配了 `"defaultReasoningEffort": "medium"`。不传档位时走它。

**注意：调档位不能保证变快。** 实测：

```
deepseek: minimal 16.1s / low 38.7s / medium 10.9s / max 30.0s
glm-5.3:  minimal 12.8s / low  8.0s / medium  6.7s / max  5.8s
```

`low` 可能比 `max` 还慢。延迟主要由上游排队决定。

---

## 6. 故障转移与轮询语义

### 6.1 链的构建

```
自定义模型的 bindings 数组
   ↓ 按顺序
buildFailoverPlans()  →  每条解析成 { provider, model, binding }
   ↓
enforceCapabilityGate()  →  硬不支持的能力直接剔除
   ↓
orderByHealth()  →  冷却中的后端**重排到链尾**（不移除！）
   ↓
最终链
```

**铁律 3**：冷却只重排，不移除。移除等于「一次抖动让好后端永久消失」。

### 6.2 执行语义

```
请求进来
  ↓
档 #1 → 等首字，最多 timeoutMs
  ├─ 首字到了 → 立刻返回，后面生成多久都不砍      ← 常态
  ├─ 超时（timeoutMs 无首字）
  │     └─ **不重试**，直接跳 #2                  ← #151
  ├─ 空回答（0 字）
  │     └─ 重试一次（花预算）                      ← #152
  ├─ 只思考不回答（reasoning_only）
  │     └─ 重试一次（花预算）                      ← #152
  ├─ 429 / 408 / 5xx
  │     └─ 重试一次（花预算）
  └─ 401 / 403 / 404 / 参数错
        └─ 不重试，直接跳下一档
  ↓
档 #2 … 档 #N
  ↓
全挂 → 报最后一个错误
```

### 6.3 为什么超时不重试

同一个后端在 25 秒里没吐一个字，再给它 25 秒只是**把用户等待翻倍**。
用户要的是「超时就切下一个」，换后端才是这里的衔接。

### 6.4 冷却豁免（#153）

以下错误**不记录后端冷却**：

| 错误码 | 原因 |
|---|---|
| `empty_completion` | 单次运气，不是后端坏了 |
| `reasoning_only_empty` | 思考吃光预算，换次预算往往就好 |

**为什么**：实测连续 13 项请求打到同一档，一次空回答就让该档进冷却、后续全被降级，`attempts` 一路涨到 4-5。而单独测（间隔 1 秒）时 6/6 一次成功——差别只在请求节奏。用这类错误触发冷却会**自我放大**。

---

## 7. 能力探测与对外公布

### 7.1 三态模型

| 值 | 含义 | 闸门行为 |
|---|---|---|
| `supported` | 上游明确声明支持 | 放行 |
| `unknown` | 没证据（上游未声明 / 探测失败） | **放行**，但标 `X-Lantern-Capability-Unverified` |
| `unsupported` | 上游明确拒绝 | **硬拒绝**，400 |

**铁律 2**：`unknown ≠ unsupported`。把「不知道」当「不支持」会让整个模型用不了（#142 就是这么来的）。

### 7.2 数值型能力的聚合

上下文窗口 / 最大输出这类数值，多档之间取 **max**（#147）：

```
deepseek-v4.1-flash 三档 ctx = 1000000 / 960000 / 1048576
  → 对外报 1048576（不是 960000）
```

**理由**：客户端会按公布值裁剪上下文，说小了等于替用户扔掉可用能力。而「某档吃不下」由逐档 `min(用户要的, plan.maxOutput)` 在执行时兜住，不会真的溢出（#150）。

### 7.3 `/v1/models` 的返回结构

```jsonc
{
  "id": "glm-5.3",
  "object": "model",
  "created": 1793709279,
  "owned_by": "lantern",
  "root": "glm-5.3",

  // ── 标准兼容尝试（#156）──
  // OpenAI 协议本身没有"支持哪些推理档位"这个字段，
  // 这里放几个客户端**可能**读的位置
  "reasoning_efforts": ["minimal", "low", "medium", "max"],
  "supported_reasoning_efforts": ["minimal", "low", "medium", "max"],
  "capabilities": { "reasoning_efforts": ["minimal", "low", "medium", "max"] },

  // ── 本插件扩展 ──
  "x-lantern": {
    "provider": null,
    "providerName": "lantern",
    "model": "glm-5.3",
    "custom": true,
    "custom_id": "cm_glm53",
    "bindings": [{ "order": 1, "available": true }, ...],
    "capabilities": {
      "text": { "value": "supported", "source": "dsh" },
      "reasoning": {
        "value": "supported",
        "efforts": ["low", "high", "max", "light", "extra_high"],
        "defaultEffort": "extra_high"
      },
      "contextWindow": { "value": 1000000, "source": "intersection" },
      "maxOutputTokens": { "value": 64000, "source": "intersection" },
      "contractLevels": [
        { "level": "minimal", "word": "light", "mode": "scaled" },
        { "level": "low",     "word": "low",   "mode": "native" },
        { "level": "medium",  "word": "high",  "mode": "scaled" },
        { "level": "max",     "word": "extra_high", "mode": "native" }
      ]
    }
  }
}
```

### 7.4 客户端读不到档位怎么办

**实测**：DSH 的 asar 里 `x-lantern` 出现 **0 次**——它完全不读这个字段，只读自己 `cordis.patch.yml` 里的 `reasoningEfforts`。

**应对**：
1. 客户端如果能读顶层 `reasoning_efforts` → 直接可用
2. 读不到 → **让客户在配置里手动填四档**：`minimal` / `low` / `medium` / `max`

以 DSH 为例：
```yaml
model: glm-5.3
reasoningEfforts:
  minimal: minimal
  low: low
  medium: medium
  max: max
```

---

## 8. 响应头一览

### 请求侧（客户端可发）

| 头 | 作用 |
|---|---|
| `Authorization: Bearer sk-...` | OpenAI 风格鉴权 |
| `x-api-key: sk-...` | Anthropic 风格鉴权 |
| `anthropic-version` | `/v1/messages` 必需 |

### 响应侧（网关回）

| 头 | 含义 |
|---|---|
| `X-Lantern-Served` | 实际服务的后端。脱敏时是 `#1`/`#2`，否则是 `model@provider` |
| `X-Lantern-Attempts` | 尝试次数。**只在真的试过之后才发**（#158）——流式响应在首字节前写头，那时还不知次数，发 `0` 反而误导 |
| `X-Lantern-Failover-Chain` | 链长度 |
| `X-Lantern-Effort-Contract` | 客户端要的契约档 |
| `X-Lantern-Effort-Served` | 实际落到上游的词 |
| `X-Lantern-Effort-Position` | `2/3` 形式，表示该家第几档 / 共几档 |
| `X-Lantern-Effort-Note` | 降级说明（`degraded` 时才有） |
| `X-Lantern-Capability-Unverified` | 该能力是 `unknown`，已放行但未证实 |
| `X-Lantern-Dropped-Params` | 上游不认、已摘掉的参数 |
| `X-Lantern-Ignored-Params` | 静默忽略的参数 |
| `X-Lantern-Tool-Choice` | 工具选择模式（`soft` 表示降级成提示词约束） |
| `X-Lantern-Tool-Markup-Leaked` | 上游把工具调用渲染成文本了 |
| `X-Lantern-MaxTokens-Capped` | 按档降级后的实际 max_tokens（#150） |
| `X-Lantern-Internal-Frame` | 500 时的错误原文（便于定位） |

### `finish_reason` 的四态 + 两态

| 值 | 含义 |
|---|---|
| `stop` / `length` / `tool_calls` | 标准 OpenAI 语义 |
| `reasoning_only` | **只有思考没正文**（预算被思考吃完） |
| `empty_completion` | **彻底空**：正文空、推理空、无工具（#144） |
| `tool_markup_leaked` | 上游不支持结构化工具，把标记当文本吐了 |

---

## 9. 客户端接入指南

### 9.1 OpenAI 兼容客户端

```
Base URL : http://<IP>:3080/v1
API Key  : sk-...
模型      : 自定义模型名
```

> ⚠ Base URL 要带 `/v1`。填 `http://<IP>:3080` 会导致路径拼成 `/chat/completions` 而 404。

### 9.2 Claude / Anthropic 客户端

```
Base URL : http://<IP>:3080
API Key  : sk-...
模型      : 自定义模型名
```

> 客户端会自动加 `/v1/messages`。

### 9.3 推理档位怎么设

**四个契约档**：`minimal` / `low` / `medium` / `max`

| 客户端 | 字段 |
|---|---|
| OpenAI | `reasoning_effort: "max"` |
| Anthropic | `thinking: { type: "enabled", budget_tokens: N }` 或 `reasoning_effort` |
| Responses | `reasoning: { effort: "max" }` |

### 9.4 工具调用

标准 OpenAI `tools` + `tool_choice` 即可。网关会：

1. 把 `tools` 转成 DSH 的 schema
2. 模型返回 `tool_calls` 时结构化输出
3. 下一轮的 `tool` 消息会重建成 `toolResult` 块

### 9.5 生图 / 生视频端点

媒体端点**与对话模型分开**，`model` 字段只接受特定值。

先查可选值（**必须先查**，否则会 400 `model_not_allowed`）：

```bash
curl -H "Authorization: Bearer sk-..." http://<IP>:3080/v1/media/models
```

返回：

```jsonc
{
  "data": [
    { "id": "lantern-image", "capabilities": ["text-to-image", "image-to-image"],
      "endpoints": ["/v1/images/generations", "/v1/images/edits"] },
    { "id": "lantern-video", "capabilities": ["text-to-video", "image-to-video"],
      "endpoints": ["/v1/videos", "/v1/videos/{id}", "/v1/videos/{id}/content"] }
  ],
  "x-lantern": {
    "customOnly": true,
    "accepted_models": ["lantern-image", "lantern-video", "deepseek-v4.1-flash", "glm-5.3", "Seed-2.1-Pro", "hy4", "Qwen3.8-Flash"]
  }
}
```

#### 生图（同步）

```bash
curl -X POST http://<IP>:3080/v1/images/generations \
  -H "Authorization: Bearer sk-..." -H 'content-type: application/json' \
  -d '{"prompt":"一只橘色的猫坐在窗台上，水彩风格","model":"lantern-image","n":1}'
```

实测返回（9.4 秒）：

```jsonc
{
  "created": 1794124050,
  "data": [{ "url": "http://<IP>:3080/v1/media/files/11f3b51f..." }],
  "x-lantern": {
    "model": "hunyuan-image-alpha",     // 实际用的上游模型
    "mode": "generate",
    "credit": 5.77,
    "bytes": 571490,
    "expires_at": 1794145650,
    "artifacts": [{
      "role": "original", "label": "带水印原图",
      "url": "...", "bytes": 571490, "mime": "image/png",
      "watermarked": true
    }],
    "watermark_removed": false
  }
}
```

**水印说明**：上游在右下角加水印。网关**默认不做去除**（`watermark_removed: false`）。
要去水印需在配置里显式打开对应开关。

#### 生视频（异步）

```bash
# 1. 创建任务 → 202 + id
curl -X POST http://<IP>:3080/v1/videos \
  -H "Authorization: Bearer sk-..." -H 'content-type: application/json' \
  -d '{"prompt":"一片叶子在风中飘落","model":"lantern-video"}'
# → {"id":"video_432218ca...","status":"queued"}

# 2. 轮询状态
curl -H "Authorization: Bearer sk-..." http://<IP>:3080/v1/videos/<id>
# → queued → in_progress → completed / failed

# 3. 下载
curl -H "Authorization: Bearer sk-..." http://<IP>:3080/v1/videos/<id>/content -o out.mp4

# 4. 列出本进程内的任务
curl -H "Authorization: Bearer sk-..." http://<IP>:3080/v1/videos
```

**状态机**：`queued` → `in_progress` → `completed` / `failed`
**实测耗时**：创建 15 秒内返回 202；约 166 秒到 `completed`；全程 169 秒。
**产物**：2,903,855 字节，`video/mp4`，`ftyp` box 在 offset 4（签名 `00000020 66747970 69736f6d`）。

**视频水印**：上游在画面左上角烙入固定标识。网关**不做视频重编码**，因此**不提供无水印版**。

---

## 10. 验收方法

### 10.1 快速自检

```bash
# 网关还活着吗
curl http://127.0.0.1:3080/v1/lantern/health

# 模型目录（带 key）
curl -H "Authorization: Bearer sk-..." http://127.0.0.1:3080/v1/models
```

### 10.2 分层测试

| 层级 | 内容 | 脚本 |
|---|---|---|
| **L1 离线回归** | 52 套 / 1263 项，纯函数 + 源码断言 | `.regress.mjs` |
| **L2 单点冒烟** | 各模型基础对话、流式、三协议 | `verify-all.mjs`（40 项） |
| **L3 轮询专项** | 故障转移、冷却、重排 | `.failover-suite.mjs`（26 项） |
| **L4 全模型矩阵** | 5 模型 × 13 场景 | `matrix.mjs`（65 项） |
| **L5 缺口审计** | 流式 / 三协议 / 3 路并发 / 工具闭环 | `audit-gaps.mjs`、`gap-tool2.mjs` |
| **L6 图片端到端** | 程序生成合法 PNG，验证模型真能看到图 | `img-test.mjs` |
| **L7 持续压力** | 20 路 × 3 轮 = 60 请求 | `final-gaps.mjs` |

### 10.4 实测结果总览（2026-11-08，重启后复验）

```
L1 离线回归      52 套 / 1263 项 / 0 失败
L2 双端全量      40 / 40
L3 轮询 本地/远端 26/26 · 26/26
L4 全模型矩阵    65 / 65
L5 缺口审计      5 / 5
L6 图片端到端    5 / 5（128×128 纯色图，识色全对）
L7 20 路压力×3   60 / 60
L8 生图端到端    通过（571,490 字节 PNG，签名校验正确）
L9 生视频全流程  通过（169 秒，2,903,855 字节 MP4，ftyp 校验正确）
L10 浸泡测试     74 轮 / 296 请求 / 100% 成功 / 延迟漂移 0.0%
L11 渗透面测试   无 key 18 项全 401；持 key 无越权；路径穿越全失败
```

### 10.4.1 可独立复跑的总验收

`FINAL-AUDIT.mjs` 是一个**不依赖任何外部脚本**的自包含验收器，
只打 HTTP、结果写 `FINAL-AUDIT.txt`。8 个测试层 42 项：

```bash
node FINAL-AUDIT.mjs
# → <你的用户目录>
```

它覆盖：健康与目录、五模型双端对话、三协议、工具调用、四档推理、
图片输入、生图下载、无 key 鉴权。**换一台机器也能直接跑**（改脚本顶部的
`testkey.txt` 路径与两个 base URL 即可）。

### 10.7 浸泡测试怎么做

自带的 `soak.mjs` 按固定节拍持续发请求，每轮写一行 TSV（时间戳/轮次/成功数/延迟分位/错误类型），
用来抓「跑久了才出现」的问题：连接泄漏、内存增长、冷却累积、限流误触发。

```bash
# 参数：分钟数 并发数
node soak.mjs 15 4
```

**注意**：不要同时跑多个 soak 实例——它们会写同一个 `soak.tsv`，结果互相覆盖。

**实测结果（2026-11-08，15 分钟 × 4 并发）**：

```
总轮数 74   请求 296   成功 296   成功率 100.00%   错误 0

段        轮数  中位延迟   最大P50    最大P95     成功率
前 1/3    24    6308ms    8430ms     13097ms    100.0%
中 1/3    24    5824ms    9589ms     13153ms    100.0%
后 1/3    26    6309ms    9391ms     16644ms    100.0%

中位延迟漂移：6308ms → 6309ms（+0.0%）
```

**判读方法**：把轮次分三段比中位延迟。若后段显著高于前段（判据取 30%），
说明有东西在累积——连接泄漏、内存增长、冷却标记堆积、限流误触发。
本次漂移 **0.0%**，排除以上几类。

### 10.8 流式「等很久再一次性出来」怎么判断

**⚠ 判据不能用「最大帧间隔」** —— 那是错的。如果网关攒完一次性写出去，
帧间隔同样很小（都同时写）。第一轮排查就栽在这个盲点上，白跑了几轮。

**正确判据：数据在时间轴上的分布。**

```bash
node STREAM-TIMELINE.mjs   # → STREAM-TIMELINE.txt
node STREAM-DIAG2.mjs      # → STREAM-DIAG2.txt
```

看**「最后 10% 窗口内到达的字节占比」**：

| 占比 | 判定 |
|---|---|
| > 80% | ❌ 假流式（数据挤在末尾） |
| 50–80% | ⚠ 偏攒包 |
| < 50% | ✅ 真流式（随时间均匀到达） |

实测（#165 修复前）：

```
模型                chunks  数据跨度   末尾占比   判定
hy4                  60    2,660ms    10.6%    ✅
glm-5.3              17    1,060ms     —       ⚠
Seed-2.1-Pro          1        0ms     —       ❌
deepseek-v4.1-flash   1        0ms    72.0%    ❌  59,933 字节挤在最后 1ms
```

**关键辅助判据：输出越长越像流式 = Nagle 攒包。**

```
deepseek max_tokens=100/400  → 1 chunk   ❌
deepseek max_tokens=2000     → 10 chunks ✅（134KB，跨度 12.4 秒）
```

应用层攒包会让长回答也被攒；只有 Nagle 这种 TCP 层合并才呈现
"小数据被攒、大数据正常"的反差。

**#165 修复**：三条流式路径 `flushHeaders()` 后加
`res.socket.setNoDelay(true)`，关掉 Nagle。

### 10.8.1 修后实测

```
deepseek-v4.1-flash：
  场景              修复前      修复后
  minimal          1 chunk  →  67 chunks ✅（末尾占比 1%）
  low              1 chunk  →  26 chunks ✅
  medium           1 chunk  →  21 chunks ✅
  max              1 chunk  →  46 chunks ✅
  max_tokens=100   1 chunk  →  28 chunks ✅
  max_tokens=4000  1 chunk  →  29 chunks ✅
  长回答 184KB     10 chunks →  682 chunks ✅（跨度 12.5 秒）
```

### 10.8.2 `Seed-2.1-Pro` 仍不流式（上游限制）

```
mt=100    1 chunk   13,741 字节
mt=400    1 chunk   14,571 字节
mt=1500   2 chunks  28,521 字节
mt=3000   5 chunks  77,397 字节
长回答    27 chunks 310,953 字节（跨度 98 秒）
```

**按约 14–15 KB 一块发。** 这是上游 `trae` 服务端的缓冲，不是 Nagle
（Nagle 的 MSS 约 1.4KB，不会以 14KB 为一块）。

`Seed-2.1-Pro` 的两个绑定都在 `trae` 下，换绑定无法规避。
**网关无法改变，要改善只能换 provider。**

### 10.8.3 判定流式的正确方法

⚠ **不要用「最大帧间隔」**。用 `STREAM-VERDICT.mjs` 的三条判据（满足两条即真流式）：

| 判据 | 阈值 |
|---|---|
| A. chunk 数 | ≥ 10 |
| B. 数据跨度（**首帧→末帧**） | ≥ 300ms |
| C. 末尾 10% 窗口字节占比 | < 60% |

**B 的算法要点**：跨度只从首帧算起，**不与总耗时比**。
思考阶段（首帧之前）本来就没数据，算进分母会误判——
实测 682 chunk 的长回答曾因前面 6.9 秒在思考而被误判成假流式。

### 10.8.5 工具循环与 `EMPTY_RESPONSE`（`#170` 的教训）

**症状**：手机上发消息后报

```
EMPTY_RESPONSE
model "deepseek-v4.1-flash" returned a completed response with no content
```

重试到 2/5 仍失败，整轮对话中断。

**根因**：网关依据历史里的 `tool_calls` **重建最小 tools schema** 并下发——
这是 `#140` 修"续轮模型说没有工具"时加的。

`#170` 曾把它收紧成"必须客户端显式声明工具才重建"，理由是"标准 OpenAI 语义里
`tools` 缺失就是没有工具"。**这个改动把 DSH 自己打挂了**：

- DSH 的 agent 循环续轮时**不重复发 `tools`**（内部自己管理）
- 收紧后网关不下发 tools → 模型看到"有工具结果但没有工具定义" → 返回 200 + 空正文

**所以重建必须无条件保留**，唯一安全的例外是客户端显式 `tool_choice: 'none'`
——那是明确的"别调工具"。

#### 不要把"模型想再调一次"当成网关 bug

实测四个模型，第 2 轮（带工具结果、`tool_choice:'auto'`）：

```
deepseek-v4.1-flash  → finish=stop        正文正常   ✅
glm-5.3              → finish=stop        正文正常   ✅
hy4                  → finish=stop        正文正常   ✅
Seed-2.1-Pro         → finish=tool_calls  正文 0 字   ⚠
```

`Seed-2.1-Pro` 单独验证：

```
auto     → tool_calls   0 字
none     → stop         180 字  ✅
无 tools → tool_calls   0 字      ← 连不给 tools 都还想调
```

**这是模型自己的决策，网关改不了。** 客户端可以靠 `tool_choice:'none'` 让它收手。

#### 验证工具循环的脚本

```bash
node TOOL-E2E.mjs    # 四模型 × (第1轮 tool_calls / 第2轮正文 / 流式 tool_calls)
node TOOL-DIAG.mjs   # 逐模型对比 auto / none / 无tools 三种情形
```

### 10.9 抓包看到的「等半天 → 突然全出」怎么判读

用户抓到的真实 SSE 长这样：

```
: ping                      ← 15 秒时的心跳（注释行，客户端通常不显示）
: ping
data: {"choices":[{"delta":{"role":"assistant","content":""}}]}   ← 首帧
data: {"choices":[{"delta":{"reasoning_content":"The"}}]}
...
```

**关键判读**：看 `首帧时刻` 与 `ping 时刻` 的关系。

| 现象 | 含义 |
|---|---|
| 首帧 = 16,508ms，ping = 16,150ms | **模型思考了 16 秒**，期间一个 token 都没吐。心跳救不了空白的感知，但至少证明连接活着 |
| 首帧后 500 帧全挤在 5ms 内 | 真·攒包（**只有 `Seed-2.1-Pro` / `trae` 上游会这样**） |
| 首帧后帧均匀铺开几百到几千 ms | 正常流式 |

**实测四个模型（每模型 2 次，`reasoning_effort: 'low'`）**：

```
模型                  帧数   数据跨度    占总量     判定
hy4                   183   5,974ms    67%       ✅
                      157   5,204ms    71%       ✅
deepseek-v4.1-flash   116   1,135ms    40%       ✅
                      111   1,132ms    42%       ✅
glm-5.3                38   1,492ms    35%       ⚠
                      110   4,685ms    63%       ✅
Seed-2.1-Pro          960      12ms     0%       ❌ 上游 trae 的 14KB 缓冲
                     1004       7ms     0%       ❌
```

**判据用「数据跨度占总量百分比」**：> 40% 正常，< 15% 攒包。
**不要用「帧间隔」**——攒包后一次性写出去，帧间隔同样是 0。

`#171` 把心跳从 15 秒缩到 5 秒，缩短了"完全没动静"的感知窗口。

### 10.9.1 `#172`：块大小才是流式的真判据

### 10.9.2 `#174`：「一个模型流式、其他不流式」的真因

**这是最曲折的一个问题——九轮排查都改错了地方，真正原因是一行配置。**

#### 症状

```
hy4                 → 真流式   ✅
deepseek-v4.1-flash → 假流式   ❌
glm-5.3             → 假流式   ❌
Seed-2.1-Pro        → 假流式   ❌
```

本机 GUI 对话是流式的，只有开放 API 不流式。

#### 真因

配置里 `mergeSystemIntoUser` 只有一个模型是 `true`：

```jsonc
"hy4":                 "mergeSystemIntoUser": true    ← 唯一对的
"deepseek-v4.1-flash": "mergeSystemIntoUser": false   ← 错的
"glm-5.3":             "mergeSystemIntoUser": false   ← 错的
"Seed-2.1-Pro":        "mergeSystemIntoUser": false   ← 错的
```

| 值 | system 怎么发 | 结果 |
|---|---|---|
| `true` | 拼到第一条 user 消息前面 | ✅ 真流式 |
| `false` | 单独一条 `role:'system'` 消息 | ❌ 上游攒包 |

**上游（xdpool → 各家模型）在收到独立 system 消息时，会把整段回答攒完再吐。**

#### 决定性实测

同一 prompt、同一模型，只改有没有独立 system：

```
⑤ 只有 system        时段 1/20   静默 1ms     80 帧全挤在最后 5ms   ❌
① 纯 user 无 system  时段 15/20  静默 136ms   前中后 35/208/192      ✅
```

改 `mergeSystemIntoUser: true` 之后（同一脚本重测）：

```
② system + 历史       时段 16/20  静默 247ms（原 2/20、4,148ms）
③ system+历史+tools   时段 18/20  静默 133ms（原 4/20、5,169ms）
④ 只有 tools          时段 17/20  静默 146ms（原 2/20、2,218ms）
⑤ 只有 system         时段 17/20  静默 118ms（原 1/20、1ms）
```

#### 为什么 GUI 是流式的

GUI 走 `options.system = text`（DSH 内核的独立字段），
而网关走"消息数组里插 system 消息"——**两条路径给上游的东西不同**。

#### 教训

**症状出现「一个模型正常、其他不正常」时，第一件事是 diff 配置，不是读代码。**

这九轮里我改过 Nagle、socket 写缓冲、pending 队列、响应头覆盖、ghost 投票……
全是流式管道里的代码，**没有一次想到去比四个模型的配置差异**。

#### 判据：看「有帧时段数」+「有效输出窗口占比」

```bash
node TRACE-FRAMES.mjs     # 20 等分时间轴，数有几段收到帧
node DEEPSEEK-TIMING.mjs  # 思考/正文各自的跨度与进度分位
```

| 有帧时段 | 判定 |
|---|---|
| 15–20 / 20 | ✅ 真流式 |
| 8–14 / 20 | ⚠ 偏攒 |
| 1–4 / 20 | ❌ 假流式 |

**四模型的最终实测（`#174` 修好之后）**：

```
模型                 空白期     思考跨度    正文跨度   有效输出占比
hy4                 3,077ms   25,842ms   13,815ms      92%  ✅
deepseek-v4.1-flash 2,895ms    9,021ms    4,522ms      82%  ✅
glm-5.3             2,054ms       131ms    4,285ms      —    ✅ 正文流式
Seed-2.1-Pro      116,261ms        28ms       15ms       0%  ❌ 上游攒包
```

**`Seed-2.1-Pro` 是唯一真正攒包的**：前 116 秒一无所有，然后 43ms 吐完 2,890 字。
它两个绑定都在 `trae` 下，网关无法改变——`#175` 的 keepalive 只是让那段时间界面别完全静止。

### 10.9.3 `#175`：长时间空白要发「合法空帧」而不是注释

### 10.9.4 `#179`：图片能力学习要多绑定一起看

`hy4` 带图请求实测：

```
hy4#1  200  finish=empty_completion  att=3   ← 三个绑定全试过，全空
hy4#2  200  finish=empty_completion  att=3
hy4#3  200  finish=empty_completion  att=3

glm-5.3   200 finish=stop  答："这张图片是红色的"   ✅
deepseek  200 finish=stop  答："这张图是红色的"     ✅
```

**问题**：负能力学习原判据是 `attempts.length === 1`（只尝试一次才算证据）。
`hy4` 有三个绑定，每次都 `att=3`，**永远进不了学习分支** ——
于是每次带图请求都要白跑 3 次上游、返回空正文，而且永远学不到"不支持图片"。

**修法**：所有尝试**都是 `empty_completion`** 且没有超时/限流/取消 → 认定不支持。
多绑定全空比单次空更有说服力。

**判断依据表**：

| 尝试情况 | 是否记为不支持 |
|---|---|
| 1 次空产出 | ✅ 是 |
| **多次尝试全空产出** | ✅ **是（本次修复）** |
| 夹杂超时 | ❌ 不是（来不及 ≠ 不支持） |
| 夹杂 429 / 503 / 限流 | ❌ 不是（稍后就好） |
| 客户端取消 | ❌ 不是（不是后端的锅） |

### 10.9.4b `#180`：「逐个实测」那一列红字

面板「逐个实测」按**绑定**探测，实测结果：

```
glm-5.3@xdpool               content.some is not a function   ❌
sn-glm-5-3-flash@raccoon     6305 ms                          ✅
glm-5.3@trae                 content.some is not a function   ❌
glm-5.3-flashx@trae          7041 ms                          ✅
glm-5.3-flash@trae           4992 ms                          ✅
```

**同一个模型、不同绑定，有的报错有的正常** —— 所以不是模型不支持，
而是探针发了**独立 system 消息**，部分链路上游接到它会走到
`content.some(...)` 并抛错。

**修法**（与网关主路径 `#174` 对齐）：探针只发 user 消息，system 文本并入 user。

```js
// 之前
createSystemMessage('只回复一个字。', 'dsh-lantern-bindingtest'),
createUserMessage({ content: [{ type: 'text', text: 'ping' }] }),

// 现在
createUserMessage({ content: [{ type: 'text', text: '只回复一个字：ping' }] }),
```

**附带严谨性提升**：原来"跑完了没报错"就算通过，即使零输出——
现在要求 `ttftMs` 有值（真的收到了 text/reasoning 增量），否则报 `kind: 'empty'`。
空产出给绿灯比报错更害人。

### 10.9.4c `#181`：新增模型「本机好、开放就挂」

**症状**：面板测试正常、本机 GUI 正常，但通过开放 API 调用返回空。

**实测（同一模型、只改消息形状）**：

```
                      仅 user         user+system
Qwen-3.8-Flash      ✓ 正文 43 字     ✗ 正文 0 字（4ms 空返回）
GPT-6-Luna          ✓ 正文 37 字     ✗ 正文 0 字（4ms 空返回）
─────────────────────────────────────────────────
deepseek-v4.1-flash ✓ 正文 59 字     ✓ 正文 59 字
glm-5.3             ✓ 正文 74 字     ✓ 正文 74 字
hy4                 ✓ 正文 72 字     ✓ 正文 72 字
```

**根因**：这两个新模型建的时候 `mergeSystemIntoUser: false`，
于是带 `system` 的请求会发一条独立的 `role:'system'` 消息 —— 上游直接返回空。

**为什么"本机正常"**：GUI 自己的对话可能没带 system，或者走了不同的封装，
所以你测不出问题；一旦通过开放 API（几乎一定带 system）就立刻暴露。

**修复**：

```jsonc
"Qwen-3.8-Flash": {
  "timeoutMs": 20000,          // 原来是 10000，太短
  "retries": 2,                // 原来是 1
  "defaultReasoningEffort": "medium",   // 原来没配
  "mergeSystemIntoUser": true  // 原来是 false ← 关键
}
"GPT-6-Luna": {
  "retries": 2,
  "defaultReasoningEffort": "medium",
  "mergeSystemIntoUser": true  // 原来是 false ← 关键
}
```

**这条规则现在适用于全部 5 个模型**：

```
deepseek-v4.1-flash  mergeSystemIntoUser: true
glm-5.3              mergeSystemIntoUser: true
hy4                  mergeSystemIntoUser: true
Qwen-3.8-Flash       mergeSystemIntoUser: true
GPT-6-Luna           mergeSystemIntoUser: true
```

> ⚠ **新建任何模型时，先把 `mergeSystemIntoUser` 设为 `true`。**
> 这是踩过两次的坑（`hy4` 一次、`@deepai` 两个模型一次）。
> 症状统一是：面板/本机看着正常，开放 API 一调就空。

### 10.9.4d `#182`：默认开启 + 功能测试自动检测

#### `mergeSystemIntoUser` 到底做什么

它决定 **system 提示词怎么发给上游**：

| 值 | 发给上游的形状 |
|---|---|
| `false` | `[{role:'system', content:'你是助手'}, {role:'user', content:'你好'}]` |
| `true` | `[{role:'user', content:'你是助手\n\n你好'}]` |

**中转上游（`@deepai` / `@xdpool` / `@trae` …）很多不接受独立的 `role:'system'`**，
遇到就秒回空。这不是模型的问题，是**中转层模板**的问题 —— 而这些中转几乎是
同一套技术栈，所以**问题很普遍**。

实测三批：

```
hy4                  false → 92ms 空       true → 正常
Qwen-3.8-Flash       false → 4ms 空        true → 正常
GPT-6-Luna           false → 4ms 空        true → 正常
```

#### 改动一：默认值改为 `true`

```js
// custom-models.js
mergeSystemIntoUser: raw.mergeSystemIntoUser !== false,   // 原：=== true
```

**理由：**

1. 已踩过三批模型，说明"不支持独立 system"是**常态**而非例外；
2. `true` 在两种上游上都可用 —— 支持的照样接受"system 在 user 里"；
3. `false` 一旦碰上不支持的上游就是**静默空回答**，排查成本极高。

**代价**：system 从"系统级约束"降级成"用户消息里的前置说明"，语义略弱。
但这比返回空回答好得多。

**仍可手工关掉**（面板复选框），只是不再默认关。

#### 改动二：功能测试新增 `systemMerge` 项

在面板的「功能测试」里多了这一项，它**实测**两种消息形状：

```
A. 独立 system 消息 + user
B. system 文本拼进 user（不发 system 消息）
```

判据与结论：

| A | B | 结论 | 建议 |
|---|---|---|---|
| 空 | 有正文 | **必须 merge** | 自动写 `true` |
| 有正文 | 空 | 需要独立 system | 自动写 `false` |
| 有正文 | 有正文 | 两种都行 | 自动写 `true`（更抗变更） |
| 空 | 空 | 测不出来（可能限流） | **不写配置**，报 `unknown` |

**最后一行是刻意的**：两种都空时绝不能瞎改配置，那可能是限流或故障。

写回走 `applySystemMerge`（独立路径，因为这是**模型配置**而不是能力覆盖），
最终调用 `patchConfigOnce` 完成持久化。

#### 对新模型的意义

```
新建模型
  → 默认 mergeSystemIntoUser = true（改动一保底）
  → 点「功能测试」跑一次 systemMerge（改动二实测确认）
  → 需要的话自动写回配置
  → 仍可手工在面板勾选覆盖
```

**三层保障，忘不了也错不了。**

### 10.9.4e `#183`：不接受 \`role:'tool'\` 的上游

**症状**：工具第 2 轮（已带工具执行结果）返回空正文、`finish_reason: empty_completion`。

**实测（`Qwen-3.8-Flash` / `GPT-6-Luna` 都是这样）**：

```
变体1  role:'tool' 标准形状        → finish=empty_completion  正文 0 字  ❌
变体2  assistant 带 content 说明   → finish=empty_completion  正文 0 字  ❌
变体3  把结果写成普通文本           → finish=stop              正文 13 字  ✅「杭州天气多云，气温22℃。」
变体4  纯文本对照（无工具历史）     → finish=stop              正文 18 字  ✅
```

**所以不是网关 bug，是这两个上游不接受 `role:'tool'` 消息。**

**修法**：新增按模型开关 `toolResultAsText`。

```jsonc
"Qwen-3.8-Flash": { "toolResultAsText": true }
"GPT-6-Luna":     { "toolResultAsText": true }
```

开启后 `buildMessages` 把工具结果改写成：

```
assistant: 「我调用了工具 get_weather，返回结果：{"city":"杭州","temp":22,...}」
user:      「根据上面的工具返回结果，请直接回答我最初的问题。」
```

**代价**：不再走协议级工具回传（丢失并行工具支持、tool_call_id 关联）。
**收益**：从"完全不可用"变成"能用"。默认关闭，只给明确需要的模型打开。

**工具名如何拿到**：`tool` 轮只有 `callId`，名称从前面 assistant 轮的
`toolCalls` 里建 `callId → name` 映射。

#### 能力声明要与实测一致

`GPT-6-Luna` 原来在 `/v1/models` 里声明 `image=supported`，
但实测带图请求返回 `reasoning_only` 空产出。已改为 `unsupported`，
让网关**正确拒绝**而不是给用户一个空回答。

**声明错了比不支持更糟**：客户端会以为能用，结果拿到空内容却查不出原因。

### 10.9.4f `#184`：重复推送导致的死循环（最危险的一类 bug）

#### 症状

```
TheThe user is calling me out for not searc…
TheThe model output is weird — it emitte…
已搜索 14 次文件，执行 22 条命令   ← 反复刷屏
```

#### 根因

代码里 `pending.push(chunk)` 被**写了两遍**：

```js
pending.push(chunk)
pending.push(chunk)      // ← 多余
if (isSubstantiveChunk(chunk)) {
  committed = true
  for (const buffered of pending) yield buffered   // 同一帧吐两遍
}
```

#### 为什么后果这么严重

| 层面 | 表现 |
|---|---|
| 文本 | 客户端把两个 `The` 拼成 `TheThe` |
| **tool_calls** | 模型看到**两个一模一样的工具调用** → 执行一个发现还有一个 → 再调 → **无限循环** |
| 用户体验 | 「已搜索 14 次文件」反复刷屏，永远结束不了 |

#### 为什么测试没抓到

这类 bug 的特征是：**不报错、不崩溃、语法正确、逻辑看着也通**，只是输出翻倍。
原有的 53 套测试全部通过——因为没有一条检查"同一帧是否被发了两遍"。

#### 防复发

新增 `test-no-duplicate-frames.mjs`，8 项静态断言：

```
✓ 5 个文件都没有相邻重复的转发语句
✓ index.js 中 pending.push(chunk) 恰好 1 处
✓ 每处 yield pending 后都清空或立即 return
✓ 没有裸 res.write(frame)（应走 writeFrame）
```

**已自动纳入回归**（`.regress.mjs` 是目录扫描式，按 `test-*` 前缀自动收集）。

---

### 10.9.4g 全场景深度验收（`SCENARIO-V4.mjs`）

**129 项断言，覆盖：**

| 段 | 内容 |
|---|---|
| A | 鉴权（无 key / 假 key / health 免鉴权） |
| B | 5 模型 × 3 协议非流式 |
| C | 5 模型 × 3 协议流式（三种协议各有独立 SSE 解析器） |
| D | system 消息 5 种形状（仅 user / system+user / 多轮 / system+多轮 / 长历史） |
| E | 四档推理 + 非法档位 400 |
| F | 工具调用（含多轮闭环、tool_calls 不重复、流式） |
| G | 采样参数（temperature / stop / top_p / penalty） |
| H | 边界（未知模型 / 空 messages / 畸形 JSON / 超长） |
| I | 一致性（同请求 3 次） |
| J | 5 路并发 |
| K | 客户端取消后网关仍正常 |

**关键教训：三种协议的 SSE 结构完全不同。**

```
chat:        choices[0].delta.{content, reasoning_content, tool_calls}
anthropic:   type=content_block_delta, delta.{type:'text_delta', text}
             或 delta.{type:'thinking_delta', thinking}
             ⚠ content_block_start 里**也可能直接带初始文本**（漏了会少字）
responses:   type=response.output_text.delta / response.reasoning_summary_text.delta
```

用同一套解析器测三种协议，会出现**大量假失败**（表现为 `len: 0` 但实际有输出）。

**另一个坑：`max_tokens` 太小会被思考吃光。**
实测 `hy4` 在 `max_tokens: 100` 时思考用掉 86 token，
`finish_reason: max_tokens`，正文 0 字——这不是网关 bug，是预算问题。
**测试里用 300–800 才能稳定拿到正文。**

### 10.9.4h `#185`：流式 tool_calls 形状错误导致的死循环

#### 症状

```
打开网页 · www.bing.com/search?q=...   ✗
打开网页 · www.bilibili.com/...        ✗
思考 · The user is annoyed. I need to actually search...
打开网页 · www.bing.com/search?q=...   ✗   ← 又失败
已搜索 14 次文件，执行 22 条命令          ← 无限循环
```

**工具调用全部飘红 → 模型以为没成功 → 重试 → 再失败 → 永远循环。**

#### 根因

网关发出的流式 `tool_calls` **每一帧都带完整的 `id` + `type` + `name`**：

```
tour1 index=0 id="call_00_..." name="web_search" args=""
tour2 index=0 id="call_00_..." name="web_search" args="{\""
tour3 index=0 id="call_00_..." name="web_search" args="query"
tour4 index=0 id="call_00_..." name="web_search" args="\""
...
tour9 index=0 id="call_00_..." name="web_search" args="}"
```

**拼起来 arguments 是对的（`{"query": "今天新闻"}`），但每帧都声称自己是"一个完整的调用"。**

严格按 OpenAI 规范解析的客户端会**按帧建出 9 个独立调用**，每个拿到的参数都是残片：

| 客户端看到的调用 | arguments |
|---|---|
| 调用 1 | `""` |
| 调用 2 | `"{\""` |
| 调用 3 | `"query"` |
| 调用 4 | `"\""` |

**全部 JSON 解析失败 → 工具执行报错（红 X）→ 模型以为没成功 → 重试。**

#### OpenAI delta 规范

```jsonc
// 第一帧：带 id / type / name
{"index":0,"id":"call_00_xxx","type":"function","function":{"name":"web_search","arguments":""}}

// 后续帧：只给 arguments 增量
{"index":0,"function":{"arguments":"{\"query\""}}
{"index":0,"function":{"arguments":": \"今天新闻\"}"}}
```

**客户端靠同一个 `index` 把它们拼回一个调用。**

#### 修复

```js
const isFirstOfThisCall = index === undefined
const call = {
  index,
  ...(isFirstOfThisCall
    ? { id: ..., type: 'function', function: { name, arguments: delta } }
    : { function: { arguments: delta } }),   // ← 后续帧只给增量
}
```

#### 为什么之前测不出来

`SCENARIO-V4` 的 F3 只检查「有 tool_call delta」（`toolDeltas > 0`），
**没检查帧的字段形状**。工具"有反应"和"能被正确解析"是两件事。

新增 `test-toolcall-delta-shape.mjs`，7 项断言：

```
✓ 至少有一个 tool_call
✓ 首帧有 id
✓ 首帧有 name
✓ 后续帧 id 一致或省略
✓ 后续帧不带 name          ← 这次抓到的就是这条
✓ 拼接后的 arguments 是合法 JSON
✓ arguments 含 query 字段
```

**关键教训：验证"有输出"不等于验证"输出正确"。**

### 10.9.4i `#188`：空产出被伪装成成功

#### 症状

某模型上游彻底不可用时，客户端拿到：

```json
HTTP 200
{
  "choices": [{
    "message": { "role": "assistant", "content": null },
    "finish_reason": "empty_completion"
  }]
}
```

**客户端以为成功了，实际一个字都没拿到。**

#### 两个问题

**① `empty_completion` 不是合法的 `finish_reason`**

OpenAI 规范只允许：
```
stop / length / tool_calls / content_filter / function_call / null
```

严格的客户端遇到未知值可能**崩溃**；宽松的会当成"模型选择不回答"。

**② 返回 200 违反本插件铁律**

§10 开头的七条设计规则第 6 条：**空产出 ≠ 成功**。
但这里把连续 2 次重试都空的请求，以 200 正常返回。

#### 为什么必须改

用户侧表现（实测 `GPT-6.1-Sol`，0/8 成功率）：
- 界面上看到"模型不回答"
- 不知道是模型限制、限流、还是自己用错了
- 反复重试，消耗额度

**如果返回 503 + 明确错误码，客户端能：**
- 提示用户"服务暂时不可用，稍后重试"
- 自动切换备用模型
- 把真实原因记进日志

#### 修复

三个通道（chat / anthropic / responses）都加同一道拦截：

```js
const finishReason0 = finalBody?.choices?.[0]?.finish_reason
const textLen0 = (finalBody?.choices?.[0]?.message?.content ?? '').length
const hasToolCalls0 = (finalBody?.choices?.[0]?.message?.tool_calls ?? []).length > 0
if (finishReason0 === 'empty_completion' && textLen0 === 0 && !hasToolCalls0) {
  sendJson(res, 503, {
    error: {
      message: '...（上游返回了空内容：0 字、无工具调用）',
      type: 'server_error',
      code: 'upstream_empty_completion',
    },
  })
  return
}
```

**用 503 而不是 500**：这是上游暂时不可用，不是网关崩了。

#### 验证要点

| 场景 | 期望 |
|---|---|
| 有正文 | 200 |
| 只有 tool_calls | 200 |
| **全空** | **503 + `upstream_empty_completion`** |
| 流式全空 | 同样 503（在写头之前判定） |

### 10.9.4j 三套审计体系（离线 + 在线 + 静态）

经过 `#184`~`#188` 连续五个"输出格式不对"的 bug，建立了三层防线：

#### 第一层：离线回归 `57 套 / 1337 项`

```bash
cd .tmp/lan-fulltest && node .regress.mjs
```

目录扫描式（`test-*` / `smoke-*` / `simulate-*` / `check-*` 前缀自动收集）。
**不需要网关在线**，测纯逻辑、静态规则、格式约束。

#### 第二层：在线审计 `211 项`

```bash
node ONLINE-AUDIT.mjs
```

需要网关在跑 + 有效 Key。包含两套：

| 套件 | 项数 | 内容 |
|---|---|---|
| `CONTRACT-AUDIT.mjs` | 117 | **非流式**响应逐字段对照官方规范 |
| `STREAM-CONTRACT.mjs` | 94 | **流式** SSE 格式、事件顺序、`[DONE]` |

**CONTRACT-AUDIT 检查什么（逐字段）：**

```
OpenAI /v1/chat/completions：
  id 是字符串 / object=chat.completion / created 是数字 / model 是字符串
  choices 是非空数组 / choices[0].index=0 / message.role=assistant
  message.content 是字符串或 null
  finish_reason ∈ {stop, length, tool_calls, content_filter, function_call}
  usage.{prompt_tokens, completion_tokens, total_tokens} 都是数字

Anthropic /v1/messages：
  id / type=message / role=assistant / model
  content 是数组，每个 block.type ∈ {text, thinking, tool_use, redacted_thinking}
  text block 必须有 text 字段
  stop_reason ∈ {end_turn, max_tokens, stop_sequence, tool_use, pause_turn, refusal}

OpenAI /v1/responses：
  id / object=response / status ∈ {completed, incomplete, failed, in_progress}
  output 是数组，item.type ∈ {message, function_call, reasoning}
  message.content 是数组，block.type ∈ {output_text, refusal}

/v1/models：object=list / 每个 model 有 id/object/created/owned_by
错误响应：状态码正确 + error.message + error.type
响应头：content-type 正确、不含明文 key
```

**STREAM-CONTRACT 检查什么：**

```
OpenAI 流式：
  content-type=text/event-stream
  所有 data: 行是合法 JSON
  最后有 [DONE]
  chunk.object=chat.completion.chunk
  同一流内 id / model 一致
  有 finish_reason 帧

Anthropic 流式：
  event: 行与 data: 行配对且值一致
  事件序列以 message_start 开头、message_stop 结尾
  有 content_block_start / content_block_delta
  content_block_start 与 content_block_stop 数量相等

Responses 流式：
  有 response.created（首位）和 response.completed
  所有事件类型以 response. 开头

错误处理：
  未知模型 + stream:true → 404 JSON（不是 SSE）
```

#### 第三层：静态审计 `28 项`

```bash
cd .tmp/lan-fulltest && node test-undefined-vars.mjs
```

**专抓"运行时才炸"的问题**（`#188` 第一版就是这类）：

```
✓ 25 个文件语法正确
✓ 裸标识符检查（current / target / used2 / fo2 等）
✓ fail/failJson 的 type 参数合法（不能传自定义 code）
✓ sendJson(503) 后必须有 return（否则重复写响应）
```

---

### 10.9.4k 教训：验证"有输出" ≠ 验证"输出正确"

`#185`~`#188` 五个 bug 有一个共同模式：

| # | 我验证的 | 实际缺的 |
|---|---|---|
| #185 | tool_call delta 存在 | **字段形状**（每帧都带 id/name） |
| #187 | tool 消息存在 | **toolCallId 能被下游读到** |
| #188 | 有拦截逻辑 | **拦截后返回的状态码/错误体** |

**每次都只查了"有没有"，没查"对不对"。**

现在三套审计的分工：
- **离线**：逻辑正确性（不需要真实上游）
- **在线契约**：**输出格式正确性**（逐字段对照官方规范）
- **静态**：**代码可执行性**（未定义变量、参数位置、返回值）

**改任何网关代码后，三套都要跑。**

### 10.9.4l 压力与稳定性审计（19 项）

`STRESS-AUDIT.mjs` 覆盖前两套契约审计管不到的维度：

| 段 | 内容 | 判据 |
|---|---|---|
| 1 | **并发一致性** | 8 路不同请求，结果不串话（每个回答含自己的数字） |
| 2 | **状态污染** | 4 模型交替请求，响应 `model` 字段与请求一致 |
| 3 | **资源泄漏** | 连续 20 次请求，后 5 次延迟不劣化超过 3 倍 |
| 4 | **长对话** | 40 轮历史，能正确回忆第 20 轮内容 |
| 5 | **Unicode** | 中文 / emoji / 特殊符号 / 换行 / 超长单词 / JSON 字符 |
| 6 | **大体积** | 1MB 请求不导致 500（接受或明确拒绝都算通过） |
| 7 | **混合并发** | 4 模型 × 4 路同时打，无模型错配 |
| 8 | **快速取消** | 10 次连发即取消后，网关仍能正常服务 |

**实测结果：19 / 19 全部通过。**

#### 三套在线审计一起跑

```bash
node ONLINE-AUDIT.mjs
```

```
协议契约审计    117 passed / 0 failed  (30s)
流式契约审计     94 passed / 0 failed  (51s)
压力稳定审计     19 passed / 0 failed  (95s)

═══ 在线审计：230 项 / 0 失败 ═══
```

#### 完整验收数字

| 层 | 项数 | 状态 |
|---|---|---|
| 离线回归（逻辑） | 57 套 / **1337 项** | 0 失败 |
| 在线契约（格式） | **211 项** | 0 失败 |
| 在线压力（稳定性） | **19 项** | 0 失败 |
| 静态审计（可执行性） | **28 项** | 0 失败 |
| **合计** | **1595 项** | **0 失败** |

### 10.9.4m 长时间运行卡顿排查与优化（`#189` / `#190`）

#### 现象

插件跑久了之后，局域网请求变慢、面板操作发涩。

#### 排查方法

**代码级诊断**（`PERF-CODE-AUDIT.mjs`）逐项扫：

```
1. 无界集合（只加不删）
2. 每请求全量遍历（O(n²)）
3. 同步 I/O（阻塞事件循环）
4. 大对象深拷贝
5. 定时器/监听器未清理
6. 正则回溯风险
7. 文件大小（加载成本）
```

同时实测关键函数的真实耗时：

```
aggregate()  在 8.24 MB / 27,683 行账本上 → 134–162 ms
```

#### 找到的三个热点

**① `aggregate()` 无缓存（最严重）**

`usage/summary` 是设置面板的常驻 RPC，每次打开/切换粒度都全量流式扫描账本。
150 ms 的**同步**扫描会卡住事件循环，期间所有请求都要排队。

**修法**：按「文件大小 + mtime」缓存。

```js
const cacheKey = granularity + '|' + nowMs + '|' + ledgerFingerprint()
const cached = aggregateCache.get(granularity)
if (cached !== undefined && cached.key === cacheKey) return cached.value
```

**为什么用指纹而不是 TTL**：账本只在有调用时追加。没新调用时大小/mtime 不变 → 命中；
有新调用时 mtime 必变 → 自动失效。**语义精确，不会返回陈旧数据**。
TTL 反而更糟——刚记账后 5 秒内面板看到的是旧数字。

**效果：热调用 150 ms → 0–1 ms（提速 150 倍以上）。**

```
冷调用（首次）: 172ms
热调用 第2次:   1ms
热调用 第3次:   0ms
冷调用（monthly）: 222ms
热调用（monthly）: 1ms
```

**② `readLedgerLimitFromConfig()` 每请求读盘**

`recordUsage` 是每个请求的收尾路径，它每次都要 `readFileSync(config.json)` + `JSON.parse`。
单次 0.1–0.3 ms 不多，但它是**同步阻塞**的，高频并发下累积可观。

**修法**：按 config.json 的 mtime 缓存。

**③ `sweepTmp()` 不清子目录**

只处理 `info.isFile()`，子目录被无条件跳过。
实测 `data/tmp/lib-bak-archive-20261103/` 积了 37 个文件 / 2.57 MB，永远清不掉。

**修法**：子目录也按 mtime 判龄，`rm(full, { recursive: true })` 整棵删。

#### 已排查但确认**不是**问题的

| 项 | 结论 |
|---|---|
| 3 处 `setInterval` 心跳 | 都在 `finally` 里 `clearInterval`，无泄漏 |
| 事件监听器 `.on()` | 都是请求级（`req`/`res`/`stream`），随对象销毁 |
| `capabilities` 的 3 个 Map | 有 `invalidate()` 清理，且从文件加载、大小受限 |
| 面板 5 秒轮询 | 只拉 `loadBreaker` / `loadBackendHealth`（轻量），且有清理 |
| `media.js` / `attachments.js` 定时器 | 都有 `unref()` + `clearInterval` |

#### 优化后验收

```
离线回归：57 套 / 1330 项 / 0 失败
data 目录：11.05 MB → 8.48 MB（释放 2.57 MB）
```

### 10.9.4n 长时间运行内存高 / 整体卡顿（`#191`）

#### 现象

**不是 UI 卡，是整个 DSH 跑久了变慢、内存高。**

#### 实测数据

```
网关进程（PID 3172）起始 428 MB
→ 170 次请求后 563 MB
→ 峰值 958 MB（GC 前）
→ 60 秒后 548 MB（没回落到起始基线）
```

有涨有落说明 GC 在工作，但**基线被抬高了**。

#### 根因：附件回收从未生效

```jsonc
// 默认配置
"attachments": {
  "dryRun": true,        // ← 只记日志、不真删
  ...
}
```

实测后果：

| 指标 | 数值 |
|---|---|
| `.dsh/attachments` 文件数 | **2,042 个** |
| 占用磁盘 | **1.2 GB** |
| 账本条目 | 526 条 |
| 其中已释放待回收 | **524 条** |
| 实际仍在用 | **2 条** |

**21 天累积了 1.2 GB。** 每张发过的图片都永久留着，DSH 进程要持有全部元数据，
文件系统目录扫描也越来越慢 → 长时间运行后整体卡顿。

#### 为什么默认是 true

原设计是「观察期先看着，确认无误再手动关」。
但**观察期实际没人会回来关**，于是永久开着。

#### 修法

默认值改成 `false`：

```js
attachments: {
  dryRun: false,          // 原来 true
  reclaimDelayMs: 5 * 60 * 1000,
  sweepIntervalMs: 5 * 60 * 1000,
  checkSessionRefs: true,
}
```

**安全吗？** 已有四道闸门挡住误删：

| 闸门 | 作用 |
|---|---|
| ① `entry.reused === true` | 复用本机已有对象 → **永不删** |
| ② `refCount > 0` | 仍在被使用 → 跳过 |
| ③ `checkSessionRefs` | 本机会话仍引用 → 标记 `pinned` 跳过 |
| ④ `stillHot` 重检 | 删除前再确认一次（防扫描期间被重新引用） |

加上 `reclaimDelayMs` 5 分钟延迟，足够安全。

#### 部署后

重启一次，回收定时器（每 5 分钟一轮）会自动清掉积压的 1.2 GB。
想先观察的话可以在面板里把 dry-run 重新打开（`attachments/setDryRun`）。

#### 顺带确认：插件本身没有内存泄漏

| 检查项 | 结论 |
|---|---|
| 模块级可变集合 | 只有 `MODES`（常量）和 `aggregateCache`（按粒度 4 个 key） |
| 心跳 `setInterval` | 3 处都在 `finally` 里 `clearInterval` |
| 事件监听器 | 都是请求级（`req`/`res`/`stream`），随对象销毁 |
| `attachments.audit` | 有 500 条上限 |
| `capabilities` 的 3 个 Map | 有 `invalidate()` 清理 |

**内存高的主因是附件堆积，不是代码泄漏。**

### 10.9.4o `#192`：附件回收拖垮整个 DSH（最严重的性能 bug）

#### 现象

DSH 跑久了整体卡顿，不只是面板，**连对话都变慢**。

#### 实测数据

```
referencedByAnySession() 单次调用 = 2,286 ms
账本条目 = 526 条
→ 一轮 sweep ≈ 526 × 2.3s ≈ 20 分钟

而 sweep 的触发间隔 = 5 分钟
→ 上一轮还没跑完，下一轮又来了
→ 回收任务**永远在跑**，持续占满 I/O 与事件循环
```

**这就是「运行久了卡顿」的最大原因。**

#### 根因

`sweep()` 的循环里对**每条记录**都调一次会话引用检查：

```js
for (const entry of [...this.entries]) {
  ...
  if (checkSessions) {
    const referenced = await this.referencedByAnySession(entry.digest)  // ← 每次都全量扫描
  }
}
```

而 `referencedByAnySession` 每次都要：

1. 递归遍历 `~/.dsh/sessions`（141 个文件 / 296 MB）
2. 对每个 `.zstd` 文件**解压**
3. 在解压后的文本里找 `sha256:<digest>`

**526 条 × 2.3 秒 = 20 分钟。**

#### 修法：整轮只建一次索引

```js
// 一次性扫完，把所有被引用的 digest 收进 Set
const sessionRefs = await this.#buildSessionRefIndex()

// 循环里 O(1) 查表
const referenced = sessionRefs.has(String(entry.digest))
```

**效果：**

```
旧：526 × 2,286ms ≈ 1,202 秒
新：291 ms（一次性）
提速 4,132 倍
```

#### 顺带修：索引建不起来时不能默认"全可删"

```js
catch (error) {
  // 保守：本轮跳过所有回收，等下轮再试
  return { ...summary, skipped: this.entries.length, indexFailed: true }
}
```

**否则一次读盘失败就会误删仍在引用的图片。**

#### 另一个发现：pinned 标记是错的

实测 `#buildSessionRefIndex()` 在 sessions 里**提取不到任何 digest 引用**，
但账本里有 116 条被标记为 `pinned`。

说明那些 `pinned` 是**历史某轮的误判**（可能当时读取某文件失败，代码按"保守视为引用"处理）。
已清除这 116 条标记，现在 524 条 / 96.5 MB 全部可回收。

#### 实测验证（重启后）

```
第 4 分钟: 2042 文件 / 1,209.6 MB
第 5 分钟: 1518 文件 / 1,122.1 MB   ← 回收 524 个文件 / 87.5 MB
```

**回收一次成功，正好 524 条**（与账本可回收数一致）。
账本从 526 条 → **2 条**（都仍在用，正确保留）。

**一轮 sweep 占用率：**

```
修复前: 1,202 秒 / 每 5 分钟 → 占用率 >400%（永远在跑）
修复后:   276 毫秒 / 每 5 分钟 → 占用率 0.09%
提速:   4,355 倍
```

#### 加了一道安全兜底

实测当前环境 141 个会话文件里**确实没有任何** `attachment` / `sha256` 字样，
所以「全部无引用」是正确结论。

但假如将来 DSH 改了引用格式，我们的正则就一个都匹配不到 —— 那时
「全部无引用」是**假象**，照此回收会误删仍在用的图。

兜底逻辑：

```js
if (indexMeta.files > 0 && indexMeta.refs === 0) {
  this.#audit('notice: 扫描了 N 个会话文件但未提取到任何附件引用。' +
    '若刚发过图却被判为无引用，说明引用格式变了，请检查正则。')
}
```

**只记审计、不阻断回收**（当前环境确认安全），但留下可查的痕迹。

---

#### 关于 .dsh/attachments 的 1.2 GB

排查时发现磁盘 **1,209 MB**，但插件账本只记录 **97 MB**：

| 分类 | 数量 | 大小 |
|---|---|---|
| 插件账本内 | 526 条 | 97 MB |
| **孤儿文件** | **1,516 个** | **1,121 MB** |

**孤儿是 DSH 内核自己的 `dsh-attachment-local` 创建的**（内容寻址存储 `v1/objects`）。
查过该模块源码：**没有任何 GC / sweep / 配额机制**，只有单次写入的临时文件清理。

**插件无权也不该删别人的数据。** 如需清理这 1.1 GB，得在 DSH 层面解决
（或手工确认后删 `~/.dsh/attachments/v1/objects` 下不在任何会话里引用的对象）。

### 10.9.5 第三方客户端能识别推理等级吗

**能传，但看不到。** `/v1/models` 里网关提供了：

```json
{
  "reasoning_efforts": ["minimal","low","medium","max"],
  "supported_reasoning_efforts": ["minimal","low","medium","max"]
}
```

但**这不是 OpenAI 标准字段**，通用 SDK 不会读它。所以：

| 层面 | 情况 |
|---|---|
| `/v1/models` 声明了四档 | ✅ 网关提供了 |
| 标准 OpenAI SDK 会读 | ❌ 不认（非标准字段） |
| 直接传 `reasoning_effort` 参数 | ✅ **生效** |

**实测（不传 vs 传 low）**：

```
不传：
  hy4      contract=medium  served=xhigh   source=model-default
  glm      contract=medium  served=high    source=model-default

传 low：
  hy4      contract=low     served=medium  ✅ 生效
  glm      contract=low     served=high    ⚠ 该家词表只有 3 档，low 落在 high
```

**结论**：别人导入后界面里可能没有"推理等级"选择器，
但 API 里传 `reasoning_effort` 是有效的。`glm`/`deepseek` 传 `low` 落 `high`
是词表只有 3 档的物理限制，不是没识别。

现在改成：**还没产出任何内容时，发一个合法的空 content 帧**：

```json
data: {"choices":[{"delta":{"content":""}}]}
```

多数客户端收到它会刷新"正在输入"状态或重置空闲计时器。
一旦出过 text/reasoning/tool-call，`keepalive()` 自动回落为 `: ping`，
避免打断打字机动画。

实现：`protocol.js` 新增 `keepalive()` + `markContent()`，
`push()` 里遇到实质 chunk 就标记；三条流式路径的心跳都改用它。

---

真正能一眼看出问题的指标是 **chunk 的字节大小分布**：

```
模型/路径                     块数   平均块    最小块   最大块    判定
deepseek-v4.1-flash@xdpool    21   2,457    191   16,750   ⚠ 夹大块
deepseek-v4.1-flash（自定义）  19   3,891    190   16,748   ⚠ 夹大块
glm-5.3@xdpool                24   1,551    178    5,151   ✅
hy4free@xdpool               100   1,265    179    8,820   ✅
```

**`最小块 190 字节` 说明逐帧转发确实在发生** —— 网关没有攒满再发。
**但 `最大块 16,750 字节` 说明有些帧被 socket 写缓冲合并了。**

16 KB = Node socket 的默认写缓冲上限。`setNoDelay(true)`（`#165`）只关了 Nagle，
**没关写缓冲**。

**修法**：新增 `writeFrame()`，每帧写完立刻推：

```js
function writeFrame(res, frame) {
  if (res.writableEnded === true) return
  res.write(frame)
  try { res.flush?.() } catch {}
  try { res.socket?.uncork?.() } catch {}
}
```

六处 `res.write(frame)` 全部替换（chat / messages / responses 三条通道的
`translator.push` 与 `translator.end`）。

### 10.8.4 客户端看不见思考过程

网关照常发 `reasoning_content` 帧（DeepSeek 惯例字段）。若客户端只读
`delta.content` 而不读 `delta.reasoning_content`，思考阶段就是空白。

**这不是网关能修的**：把 reasoning 混进 content 会污染模型输出。
DSH 桌面版认这个字段（asar 里出现 10 次），第三方客户端不一定认。

### 10.5 识色测试要用 ≥128×128 的图

**踩过的坑**：用 32×32 的纯红 PNG 测 `hy4`，第一次回答「黄色」。
换成 128×128 后，红/蓝/绿三种颜色**全部答对**。

小图对多模态模型是有效但极难判读的输入。**测识色请用 ≥128×128**，
否则失败会被误认为网关问题。

### 10.6 造测试图不要手抄 base64

**踩过的坑**：手抄一段 base64 PNG 导致三个模型都返回
`400 invalid_request: Unsupported or malformed image data`，差点误判成"网关丢图"。

正确做法是用程序生成确定合法的 PNG（见 `color-check.mjs` 的 CRC32 + IHDR + IDAT 拼装）。

### 10.3 矩阵测试的 13 个场景

每个模型都跑：

| 场景 | 判据 |
|---|---|
| A 人设评语 | 有系统提示词时正文非空 |
| B 长上下文 3k | 能总结 |
| C 大输出 1000 / 3000 | 正文 ≥ 200 字 |
| D 工具调用 | 出 `tool_calls` 或如实标 `tool_markup_leaked` |
| E 多轮记忆 | 4 轮后仍记得关键信息 |
| F 四档推理 | 每档都出正文 |
| G 稳定 ×3 | 连打 3 次都成功 |

**判据比「200 就算过」严格得多**：`reasoning_only` 算失败（用户拿不到内容就是不可用）。

---

## 11. 已修复的问题清单

> 全部经过真机验证或单元测试。编号对应源码注释里的 `#xxx`。

### 输出与判空

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| **#144** | 彻底空产出伪装成 `stop` | 「有响应但没内容」 | 新增 `empty_completion` 态，判空在判推理之前 |
| **#152** | `reasoning_only` 当成功 | Qwen 4 次里 3 次空正文 | 降级成 `reasoning_only_empty`，可重试 |
| **#158** | 流式报 `Attempts: 0` | 客户端以为没请求上游 | 未尝试时不发该头 |

### 参数与限制

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| **#145** | `maxTokensCap: 8192` | 本地 128K 开放出去只剩 8K | 默认改 0（不封顶） |
| **#146** | `low`/`medium` 都落到 `high` | 推理档位设了没用 | `max`→末位、`minimal`→首位、`low`→floor、`medium`→round |
| **#147** | 上下文取**最小** | 1M 被砍成 960K | 改取 **max** |
| **#150** | `max_tokens` 全链单值 | 发到低上限绑定会失败/截断 | 每档挂 `maxOutput`，执行时取 `min()`（三通道） |
| **#151** | 超时 5s 太短 | Qwen 正常模型被误判挂掉 | 5s → 25s |
| **#157** | `reasoningEfforts` 白名单从未生效 | 面板设的档位和默认档是死的 | `resolveModel` 补传两个字段 |

### 能力与探针

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| **#142** | `unknown` 当 `unsupported` | hy4 带 tools 直接 400 | `unknown` 放行 + 标 `Unverified` 头 |
| **#147** | `pickNumber` 取 min | 见上 | 改 max |
| **#153** | 空回答触发冷却 | 一次失败让后续全降级 | 两种空回答豁免冷却 |

### 协议与装配

| # | 问题 | 症状 | 修法 |
|---|---|---|---|
| **#139** | `wantsTools` 未定义 | 所有 chat 500 | 从 `baseOptions` 现算 |
| **#140** | `buildMessages` 不返回 `tools` | 多轮后模型说「我没有工具」 | 从历史 `turn.toolCalls` 重建 |
| **#141** | 流式头在 flush 之后写 | chain/attempts 永远 null | 提前到 `flushHeaders()` 之前 |
| **#155** | `resolveModel` 漏传 `mergeSystemIntoUser` | hy4 见到 system 就返回空 | 补传字段 + 三通道接线 |
| **#156** | 推理档位只藏在 `x-lantern` | 客户端读不到、改不了档 | 顶层加三个兼容字段 |
| **#159** | 图片支持靠"静默空"拒绝，学不到 | `hy4` 标 `image=supported` 实际不支持 | 新增 `learnImageUnsupported()`，**并收紧判据避免误判**（见下） |
| **#160** | `off`/`none`/`disabled` 被当「最弱思考档」 | `minimal` 落到 `none`（关思考）→ 上游挂死 105 秒返空 | 分位池排除这三个开关词，只在整表仅剩开关时退回 |
| **#161** | 4 档池上 `low` 与 `minimal` 撞车；大词表上 `medium` 一律偏到 `high` | 四档只区分出 2–3 种 | 改为**均匀分段**（0 / 1/3 / 2/3 / 1），池 ≥4 档时四档全不同 |
| **#162** | 链上投票「一人一票」，被只有一档的绑定主导 | `hy4` 三绑定里两个只有 `["high"]`，把四档全压成 `high` | 票权改为**该后端词表档数**，词表丰富的绑定说话更算数 |
| **#163** | 单档词表时硬发一个词，冒充设置生效 | 用户选 `minimal` 拿到 `high` 且无提示 | 证据不足时**不下发档位**（`degraded`），让上游用默认 |
| **#164** | 内建画像的 `reasoning` 盖掉 DSH 权威的档位列表 | 画像只说"支持推理"、不带 efforts，导致链上词表读空 | 画像无 efforts 而权威有 → 用权威 |
| **#165** | **SSE 流式从没关过 TCP Nagle** | 短回答（<12KB）被攒成 1 包，客户端"转圈十几秒 → 全文突然出现" | 三条流式路径 `flushHeaders()` 后加 `res.socket.setNoDelay(true)` |
| **#166** | `authoritativeOf` 不处理 `resolveModelInfo` 返回 `null` | `info.inputModalities` 抛 TypeError，被调用方 `catch{}` 吞成空词表 | 显式判 `info === null \|\| typeof info !== 'object'` 时返回 `undefined` |
| **#167** | 认不出强度的私有词被**整体踢出**分位池 | 认不出的词直接丢弃，池只剩 1 档 | 认得出的不足表达时，把认不出的**按原位置并回**池子 |
| **#168** | 响应头把投票结果**覆盖**成链首的逐档词 | 投票算出 `low@1/5`，头里却报 `high` / `1/1`，四档看起来全落 `high` | 投票值留在 `X-Lantern-Effort-Served`；链首逐档值改叫 `X-Lantern-Effort-Head` |
| **#169** | 单档词表被算作「支持该契约档」并排到链首 | `mapLevelToBackend(['high'],'minimal')` 返回 `ok:true`，于是 `#1` 抢到请求、实际只发 `high` | `total <= 1` 时降为 `unknown`（候补，排链尾不剥夺资格），能区分档位的绑定优先 |
| **#170** | **（已回滚）** 曾收紧"必须显式声明工具才重建 tools" | 把 DSH 自己打挂：`EMPTY_RESPONSE: returned a completed response with no content`，手机端连续失败、重试到 2/5 | 回滚为"无条件重建"，只保留 `tool_choice:'none'` 一个例外 |
| **#171** | 心跳 15 秒一次，思考期界面纯空白 | 抓包实测：`deepseek` 首帧 16,508ms，唯一 ping 在 16,150ms —— 前 16 秒一无所有，用户以为卡死 | 三条流式路径心跳改为 **5 秒** |
| **#172** | `res.write()` 只进 socket 缓冲，没立刻推出 | 实测块大小**最小 190 字节、最大 16,750 字节**——逐帧转发在发生，但夹着 16KB 大块（Node socket 缓冲上限） | 新增 `writeFrame()`：每帧 `res.write` 后 `flush()` + `uncork()`；6 处调用全替换 |
| **#174** | **`mergeSystemIntoUser` 只有 `hy4` 是 `true`，其余三个是 `false`** | `role:'system'` 独立消息让上游攒包：带 system 的请求时段 1–4/20、静默 5,169ms；改成 `true` 后 15–18/20、静默 133ms | 四个模型全部改为 `mergeSystemIntoUser: true` |
| **#175** | 长时间无内容时只发 `: ping` 注释，客户端界面完全静止 | `Seed-2.1-Pro` 上游空白 **116 秒**后 43ms 内吐完 2,890 字；116 秒里用户只能认为卡死 | 新增 `translator.keepalive()`：未出内容时发**合法空 content 帧**，出过内容后回落为 `: ping` |
| **#179** | 图片负能力学习要求「只尝试一次」，多绑定模型永远学不到 | `hy4` 三个绑定带图请求全返回空（`att=3`），每次白跑 3 次上游、永远返回空正文，且不记负能力 | 改为「所有尝试都是 `empty_completion` 且无超时/限流/取消」即认定不支持 |
| **#180** | **「逐个实测」按绑定探测时仍发独立 system 消息** | 面板一列红字 `content.some is not a function`：`glm-5.3@xdpool` / `glm-5.3@trae` 报错，但 `sn-glm-5-3-flash@raccoon` / `glm-5.3-flashx@trae` 正常——**同模型不同绑定，有的报错有的正常** | 探针改为只发 user 消息（system 文本并入 user），与网关主路径一致 |
| **#180b** | 绑定探针「跑完没报错」就算通过，即使零输出 | 空产出也被判 `ok: true`，给绿灯骗人 | 要求 `ttftMs` 有值（真的收到了 text/reasoning 增量），否则报 `kind: 'empty'` |
| **#181** | **新增的 `@deepai` 模型 `mergeSystemIntoUser: false`** | 带 `system` 的请求 4ms 内返回空（`empty_completion`），只有纯 user 消息才正常——所以"本机测试正常、开放给用户就挂" | 配置改为 `true`（`Qwen-3.8-Flash` / `GPT-6-Luna`），并把 `retries` 从 1 提到 2 |
| **#182** | **`mergeSystemIntoUser` 默认 `false`，新模型必踩坑** | 每加一个新模型都要手工记得开这个开关，忘了就是"开放 API 一调就空"。已踩三批（`hy4` / `Qwen` / `GPT-6-Luna`） | ① 默认值改为 **`true`**（`raw.mergeSystemIntoUser !== false`）；② 功能测试新增 **`systemMerge`** 项，实测两种消息形状并**自动写回**配置 |
| **#183** | **部分上游不接受 `role:'tool'` 消息** | `Qwen-3.8-Flash` / `GPT-6-Luna` 拿到工具结果后一律返回空（`empty_completion`），三种标准写法全试过都空；把结果写成普通文本则正常 | 新增按模型开关 **`toolResultAsText`**：开启时把工具结果改写成"我调用了 X，返回 Y"的文本回述 + 一条 user 轮请它作答 |
| **#184** | **`pending.push(chunk)` 写了两次** | 每帧发两遍：文本重复（`TheThe`、`II`）、**tool_calls 重复导致死循环**（"已搜索 14 次文件"刷屏） | 删掉重复行；新增 `test-no-duplicate-frames.mjs`（8 项静态断言）防复发 |
| **#185** | **流式 tool_calls 每帧都带 id/type/name** | 客户端的每个工具调用都飘红（参数是残片、JSON 解析失败）→ 模型以为没成功 → **无限重试死循环**。截图表现："打开网页 ✗ ✗ ✗" 一直重复 | 遵循 OpenAI delta 规范：id/type/name 只在**该调用第一帧**出现，后续帧只送 arguments 增量；新增 test-toolcall-delta-shape.mjs |
| **#187** | **工具结果的 `toolCallId` 字段名不匹配**（死循环根因） | 模型完全看不到工具结果 → 以为没执行 → 无限重试。实测问模型「刚才工具返回了什么」，它答「刚才没有调用任何工具」 | `createToolResultMessage` 实际产出 `callId`，但 pi-ai 的 `toolResultOf` 读 `message.toolCallId` → `toolName=unknown` → 上游丢弃。修：两个字段都写；且 `tool_choice:none` 时仍下发最小 tools 定义 |
| **#188** | **耗尽尝试仍空产出时返回 200 + 非法 `finish_reason`** | `GPT-6.1-Sol` 上游挂掉时（实测 0/8），网关返回 `200 + {content:null, finish_reason:empty_completion}`。该值不是 OpenAI 合法值，客户端要么崩溃要么当成"模型没话说" | 三通道加硬拦截：全空 → **503 + `upstream_empty_completion`**，让客户端能重试/换模型 |
| **#189** | **`aggregate()` 每次全量扫描账本，无缓存** | 账本到 8.24 MB / 27,683 行时，一次聚合 **134–162 ms**；`usage/summary` 是面板常驻 RPC，每次同步扫描阻塞事件循环 → 局域网请求卡顿 | 加「文件大小 + mtime」缓存：账本没变直接返回，变了自动失效。**热调用 150ms → 0–1ms** |
| **#190** | **`readLedgerLimitFromConfig()` 每请求同步读 config.json** | 热点路径上每个请求都 `readFileSync` + `JSON.parse` 一次（0.1–0.3 ms），高频并发下累积成可见卡顿 | 按 config.json 的 mtime 缓存；配置改了自动失效 |
| **#190b** | **`sweepTmp()` 只清文件不清子目录** | `data/tmp/lib-bak-archive-20261103/` 积了 37 个文件 / **2.57 MB**，每次启动都「看见但不删」，永久占盘 | 子目录也按 mtime 判龄整棵删除 |
| **#191** | **`attachments.dryRun` 默认 `true`，回收从未生效** | 实测 `.dsh/attachments` 累积 **2,042 文件 / 1.2 GB**（21 天）；账本 526 条里 **524 条已释放却永回收**。DSH 进程要持有全部元数据 + 目录扫描变慢 → **长时间运行后内存高、整体卡顿** | 默认值改 `false`（真回收）；四道安全闸门已足够（reused 不删 / refCount>0 跳过 / 会话引用检查 / 删除前重新确认） |
| **#192** | **`sweep()` 对每条记录都重建会话索引** | `referencedByAnySession()` 每次递归扫 sessions 目录（141 文件 / 296 MB）+ 逐个 zstd 解压，**单次实测 2,286 ms**。526 条 → 一轮 **约 20 分钟**，而 sweep 每 5 分钟触发 → **永远在跑**，I/O 和事件循环被占满 → DSH 整体卡顿 | 整轮只建一次索引，循环里 O(1) 查表。**1,202 秒 → 291 ms（提速 4,132 倍）** |

### 测试脚手架（假绿）

| 测试 | 问题 | 修复后 |
|---|---|---|
| `test-effort-contract` | 断言用旧档名 `high` | 0 → **45 项** |
| `test-capability-summary` | 缺 `describeChainLevels` 注入 | 0 → **31 项** |
| `test-media-limits` | 缺 `log` 注入 | 0 → **30 项** |
| `test-patchconfig-live` | 缺 `LIMIT_SPEC` 注入 | 0 → **26 项** |

**测试项从 1131 增加到 1263（+132），全部真实通过。**

---

## 12. 已知边界与不支持的场景

### 12.1 无法做的事

| 项 | 原因 |
|---|---|
| **让客户端自动发现推理档位** | OpenAI 协议没有这个字段。只能多写几个位置碰运气 + 让客户手工填 |
| **跨绑定聚合 `maxOutputTokens`** | DSH 的 `llm` 服务只暴露 `resolveModelInfo()` 和 `stream()`，**没有枚举 API**，无法扫同名其它绑定 |
| **变出模型本身没有的能力** | 网关只保证「不丢信息」（工具定义、工具结果、档位、上下文），能力取决于上游 provider |
| **scalar 参数映射** | `temperature` / `top_p` / `max_tokens` 是标量，**只能钳制 + 如实报告**，无法「映射」 |

### 12.2 已全部验证的场景

| 场景 | 状态 |
|---|---|
| **图片输入（多模态）** | **已验证**：5 个模型正确识别 ≥128×128 纯色图（红/蓝/绿全对） |
| **生图 `/v1/images/generations`** | **已验证**：200 + 571,490 字节 PNG，签名 `89504e470d0a1a0a` 正确 |
| **生视频全流程** | **已验证**：202 → queued → in_progress(50%) → completed(100%)，169 秒；下载 2,903,855 字节 MP4，`ftyp` 校验正确 |
| **高并发压力** | **已验证**：20 路 × 3 轮 = 60 请求全部 200 |
| **长时浸泡** | **已验证**：15 分钟 × 4 并发 = 74 轮 296 请求，100% 成功，延迟漂移 0.0% |
| **工具调用多轮闭环** | **已验证**：`glm-5.3` 第 1 轮出 `tool_calls`、第 2 轮 `finish=stop` 正文 99 字 |
| **三协议** | **已验证**：chat / anthropic / responses 全部 200 |

### 12.25 仍未覆盖的

| 项 | 原因 |
|---|---|
| **多台物理设备并发** | 需要真实局域网内的多客户端，当前只能单机模拟（20 路并发已覆盖连接层） |
| **小时级（≥6h）浸泡** | 已做 15 分钟；更长时段需要挂机窗口，但 15 分钟的延迟漂移为 0，已无累积迹象 |
| **生图去水印** | 配置开关存在（`watermark_removed`），但默认关闭且未测过开启路径 |

### 12.28 `hy4` 的特殊行为（必须知道）

| 行为 | 证据 | 应对 |
|---|---|---|
| **不接受独立 system role** | 有 system → 92ms 空回答（att=5）；无 system → 10s 正常 | 打开 `mergeSystemIntoUser: true`（默认已开） |
| **图片可用，但慢且不稳** | 清空负能力记录后连测：152 字 / 249 字，均 `stop` | 无需特殊设置；若偶发空回答会自动重试（#152） |

#### ⚠ 一次真实的误判（教训记录）

第十五轮我加了「带图 + 彻底空 → 记 image 不支持」的学习（#159），
`hy4` 立刻被记成 `image=unsupported`。**但清掉记录后重测，它连两次成功。**

那次空回答是**并发槽紧张 + 首包超时**叠加造成的偶发 `empty_completion`，
与「支不支持图片」无关。**误记的代价很重**：闸门会永久拒绝该档的带图请求，
把真实可用的能力埋掉。

**收紧后的判据**（现在要求全部满足才记）：

1. 请求确实带了图片
2. `finish_reason === 'empty_completion'`（彻底空，非 `reasoning_only`）
3. **只有一次尝试**（`attempts.length === 1`）—— 重试过的空可能是副作用
4. **那一次不是 `backend_timeout`** —— 超时说明"来不及"，不代表"不愿意"
5. **那一次不是 429 / 503 / `rate_limited` / `busy`** —— 稍后就好，不是能力问题
6. **那一次不是客户端取消**（`aborted` / `canceled`）

**原则**：宁可不学（继续按 `unknown` 放行并标 `X-Lantern-Capability-Unverified`），
也不要错学（永久埋掉一个其实可用的能力）。

### 12.3 各模型的实际表现（2026-11-08 实测）

| 模型 | 首字延迟 | 四档区分 | 备注 |
|---|---|---|---|
| `deepseek-v4.1-flash` | 1.7–7.8s | 3 种落点 | 最稳 |
| `glm-5.3` | 2.7–8.5s | 3 种落点 | 大输出偶需重试 |
| `Seed-2.1-Pro` | 2.3–7.2s | — | 稳定 |
| `hy4` | 4.7–13.8s | — | **必须开 `mergeSystemIntoUser`** |
| `Qwen3.8-Flash` | 5.3–25s | — | 大输出偏慢，`#152` 后稳定 |

---

## 13. 故障排查

### 13.1 常见错误码

| 错误码 | HTTP | 含义 | 怎么办 |
|---|---|---|---|
| `model_not_found` | 404 | 模型名不在目录 | 检查自定义模型名拼写 |
| `capability_unsupported` | 400 | 硬不支持该能力 | 看 `X-Lantern-Dropped-Params` |
| `invalid_reasoning_effort` | 400 | 档位不在白名单 | 检查 `reasoningEfforts` |
| `rate_limited` | 429 | 超限流 | 等 `Retry-After` |
| `busy` | 503 | 并发槽满 | 等 `Retry-After` |
| `backend_timeout` | 504 | 首包超时 | 调大 `timeoutMs` |
| `lantern_internal` | 500 | 网关内部错误 | 看响应体里的 `X-Lantern-Internal-Frame` |

### 13.2 按症状查

**「有响应但没内容」**
→ 看 `finish_reason`：
- `empty_completion` = 上游真的什么都没给
- `reasoning_only` = 思考吃光预算（`#152` 会自动重试一次）
- `stop` + `content: null` = 不该出现，是 bug

**「模型说它没有工具」**
→ `#140` 已修（从历史重建工具定义）。如果还出现，检查请求里 `tools` 是否真的传了。

**「推理档位改不了」**
→ 客户端读不到 `/v1/models` 的顶层 `reasoning_efforts`。**让客户手工填四档**。

**「某个模型总是要重试」**
→ 看 `X-Lantern-Attempts`。若 ≥ 2：
- 首包慢 → 调大 `timeoutMs`
- 空回答 → `#152`/`#153` 已处理，若仍频繁说明上游不稳定

**「hy4 一用就空」**
→ 确认 `mergeSystemIntoUser: true` 且**已重启**。这个上游不接受独立 system role。

### 13.3 500 错误怎么定位

`LANTERN_DEBUG_ERRORS` 默认开启，500 会直接回显：

```json
{
  "error": {
    "message": "LANtern 内部错误：ReferenceError: xxx is not defined",
    "code": "lantern_internal"
  }
}
```

把 `message` 原文贴出来即可定位。

---

## 14. 安全边界（渗透面实测）

> 本节全部结论来自 2026-11-08 的真实请求实测（`pentest.mjs` 48 项 + `pentest2.mjs` 59 项），
> 不是推断。测试从三个视角打：**完全无 key** / **假 key** / **持有合法 key**。

### 14.1 结论一句话

**别人拿你的 OpenAI API，只能用你的模型；打不到你的服务器、文件、工具、管理面板。**

前提两条：**`customTools` 保持为空**、**`auth.allowAnonymous` 保持 false**。

### 14.2 无 key 时：所有业务端点 401

```
GET  /v1/models                 401 invalid_api_key
GET  /v1/tools                  401 invalid_api_key
POST /v1/tools/anything         401 invalid_api_key
POST /v1/images/generations     401 invalid_api_key
POST /v1/videos                 401 invalid_api_key
POST /v1/chat/completions       401 invalid_api_key
GET  /v1/media/models           401 invalid_api_key
GET  /v1/lantern/keys           401 invalid_api_key
POST /v1/lantern/config/set     401 invalid_api_key
```

**唯一免鉴权：`GET /v1/lantern/health`**，只返回三项：

```json
{"ok": true, "plugin": "dsh-lantern", "enabled": true}
```

全量诊断（provider 名、上游真实模型名、`data/media` 绝对路径、key 数量）
**只有本机 loopback 才能拿到**——源码 `index.js:3386-3394` 按 `remoteAddress` 判断，
`isMasked(current) || !fromLoopback` 时一律只回那三项。

**假 key 同样 401**，与无 key 无差别。

### 14.3 持 key 时：只能碰两个端点

```
GET /v1/models   200   模型目录（本来就该给客户看）
GET /v1/tools    200   {"data": []}   ← 空列表
```

**管理端点全部 404「未知端点」**：

```
GET  /v1/lantern/keys        404
GET  /v1/lantern/config      404
POST /v1/lantern/config/set  404
POST /v1/lantern/key/create  404
GET  /v1/usage               404
GET  /v1/ledger              404
GET  /api/lantern            404
GET  /rpc                    404
```

**管理功能走 DSH 的 RPC（面板内部通道），不暴露在 HTTP 上。**

### 14.4 工具调用：网关从不执行

这是最重要的一条。实测：让模型用 `read_file` 读 `C:/Windows/win.ini`：

```
status=200   2763ms
tool_calls=1   正文长度=0
模型返回：[{"name":"read_file","args":"{\"path\": \"C:/Windows/win.ini\"}"}]
响应中含 win.ini 内容?  ✅ 无
```

**`tool_calls` 是模型的"意图"，交给客户端。网关不执行任何 tools。**

客户端自定义 8 个危险函数名，全部只是被"回显"给客户端：

```
function=bash         → tool_calls=0
function=exec         → tool_calls=0
function=shell        → tool_calls=0
function=run_command  → tool_calls=1（仅返回，未执行）
function=read_file    → tool_calls=1（仅返回，未执行）
function=write_file   → tool_calls=0
function=fs_read      → tool_calls=0
function=os_exec      → tool_calls=0
```

**`tool_calls=1` 不是"执行了"。** 那是标准 OpenAI 语义：客户端拿到后自己决定做什么，
不做就什么都不会发生。

### 14.5 路径穿越：全部失败

```
/v1/media/files/../../../../Windows/win.ini        401（被鉴权拦住）
/v1/media/files/..%2f..%2f..%2fWindows%2fwin.ini   404 file_not_found
/v1/media/files/%2e%2e%2f%2e%2e%2fpackage.json     404 file_not_found
/v1/media/files/C%3A%5CWindows%5Cwin.ini           404 file_not_found
/v1/media/files/%                                  400 百分号编码非法
```

**token 是 `files.get(token)` 查表，不是拼路径。** 穿越符号只是当普通字符串，
查不到就 404，不会逃出 media 目录。

### 14.6 畸形输入：全部被拒，进程不崩

```
超长 model 名（8000 字符）   404 model_not_found
空 messages 数组             400 messages 不能为空数组
messages 不是数组            400 缺少 messages 字段（必须是数组）
SQL 注入当 model            404 模型未找到：'; DROP TABLE--
路径穿越当 model             404 模型未找到：../../../../etc/passwd
shell 元字符当 model          404 模型未找到：$(whoami)`id`;ls
深嵌套 JSON（200 层）        200 正常处理
tools 不是数组               200 忽略该字段
```

**model 名是查表匹配**，不是拼 SQL 也不是拼路径。传什么都是"查不到这个模型"。
打完 107 项攻击后 `health` 仍 200，`chat` 仍正常——**进程没被打崩**。

### 14.7 ⚠ 唯一的真实风险点：`customTools`

源码 `media.js:2586-2591`：

```js
const fixed = tool.params ?? {}
const callArgs = Object.keys(fixed).length === 0
  ? parsed.body                          // 客户端请求体原样
  : { ...fixed, ...(parsed.body ?? {}) } // 客户端能覆盖固定参数
outcome = await runTool(tool.tool, callArgs, timeoutMs)
```

**设计意图**：把本机某个 DSH 工具开放给局域网（注释原话："请求体原样交给宿主工具"）。

**后果**：

| `customTools` 内容 | 持 key 客户能做什么 |
|---|---|
| `[]`（空，**推荐**） | 什么也做不了，`POST /v1/tools/任意` 全 404 |
| 映射到 `read_file` | **读你服务器上任意文件** |
| 映射到 `bash` / `exec` | **在你服务器上执行任意命令** |
| 映射到生图 / 生视频工具 | 正常（这是该功能的用途） |

**这不是 bug，是这个功能的定位。** 但它决定了"能不能被渗透"。

**卖给客户时，`customTools` 必须保持 `[]`。**

### 14.8 安全配置检查清单

上线前逐条确认：

```jsonc
{
  "auth": { "allowAnonymous": false },   // 必须 false（否则无 key 也能用）
  "customTools": [],                     // 必须空（否则客户能调宿主工具）
  "exposure": { "maskTopology": true },  // 建议 true（不暴露 provider 名）
  "capabilities": { "expose": true }     // 保持 true；关掉只会少给信息
}
```

再确认：

- [ ] 监听地址按需：只给局域网就 `0.0.0.0`，只给本机就 `127.0.0.1`
- [ ] 每个客户一把独立 key（便于单独吊销，不共享）
- [ ] `perKeyRpm` / `perKeyTpm` 设了限（防单客户打爆额度）
- [ ] 定期检查 `data/keys.json`，停用不再使用的 key

### 14.9 安全测试可以自己复跑

```bash
node pentest.mjs    # 48 项：无 key / 假 key / 持 key / 路径穿越 / 管理端点 / 注入
node pentest2.mjs   # 59 项：tools 是否被执行 / 畸形输入 / 端点枚举 / 进程存活
```

判据：**所有业务端点无 key 必须 401；持 key 除 `/v1/models` 与 `/v1/tools` 外必须 404；路径穿越必须 404 而非返回文件内容。**

---

## 15. 安装、备份与升级

### 14.1 目录约定

```
<你的用户目录>\Desktop\1\dsh-lantern-backup\
├── (可分发内容由 GitHub Release 提供，不含 data/)
├── LANtern-完整备份-含data-<时间戳>.zip  ← 自己回滚用
```

### 14.2 升级流程

1. 解压新安装包
在 **设置 → 插件 → 添加插件** 粘贴 `https://github.com/5115qwq/dsh-lantern`（或 `github:5115qwq/dsh-lantern`），然后**完全退出 DSH（含托盘）再启动**。
   - 自动把旧 `dsh-lantern` 改名为 `.bak-<时间戳>`
   - 复制新文件
   - **保留旧 `data/`**（Key、用量、配置不丢）
3. 完全退出 DSH（含托盘）再启动
4. 跑 `.regress.mjs` 确认 52 套全过

### 14.3 回滚

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop\node_modules
Remove-Item dsh-lantern -Recurse -Force
Rename-Item dsh-lantern.bak-<时间戳> dsh-lantern
```

或解压 `LANtern-完整备份-含data-*.zip` 覆盖。

### 14.4 改了 `lib/*.js` 之后

**必须完全重启 DSH。** 这个插件没有热重载：`lib/` 的改动只在进程启动时加载。

---
