// reload-1793759772634
/**
 * dsh-lantern — LANtern（局域网模型灯塔）Host 半部。
 *
 * 把本机 DSH 已注册的**全部** AI 模型，以 OpenAI 兼容接口公开给局域网。
 *
 * 本阶段（P0/P1）实现：
 * 1. `GET /v1/models`           全量模型目录（全名制 `<model>@<slug>`）
 * 2. `GET /v1/lantern/health`   插件自检 + provider 可见性诊断
 *
 * 隔离纪律（设计方案 §7.6）：
 * - 只读复用 `ctx.llm`（listProviders/listModels），**不建会话、不注册工具**；
 * - 唯一写入位置是插件自己的 `data/`；
 * - **不用 `ctx.settings.installSection`**（会把命名空间段写进共享的 settings.yaml
 *   并在卸载后永久残留）；
 * - 默认 `enabled: false`，开启后才注册路由。
 *
 * 装配方式：插件自带 `cordis.patch.yml`（`dsh.bundle.patch`），
 * 因此 `dsh plugin remove` 一条命令即可彻底卸载，不留悬空装配行。
 *
 * @module dsh-lantern
 */
import { ModelDirectory, parsePublicName, publicNameOf } from './directory.js'
import { PATHS, appendJsonl, ensureDirs, readJson, sweepTmp, writeJson } from './storage.js'
import { KeyStore, extractCredential } from './auth.js'
import { buildMessages, maskSecrets } from './messages.js'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ListenManager, newListenId, normalizeEntries } from './listen.js'
import { installManagementRpc, probePort } from './rpc.js'
import { CapabilityResolver, VALUE, detectNegativeCapability } from './capabilities.js'
// 对外统一推理等级契约（第十轮）：四档 + 对照表 + 自适应。
// 把"各家的档位词表互不相同"这件事收敛到一处，见该模块文件头。
import {
  CONTRACT_LEVELS,
  DEFAULT_CONTRACT_LEVEL,
  describeChainLevels,
  effortNote,
  isContractLevel,
  mapLevelToBackend,
  rankOf,
  resolveChainLevel,
  supportedContractLevels,
  toContractLevel,
} from './effort-contract.js'
import { AttachmentLedger } from './attachments.js'
import { Breaker, createReservedGate, isRateLimitFailure } from './breaker.js'
// 后端健康记忆：让故障转移链「记得谁刚挂过」，避免每次请求都重付一次超时。
import { BackendHealth } from './backend-health.js'
// 自定义模型的规范化逻辑与 rpc.js 共用同一份实现（避免面板校验与请求解析分叉）
import { findCustomModel, isValidCustomModelName, normalizeCustomModels } from './custom-models.js'
// 自定义工具的规范化逻辑同上（Host / RPC / 前端三处共用一份判据）
import { recordUsage, toLedgerUsage } from './usage.js'
import { fingerprintOf } from './auth.js'
import {
  OpenAiAggregator,
  OpenAiStreamTranslator,
  describeAnthropicDroppedParams,
  describeDroppedParams,
  errorBody,
  newCompletionId,
  parseChatRequest,
  resolveAnthropicThinking,
  resolveReasoningEffort,
  validateChatRequest,
  validateResponsesRequest,
} from './protocol.js'
import {
  AnthropicAggregator,
  AnthropicStreamTranslator,
  anthropicError,
  newMessageId,
  parseAnthropicRequest,
  resolveAnthropicMaxTokens,
  validateAnthropicRequest,
} from './anthropic.js'
import {ResponsesAggregator,
  ResponsesStreamTranslator,
  newResponseId,
  parseResponsesRequest } from './responses.js'
// 统一调用契约（第十轮）：把“枚举型 / 能力型 / 标量型”三类参数差异分开处理。
// 推理档位只是枚举型的一个实例；标量型只能封顶 + 标注（不能映射）。
import { clipStopSequences, clampScalar, describeContracts, detectLeakedToolMarkup } from './call-contract.js'
// 对外暴露面：错误文案与错误体的脱敏（见 exposure.js 文件头）。
// 这个网关是"把多个上游聚合成一个名字"卖出去的，因此错误信息必须只说
// "你请求的那个名字现在怎么样"，不能说"我背后有哪几个 provider、哪个挂了"。
import {
  DEFAULT_EXPOSURE,
  isHintMasked,
  isMasked,
  isTopologyMasked,
  publicAllFailedError,
  publicAttempts,
  publicFailurePatch,
  publicMessage,
  publicModelRow,
  publicNoBackendError,
  publicUpstreamLabel,
} from './exposure.js'
// 后端的超时与重试参数（每个自定义模型可各自覆盖）
import { DEFAULT_BACKEND_RETRIES, DEFAULT_BACKEND_TIMEOUT_MS } from './custom-models.js'

export const name = 'dsh-lantern'

/** llm 是硬依赖；webServer / attachments 按需注入。 */
export const inject = ['llm']

/**
 * 默认监听条目：`reuse` 模式（复用 DSH 端口）。
 * 首次运行时写入 `data/config.json`，可在 设置 → LANtern → 状态与安全 里增删改。
 */
const DEFAULT_LISTEN_ENTRIES = Object.freeze([
  { id: 'listen_reuse', mode: 'reuse', bind: '0.0.0.0', enabled: true },
])

/** 默认配置（首次运行时写入 data/config.json）。 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  listenEntries: DEFAULT_LISTEN_ENTRIES,
  // 过滤（P16 / §4.4 + §7.3）：
  //   providers / models —— 黑名单（命中即不公开）
  //   allowedModels      —— 白名单（**非空时只公开其中的**；空 = 全部）
  filters: { providers: [], models: [], allowedModels: [] },
  protocol: { openai: true, anthropic: false, responses: false },
  // 跨域（CORS）。默认关闭——这是个**开门器**，默认开启等于默认允许任意网页
  // 拿着用户浏览器里的身份来打本机网关。
  //
  // 但必须**能开**：浏览器里的前端（自建控制台、网页版聊天、本地 HTML 工具）
  // 直接调本网关时，没有 CORS 头就连预检都过不去。之前完全没有这块代码，
  // 表现为 OPTIONS 返回 401 且无任何 access-control-* 头，用户只看到
  // "Failed to fetch"，查不出原因。
  //
  // 结构：{ enabled, allowOrigins: ['https://a.example', ...], allowCredentials, maxAgeSec }
  //   · allowOrigins 支持精确 origin 与 '*'（全体放行，与 allowCredentials 互斥）；
  //   · 只回**请求里真实的 Origin**，不回 '*'——通配符与凭证共存时浏览器会直接拒绝；
  //   · 预检（OPTIONS）**免鉴权**：浏览器在预检阶段不会带 Authorization。
  cors: { enabled: false, allowOrigins: [], allowCredentials: false, maxAgeSec: 600 },
  // 对外暴露面（脱敏）。
  //
  // 这个网关的核心价值是"把多个上游聚合成一个稳定的名字"。既然卖的是聚合，
  // 就不该把内部拓扑连带卖出去——错误响应里出现 provider 名、绑定名
  // （xxx@trae）、"请到 设置 → LANtern → 自定义模型 里检查绑定" 这类内容，
  // 对终端用户既无意义（他改不了），又等于把"你这套是拼起来的、
  // 背后有 trae / xdpool 几个账号"直接写在脸上。
  //
  // 两个开关分开，是因为它们是两类不同的泄露：
  //   maskTopology      —— 身份类：provider 名、绑定名、逐条失败原因
  //   maskInternalHints —— 指引类：指向本插件设置面板的那些句子
  // 有人可能愿意保留"去问服务商"，但绝不希望暴露 provider 名；反之亦然。
  //
  // 默认**全开**：这类开关默认漂移的后果是"以为藏了、其实全裸"，
  // 比不做还危险（见 customOnly 那段同样的论证）。
  exposure: { ...DEFAULT_EXPOSURE },
  auth: {
    format: 'sk',
    allowAnonymous: false,
    // #227：`rotateGraceHours` 已随「轮换」一起移除（Key 现在生成即永久、
    // 明文可随时查看，不需要"过渡期"）。老配置文件里残留的这一项会被
    // normalizeConfig 忽略，不影响使用。
  },
  limits: {
    maxConcurrent: 2,
    perKeyRpm: 30,
    // 每分钟**输出 token** 上限（P12）：并发与 RPM 拦不住"单个请求就很贵"
    perKeyTpm: 60_000,
    maxTokensCap: 0,
    maxBodyBytes: 4 * 1024 * 1024,
    requestTimeoutMs: 600_000,
    // 为本机 DSH 保留的并发槽（§7.3 第 7 条：本机优先）
    reserveForLocal: 1,
    // 熔断（§7.3 第 8 条）：上游连续限流 → 暂停 LAN 通道，保护本机
    breaker: {
      enabled: true,
      consecutiveRateLimits: 3,
      cooldownSec: 60,
    },
    // 后端健康记忆（故障转移的「记性」）。
    //
    // 解决的问题：链是 [A,B,C]，A 挂掉时每个请求都要先等满 A 的首包超时
    // 才切到 B——同一个已知故障被反复付费。但直接禁用 A 又不行：
    // 它可能几分钟后就恢复，禁用等于要人手动点回来。
    //
    // 所以这里的语义是**冷却 + 排位**，不是禁用：
    //   · 失败一次进冷却（默认 30 秒）；
    //   · 冷却期内该后端**排到链尾**（不删除，别人全挂时仍会试它）；
    //   · 冷却到期自动解除，回到用户配置的原位；
    //   · 连续失败冷却翻倍（上限 maxCooldownSec），一次成功清零。
    //
    // 为什么不默认关掉：这是纯粹的延迟优化，且失败时**没有副作用**
    // （链上一个都不少），默认开着才有人受益；嫌行为不可预期的人可以关。
    backendHealth: {
      enabled: true,
      cooldownSec: 30,
      maxCooldownSec: 300,
    },
  },
  allowImageInput: false,
  // 用量记账（P9）：只统计"经由本插件"的调用，落在插件自己的 data/usage.jsonl。
  usage: {
    enabled: true,
    // 报告重复点击的复用窗口（1 分钟，避免连点生成一堆报告）
    reuseWithinSec: 60,
    // 报告保留份数
    keepReports: 20,
    // 单文件超过此大小则滚动归档（字节）
    maxLedgerBytes: 16 * 1024 * 1024,
  },
  // 能力相关（P4）。测试默认**完整项、不减项**（设计文档 §6.5.10 已定案：
  // 该按钮本来也不常点，宁可测全）。
  capabilities: {
    expose: true,
    profiles: 'use-builtin',
    learnNegative: true,
    test: {
      items: ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image'],
      perItemTimeoutMs: 30_000,
    },
  },
  perfTest: { timeoutMs: 20_000 },
  // 附件账本（P8，设计文档 §7.5 档 B）。
  //
  // ── #191：`dryRun` 默认改成 **false**（真回收）──
  //
  // 原来默认 true（只记日志不真删），本意是"观察期先看着"。实际后果：
  //   · 实测 `.dsh/attachments` 累积到 **2,042 个文件 / 1.2 GB**（21 天）
  //   · 账本 `attachment-ledger.json` 里 **526 条**、其中 **524 条已释放却永不回收**
  //   · DSH 进程要持有全部元数据，文件系统目录扫描也越来越慢
  //   → 长时间运行后内存高、整体卡顿。用户感受是"插件跑久了 DSH 就慢了"。
  //
  // 真正的风险（误删还在用的图片）已经由 `sweep()` 里的**四道闸门**挡住：
  //   ① reused 对象永不删  ② refCount>0 跳过
  //   ③ 会话引用检查（checkSessionRefs）④ 删除前重新确认 stillHot
  // 观察期该结束了：默认关掉 dry-run，让回收真正生效。
  // 想继续观察的用户可以在面板里手动打开（attachments/setDryRun）。
  attachments: {
    dryRun: false,
    reclaimDelayMs: 5 * 60 * 1000,
    sweepIntervalMs: 5 * 60 * 1000,
    checkSessionRefs: true,
  },
  // 媒体转发（生图 / 生视频）。
  // 本插件不自己实现画图，而是把请求转给宿主里已注册的
  // 两条后端：(a) 宿主 workbuddy_draw_image / workbuddy_draw_video 工具；
  // (b) 直连上游 HTTP（lib/upstream-media.js，照抄 dsh-connect-workbuddy 的端点）。
  // 默认 auto：工具注册着就用工具，没注册（本机没开「允许模型自主生图/生视频」
  // 或没登录）就自动改走直连，媒体能力不再跟着宿主开关生死。
  // 产物落 data/media/，对外用 capability URL 暴露。
  media: {
    enabled: true,
    // 'auto' | 'tool' | 'direct'
    backend: 'auto',
    // 同时进行的生成任务上限（生视频很慢，串行更稳）
    maxConcurrent: 2,
    // 自定义工具（设置 → LANtern → 自定义工具，kind=其它）的并发上限。
    // **必须与 maxConcurrent 分开**：生视频一次要跑几分钟，共用 2 个槽时
    // 两个视频就能把所有工具调用打到 429（实测发生）。工具通常秒级返回，
    // 给宽一点不会伤害上游。
    maxConcurrentTools: 8,
    // 生图超时（毫秒）。WorkBuddy 内部是 180s，这里留些余量。
    imageTimeoutMs: 240_000,
    // 生视频超时（毫秒）。上游轮询上限 600s，再加余量。
    videoTimeoutMs: 660_000,
    // 自定义工具的硬超时（毫秒）。留空则沿用 imageTimeoutMs。
    // 单独一项是因为「工具卡死」和「图生成慢」是两件事，不该只能一起调。
    toolTimeoutMs: 240_000,
    // 产物 URL 有效期（秒），默认 6 小时
    fileTtlSec: 6 * 60 * 60,
    // 产物与视频任务的保底上限。
    //
    // 光有 TTL 不够：`fileTtlSec` 默认 6 小时且可配，一个放着不关的生图循环
    // 能在窗口内堆出成千上万个文件（磁盘 + Map 一起涨）；视频任务里卡在
    // in_progress 的那条永远不会被 TTL 收走。症状是「内存慢慢涨、磁盘莫名满」，
    // 跟生图生视频毫无关联，极难联想到是这个 —— 所以再加数量与总字节硬顶。
    // 淘汰一律按创建时间从旧到新（新的还在被客户端下载），在跑的视频不淘汰。
    maxFiles: 512,
    maxFileBytesTotal: 2 * 1024 * 1024 * 1024,
    maxJobs: 256,
    // 请求体上限（字节）。改图要带 data URL，比文本接口大得多。
    maxBodyBytes: 32 * 1024 * 1024,
    // 对外拼接产物 URL 用的基地址；留空则按请求头自动推断。
    publicBaseUrl: '',
    // 默认上游媒体模型（留空 = 用上游目录里的第一个）。
    //
    // 为什么要有它：本机每个区通常只有 1 个文生图 / 1 个视频模型，但账号
    // 开通新模型后目录会有第二项，那时"默认用哪个"就变成一个真实的选择。
    // 把选择权放在面板上（自定义工具页的内置媒体块），而不是藏在代码里，
    // 用户才可能自己换——这正是"生图生视频也该能被自定义调试"的最小落点。
    defaultImageModel: '',
    defaultVideoModel: '',
    // 默认上游媒体供应商（留空 = 按顺序取第一条可用，失败自动切下一家）。
    // 内置生图/生视频没有自己的表单（不是自定义工具），用户改它们路由的
    // 唯一落点就是这两个字段 + 供应商顺序——面板内置媒体块里直接编辑。
    defaultImageProvider: '',
    defaultVideoProvider: '',
    // 上游供应商（把"往哪家打、怎么打"从代码里搬到配置里）。
    //
    // 为什么不写死在代码里：早期实现把 WorkBuddy 的 host、端点路径、请求头、
    // 鉴权与响应形状全部硬编码，于是这个网关只能转卖这一家。想接
    // Replicate / fal / OpenAI Images / 自建的 OpenAI 兼容层，只能改源码重打包。
    // 现在每家是一条记录，面板上可增删改；executor='builtin' 的那条对应
    // 内置实现（凭证库、token 刷新、目录探测），其余走通用 HTTP 通路。
    //
    // 默认保留内置一家且启停为 true：老配置（没有这一段）必须先能跑起来，
    // 再谈自定义——否则升级即断服。
    providers: [
      {
        id: 'mp_builtin',
        name: 'builtin',
        display: '内置直连（WorkBuddy 账号）',
        executor: 'builtin',
        enabled: true,
        kinds: ['image', 'video'],
      },
    ],
  },
  // 自定义模型（虚拟模型名 + 多后端绑定 + 失败自动切换）。
  //
  // 解决的问题：客户端只能填一个模型名，但实际环境里经常希望
  // 「先用便宜快的，挂了/限流了自动换下一个」——这在客户端侧做不到。
  //
  // 结构：
  //   [{ id, name, display, bindings: ['<model>@<provider>', ...], enabled, createdAt }]
  // bindings **有序**：故障转移严格按数组顺序尝试，所以第一条是首选。
  customModels: [],
  // 只暴露自定义模型（customOnly）。
  //
  // 目的：让这个网关变成"只提供我配置好的几个虚拟模型"的封闭服务——
  // /v1/models 只列自定义模型，真实模型（deepseek-v4.1-flash@trae 之类）
  // 既不出现在目录里，也**不允许直接请求**（一律 404 model_not_found）。
  // 这样客户端看到什么就只能用什么，无法绕过自定义模型的故障转移链
  // 去点名某个具体后端（也就无法绕开你设定的优先级与成本控制）。
  //
  // 为什么默认开启：这是本项目**主打的用法**（把一堆摇摆的模型包装成
  // 一个稳定的名字）。若默认关闭，"只返回自定义模型"就只是句空话，
  // 客户端照样能列出并调用全部真实模型。
  //
  // 为什么不是"过滤 provider"：filters 只做可见性/可用性剔除，
  // 是用来"少给点模型"的；而这里的诉求是"**只认自定义名**"，
  // 二者语义不同，混用会让 filters 页面出现自相矛盾的提示。
  //
  // ⚠ 注意：自定义模型的 bindings 仍走真实模型，**不受此开关影响**——
  // 否则开关一开，自定义模型自己也失去后端了（见 resolveRealModel）。
  customOnly: true,
  // 自定义工具（把宿主工具包装成网关能力）。
  //
  // 与 customModels 是两件事：customModels 包装「对话模型」（多后端故障转移），
  // customTools 包装「工具」（能力接入 + 固定参数 + 拆分成多个对外名字）。
  //
  // 结构：
  //   [{ id, name, display, kind: 'image'|'video'|'other',
  //      tool: '<宿主工具名>', model: '<固定上游模型，空串=默认>',
  //      params: { ...固定参数 }, description, enabled, createdAt }]
  //
  // 暴露规则（见 custom-tools.js 文件头）：
  //   kind='image' → 可填在 /v1/images/generations|edits 的 model 里
  //   kind='video' → 可填在 /v1/videos 系列的 model 里
  //   kind='other' → 暴露成 POST /v1/tools/<name>
  //     其中 params 是固定参数（仅 kind='other' 有意义）：调用时先铺固定参数、
  //     再用客户端请求体覆盖同名键。很多宿主工具（抓取类要 token、查询类要 project_id）
  //     没有它就根本调不通，而这类值每次都一样，不该由客户端负责传。
  //
  // 默认空数组：不配置就没有任何自定义工具，行为与改造前完全一致
  // （媒体端点仍认 workbuddy-image / workbuddy-video 两个虚拟 id）。
  customTools: [],
})

/**
 * 把 `limits` 里的数值字段钳到**可工作的区间**。
 *
 * 为什么必须在这里做（而不是只在面板上拦）：面板是**众多写入方之一**，
 * `config/set` 是公开 RPC，任何人（包括脚本、旧版本面板、手改的 json）
 * 都可能写进 `perKeyRpm: 0`。而 `allowRate()` 里的判断是
 * `hits.length >= limit` —— `limit = 0` 时**恒为真**，于是该 Key 的每一次
 * 请求都 429，整条局域网通道瞬间全挂。
 *
 * 同理 `maxConcurrent: 0` 会让所有请求永远拿不到槽位，`maxTokensCap: 0`
 * 会把 `max_tokens` 压成 0 让上游必定报错。这些值都不该"能存进去"。
 *
 * 钳制而不是拒绝：写进来的是非法值时，用户的本意几乎总是"恢复默认/最小值"，
 * 直接报错会让"清空输入框"这个最常见的操作变成一次失败。
 *
 * @param limits - 合并后的 limits（可能含非法值）。
 * @returns 钳制后的新对象。
 */
// ⚠ LIMIT_SPEC 必须定义在**模块最前面**（在 withDefaults / normalizeLimits 之前）。
//
// 第十二轮我错把它写在 clampInt 之后（第 2400+ 行），而 `DEFAULT_CONFIG`
// 在模块顶层就调用了 `withDefaults({})` → 里面的 `normalizeLimits` 读
// `LIMIT_SPEC.maxTokensCap` → 那时 const 还处于 TDZ → **抛 ReferenceError**。
//
// 后果不是"某个功能不好使"，而是**整个插件加载失败**：
// 面板上直接显示 `原因: LIMIT_SPEC is not defined`，3080 端口根本不监听。
// 而 `node --check` 只能查语法，查不出 TDZ —— 这是本轮最该记住的教训。
const LIMIT_SPEC = Object.freeze({
  maxConcurrent: [1, 1024],
  perKeyRpm: [1, 10_000_000],
  perKeyTpm: [100, 100_000_000],
  // 0 = 不封顶（三条通道的语义），所以下界必须是 0
  maxTokensCap: [0, 10_000_000],
  reserveForLocal: [0, 1023],
  maxBodyBytes: [1024, 256 * 1024 * 1024],
  requestTimeoutMs: [1000, 86_400_000],
  maxConcurrentTools: [1, 1024],
})
function normalizeLimits(limits) {
  const src = limits !== null && typeof limits === 'object' ? limits : {}
  /** 取整并钳到 [min, max]；非数字 / NaN / Infinity 一律回落到 fallback。 */
  const int = (value, min, max, fallback) => {
    const number = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.max(min, Math.min(max, Math.trunc(number)))
  }
  return {
    ...src,
    maxConcurrent: int(src.maxConcurrent, LIMIT_SPEC.maxConcurrent[0], LIMIT_SPEC.maxConcurrent[1], 2),
    // 0 = "不许任何请求"，不是"不限制"。要"不限制"请填一个够大的数。
    perKeyRpm: int(src.perKeyRpm, LIMIT_SPEC.perKeyRpm[0], LIMIT_SPEC.perKeyRpm[1], 30),
    // tpm 的 0 在 breaker 里有专门守卫（tpm > 0 才计窗口），但存 0 仍然误导，
    // 统一成"最小有效额度"，与面板 min 一致。
    perKeyTpm: int(src.perKeyTpm, LIMIT_SPEC.perKeyTpm[0], LIMIT_SPEC.perKeyTpm[1], 60_000),
    // ⚠ maxTokensCap 的 **0 是合法值**，代表"不封顶"（第十二轮 #129）。
    //
    // 三条通道的取值逻辑都是 `Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined`
    // —— 也就是 0 → undefined → 不封顶。而这里原来写 `int(src.maxTokensCap, 1, …)`，
    // 把 0 强行改成 1：于是"不封顶"变成"每次最多 1 token"，
    // 表现为上游一律回 `max_tokens 超限` 或回答被截成一个字。
    // 下限放到 0，语义与执行侧对齐。
    // ⚠ 默认 **0 = 不封顶**（第十三轮 #145）。
    //
    // 原来默认 8192，后果是：用户本地能设 1M 上下文 / 128K 输出，
    // 但**经网关一过就被压成 8192** —— 调用方传 max_tokens:100000 静默变成 8192，
    // 只拿到一小段就断，看起来就是"功能用不了"。
    // 这不是"保守"，这是把上游能力阉割掉，而用户毫不知情。
    //
    // 真正的上限该由**上游自己**决定：它不支持就会报错，报错会进负能力学习。
    // 网关的职责是转发，不是替用户砍预算。
    // 需要限流的人可以显式把 maxTokensCap 设成具体数字。
    maxTokensCap: int(src.maxTokensCap, LIMIT_SPEC.maxTokensCap[0], LIMIT_SPEC.maxTokensCap[1], 0),
    // 0 是**合法**值（为本机保留 0 个槽），但上限要跟着 maxConcurrent 走。
    reserveForLocal: int(src.reserveForLocal, LIMIT_SPEC.reserveForLocal[0], LIMIT_SPEC.reserveForLocal[1], 1),
    maxBodyBytes: int(src.maxBodyBytes, LIMIT_SPEC.maxBodyBytes[0], LIMIT_SPEC.maxBodyBytes[1], 4 * 1024 * 1024),
    requestTimeoutMs: int(src.requestTimeoutMs, LIMIT_SPEC.requestTimeoutMs[0], LIMIT_SPEC.requestTimeoutMs[1], 600_000),
    maxConcurrentTools: int(src.maxConcurrentTools, 1, 1024, 8),
  }
}

/**
 * 合并用户配置与默认值（浅层 + 已知嵌套键，避免深合并的意外覆盖）。
 * @param raw - 磁盘上的配置对象。
 * @returns 生效配置。
 */
function withDefaults(raw) {
  const base = DEFAULT_CONFIG
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      ...base,
      listenEntries: base.listenEntries.map((e) => ({ ...e })),
      filters: { ...base.filters },
      protocol: { ...base.protocol },
      auth: { ...base.auth },
      cors: { ...base.cors, allowOrigins: [...base.cors.allowOrigins] },
      exposure: { ...base.exposure },
      usage: { ...base.usage },
      capabilities: { ...base.capabilities, test: { ...base.capabilities.test, items: [...base.capabilities.test.items] } },
      attachments: { ...base.attachments },
      // providers 是数组：必须**深拷贝**，否则多个配置实例共享同一个默认数组，
      // 面板改一家会让另一份配置跟着变（且看不出是谁改的）。
      media: { ...base.media, providers: base.media.providers.map((p) => ({ ...p, kinds: [...p.kinds] })) },
      customModels: [],
      customTools: [],
      customOnly: base.customOnly === true,
      // limits 里有嵌套对象（breaker / backendHealth），必须深合并一层，否则用户只改
      // breaker.cooldownSec 会把整个 breaker 段覆盖掉、丢掉 enabled/threshold。
      limits: normalizeLimits({
        ...base.limits,
        breaker: { ...base.limits.breaker },
        backendHealth: { ...base.limits.backendHealth },
      }),
    }
  }
  // 兼容早期只写 listen 对象的版本（迁移为 listenEntries）
  const migrated = Array.isArray(raw.listenEntries)
    ? raw.listenEntries
    : raw.listen !== undefined && typeof raw.listen === 'object'
      ? [{ id: 'listen_reuse', mode: raw.listen.mode ?? 'reuse', bind: raw.listen.bind ?? '0.0.0.0', ...(raw.listen.mode === 'standalone' ? { port: raw.listen.port } : {}), enabled: true }]
      : DEFAULT_LISTEN_ENTRIES
  return {
    ...base,
    ...raw,
    listenEntries: migrated.map((e) => ({ ...e })),
    filters: { ...base.filters, ...(raw.filters ?? {}) },
    protocol: { ...base.protocol, ...(raw.protocol ?? {}) },
    auth: { ...base.auth, ...(raw.auth ?? {}) },
    cors: {
      ...base.cors,
      ...(raw.cors ?? {}),
      // allowOrigins 是数组：必须**整体替换**（用户删掉的来源要真的消失），
      // 但保留 base 的默认值当它是非数组时（防止手改配置写成字符串）。
      allowOrigins: Array.isArray(raw.cors?.allowOrigins)
        ? raw.cors.allowOrigins.filter((o) => typeof o === 'string')
        : [...base.cors.allowOrigins],
    },
    exposure: {
      ...base.exposure,
      ...(raw.exposure ?? {}),
      // 逐项按"显式写 false 才关"处理：
      // 老配置没有这一节时要按默认（藏）走，不能因为 undefined !== false
      // 之外的花式判断把默认值翻转掉。
      maskTopology: raw.exposure?.maskTopology === false ? false : base.exposure.maskTopology === true,
      maskInternalHints:
        raw.exposure?.maskInternalHints === false ? false : base.exposure.maskInternalHints === true,
    },
    limits: normalizeLimits({
      ...base.limits,
      ...(raw.limits ?? {}),
      // breaker 深合并一层（见上）
      breaker: { ...base.limits.breaker, ...(raw.limits?.breaker ?? {}) },
      // 同理深合并：老配置里没有这一段，缺省必须落回默认参数而不是 undefined。
      backendHealth: { ...base.limits.backendHealth, ...(raw.limits?.backendHealth ?? {}) },
    }),
    usage: { ...base.usage, ...(raw.usage ?? {}) },
    capabilities: {
      ...base.capabilities,
      ...(raw.capabilities ?? {}),
      test: {
        ...base.capabilities.test,
        ...(raw.capabilities?.test ?? {}),
        ...(Array.isArray(raw.capabilities?.test?.items)
          ? { items: raw.capabilities.test.items }
          : { items: [...base.capabilities.test.items] }),
      },
    },
    perfTest: { ...base.perfTest, ...(raw.perfTest ?? {}) },
    attachments: { ...base.attachments, ...(raw.attachments ?? {}) },
    media: {
      ...base.media,
      ...(raw.media ?? {}),
      // providers 是数组：浅合并会让多份配置实例共享同一个默认数组，
      // 面板改一家就悄悄改到另一份上。有就用用户的（逐条拷贝），没有就拷贝默认。
      providers: Array.isArray(raw.media?.providers)
        ? raw.media.providers.map((p) => (p !== null && typeof p === 'object' ? { ...p } : p))
        : base.media.providers.map((p) => ({ ...p, kinds: [...p.kinds] })),
    },
    // 自定义模型：整体替换（不是按 name 合并）——用户在界面上删掉一条
    // 就必须真的消失，若做浅合并会"删不掉"。
    // 但要**深拷贝 bindings**，避免调用方改数组影响到配置对象。
    customModels: Array.isArray(raw.customModels)
      ? raw.customModels.map((m) => ({
          ...m,
          bindings: Array.isArray(m?.bindings) ? m.bindings.filter((b) => typeof b === 'string') : [],
        }))
      : [],
    // 自定义工具：同样整体替换（理由同 customModels——删掉的条目必须真的消失）。
    customTools: Array.isArray(raw.customTools) ? raw.customTools.map((t) => ({ ...t })) : [],
    // 只暴露自定义模型（见 DEFAULT_CONFIG 说明）。
    //
    // ⚠ 默认值必须跟随 DEFAULT_CONFIG（true），不能写成 `raw.customOnly === true`：
    // 老配置文件里没有这个键，那样写会让升级后**静默退回开放模式**，
    // 用户以为已经封闭了、实际全网可用——这是最危险的一类"默认值漂移"。
    // 因此判据是"显式写 false 才关"，其余一律按默认开。
    // （也不接受字符串 "false"：那会被当成真值，导致"想关却关不掉"。）
    customOnly: raw.customOnly === false ? false : base.customOnly === true,
  }
}

/**
 * 本机信任围墙：只接受回环地址、且非跨站的请求。
 * 与 harness 自带闸门同一判据（有 `connection` 服务时优先用它）。
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function browserTrustRejection(headers) {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  const h = hostUrl.hostname
  const loopback =
    h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  if (!loopback) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 发送 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 序列化的响应体。
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 读取请求体（有体积上限，超限即拒绝——不无界缓冲）。
 * @param req - Node 请求对象。
 * @param maxBytes - 上限字节数。
 * @returns `{ ok, body?, reason? }`。
 */
async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  let overflow = false
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size > maxBytes) {
        overflow = true
        return // 继续消费但不再累积，避免破坏连接
      }
      if (chunk !== undefined) chunks.push(chunk)
    })
    req.on('end', resolve)
    req.on('error', resolve)
  })
  if (overflow) return { ok: false, reason: 'too_large' }
  if (chunks.length === 0) return { ok: true, body: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_object' }
    }
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
}

/**
 * 把一个绑定字符串解析成真实的后端目标。
 *
 * 绑定支持两种写法：
 * - 公开名 <model>@<provider>（推荐，无歧义）
 * - 裸模型名 <model>（走和普通请求一样的宽松路由）
 *
 * @param directory - 模型目录。
 * @param binding - 绑定字符串。
 * @returns 解析结果；不可用时为 { error, binding, reason }。
 */
function resolveBinding(directory, binding, cfg) {
  // ⚠ 必须用 resolveRealModel（**不受 customOnly 影响**）：
  // 绑定的本来就是真实模型，若走 resolveModel，一旦开启"只暴露自定义模型"，
  // 自定义模型自己就会失去所有后端——自己把自己的底座关掉了。
  const target = resolveRealModel(directory, binding)
  if (target.error !== undefined || target.provider === undefined) {
    return { error: 'binding_not_found', binding, reason: '模型未找到（可能 provider 已卸载或模型已下线）' }
  }
  if (directory.isProviderLive(target.provider) !== true) {
    return { error: 'binding_offline', binding, reason: 'provider「' + target.provider + '」当前未注册' }
  }
  // 存在性硬校验：任意字符串 + @ + 已注册 slug 也能通过公开名拆解，
  // 若不回查目录，拼错的模型名会被当成"可用后端"，于是本该 503 的请求
  // 变成一路试到上游才失败——错误被推迟且文案对用户毫无指向性。
  const entry = directory.list().find((e) => e.provider === target.provider && e.model === target.model)
  if (entry === undefined) {
    return {
      error: 'binding_not_found',
      binding,
      reason: '模型「' + target.model + '」不在 provider「' + target.provider + '」的模型列表中（可能名称拼错或模型已下线）',
    }
  }
  return { ...target, providerName: entry.providerName, name: entry.name }
}

/**
 * 解析**真实模型**（不认自定义模型、不受 customOnly 影响）。
 *
 * 单独拆出来的原因有两个，缺一不可：
 * 1. 绑定的解析（resolveBinding）必须走这条路——绑定项本身是真实模型；
 * 2. customOnly 开启时，真实模型对外一律无效，但**内部仍要能解析**，
 *    否则自定义模型会失去后端。
 *
 * @param directory - 模型目录。
 * @param name - 公开名或裸模型名。
 * @returns 条目，或 `{ error }`。
 */
function resolveRealModel(directory, name) {
  const strict = directory.resolve(name)
  if (strict !== undefined) return strict

  const parsed = parsePublicName(name)
  if (parsed !== undefined) {
    const providerId = directory.providerBySlug(parsed.slug)
    // ⚠ 回退路径也**必须过过滤**（P16）：
    // 否则被排除的模型虽然不出现在 /v1/models，却仍能被直接调用——
    // 过滤就只剩"看不见"，而设计目的（§7.3）是"不能用"
    // （排除关键账号所在的 provider、只公开便宜/不怕刷的模型）。
    if (
      providerId !== undefined &&
      directory.isProviderLive(providerId) &&
      directory.isPubliclyAllowed?.(providerId, parsed.model) !== false
    ) {
      return {
        publicName: name,
        provider: providerId,
        providerName: providerId,
        slug: parsed.slug,
        model: parsed.model,
        name: parsed.model,
      }
    }
  }
  // 宽松路由（§4.3 扩展）：客户端只填裸模型名（不带 `@provider` 后缀）时按模型 id 反查。
  // 同样必须过 P16 过滤——过滤的目的是"不能用"，不只是"看不见"。
  const loose = directory.resolveByModelId?.(name)
  if (
    loose !== undefined &&
    directory.isProviderLive(loose.provider) &&
    directory.isPubliclyAllowed?.(loose.provider, loose.model) !== false
  ) {
    // 回显客户端传来的原始名，避免客户端在响应里看到不认识的 model 字段
    return { ...loose, publicName: String(name) }
  }
  return { error: 'model_not_found' }
}

function resolveModel(directory, name, cfg) {
  // ① 自定义模型优先：它是用户显式创建的虚拟名，必须盖过任何同名真实模型
  //    （否则用户建了个叫 hy3 的自定义模型却永远打不到——可预期性优先）。
  const custom = findCustomModel(cfg, name)
  if (custom !== undefined) {
    return {
      custom: true,
      customId: custom.id,
      customName: custom.name,
      publicName: custom.name,
      display: custom.display,
      bindings: custom.bindings,
      // 调优参数随解析结果一起带出去：故障转移引擎需要用它们决定
      // 「等多久算超时」「最多再补几次」。放在这里而不是让引擎回查配置，
      // 是因为一次请求只解析一次模型，回查等于把同一份查找做两遍。
      timeoutMs: custom.timeoutMs,
      retries: custom.retries,
      // system 合并开关（第十四轮 #155，第十七轮 #182 改默认语义）。
      //
      // ⚠ 这个字段必须跟着解析结果一起带出去 —— 原来漏了它，
      // buildMessages 收到的永远是 undefined，于是"给 hy4 打开了开关"
      // 也完全没效果（实测：改配置后 att 仍是 5、仍是空回答）。
      //
      // #182：判断从 `=== true` 改成 `!== false`，与 custom-models.js 的
      // 新默认值保持一致。两处不一致会让"默认开启"在运行时又变回关闭。
      mergeSystemIntoUser: custom.mergeSystemIntoUser !== false,
      // 工具结果改写成文本（第十七轮 #183）。
      // 部分上游不接受 role:'tool'，需要这个开关降级。
      toolResultAsText: custom.toolResultAsText === true,
      // 推理档位的按模型配置（第十四轮 #157）。
      //
      // ⚠ 同样是"配置里有、但没传出去"的漏口：
      // `effortOptsOf` 读的是 `target.reasoningEfforts` /
      // `target.defaultReasoningEffort`，而这里从来没带过这两项，
      // 于是第十轮做的"按模型白名单 + 默认档"（#118）**一直是失效的**：
      //   · 传不在白名单里的档不会被 400 拦住；
      //   · 不传档时也不会用配置的默认档。
      // 补上之后面板上那两项才会真正生效。
      reasoningEfforts: custom.reasoningEfforts,
      defaultReasoningEffort: custom.defaultReasoningEffort,
    }
  }

  // ② 只暴露自定义模型时，真实模型**对外一律无效**。
  //
  //    必须是"解析层拒绝"而不是"只在 /v1/models 里隐藏"：
  //    过滤只做可见性剔除时，知道公开名的人仍能直接调用——
  //    那不叫封闭服务，只叫目录看不见（§7.3 的老教训）。
  if (cfg?.customOnly === true) {
    return { error: 'model_not_found', customOnly: true }
  }

  return resolveRealModel(directory, name)
}

/**
 * 判断一个流 chunk 是否代表「已经产出实质内容」。
 *
 * 故障转移的铁律：**只有在还没向客户端送出任何实质内容时**才允许换后端。
 * 一旦已经吐了文字/推理/工具调用，换后端就等于两段不同模型的输出拼在一起，
 * 对客户端来说是静默数据损坏——宁可如实报错，也不能伪造一个"看起来完整"的回答。
 *
 * 注意 usage chunk 不算实质内容：它通常在流末尾，本身不构成可读输出，
 * 因此用它之前的失败仍可安全切换。
 *
 * @param chunk - DSH StreamChunk。
 * @returns 是否已产出实质内容。
 */
function isSubstantiveChunk(chunk) {
  switch (chunk?.type) {
    case 'text-delta':
      return typeof chunk.text === 'string' && chunk.text.length > 0
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text.length > 0
    case 'tool-call-delta':
      return true
    case 'finish':
      // ⚠ 这里曾经返回 true（"收尾 = 这一轮结束了 = 可提交"）。那是错的：
      // 一个**零内容**的 finish 会把 committed 置真，于是"空回答"被当成已提交、
      // 再也不能换后端，客户端最终收到 200 + 空正文 + finish_reason:stop。
      // 上游限流静默 / 风控静默 / 适配器吞掉失败时会给出这种流。
      // 现在只有真正的 text/reasoning/tool-call 才算产出；纯 finish 不算，
      // 由调用处判空后换后端（见 streamWithFailover 的 empty_completion 分支）。
      return false
    default:
      return false
  }
}

/**
 * 把自定义模型的 bindings 展开成可执行的后端计划列表。
 *
 * 普通模型返回单元素数组（故障转移退化为直连，行为与改造前完全一致）。
 *
 * @param directory - 模型目录。
 * @param target - resolveModel 的结果。
 * @returns { plans, skipped }；skipped 记录解析不出来的绑定（供响应头如实告知）。
 */
function buildFailoverPlans(directory, target, cfg) {
  // ── #234：每个 plan 挂上「用户请求的模型名」──
  //
  // 为什么需要它：账本的 `publicName` 记的是 **plan.publicName**，
  // 也就是**上游真实坐标**（如 `deepseek-v4.1-flash@trae`）。用户删掉自定义模型、
  // 或者想知道"我这个 deepseek 模型一共花了多少"时，这个坐标对不上他的心智。
  //
  // 但 `publicName` 不能直接改语义 —— 老账本 29,847 行里它都是真实坐标，
  // 改了会让新旧记录混成两种含义，聚合时无法区分。
  // 所以**新增一个字段** `requestedModel`（用户请求名），publicName 保持不变。
  //
  // 在这里挂是最省的：三个 handler 各自只调一次 buildFailoverPlans，
  // 而 recordCall 有 12 个调用点 —— 挂 plan 上就不用改那 12 处。
  const requestedModel = target.publicName
  if (target.custom !== true) {
    return {
      plans: [{
        binding: target.publicName,
        provider: target.provider,
        model: target.model,
        publicName: target.publicName,
        requestedModel,
      }],
      skipped: [],
    }
  }
  const plans = []
  const skipped = []
  for (const binding of target.bindings ?? []) {
    const resolved = resolveBinding(directory, binding, cfg)
    if (resolved.error !== undefined) {
      skipped.push({ binding, reason: resolved.reason })
      continue
    }
    plans.push({
      binding,
      provider: resolved.provider,
      model: resolved.model,
      publicName: resolved.publicName ?? binding,
      customName: target.customName,
      requestedModel,
    })
  }
  return { plans, skipped }
}

/**
 * 取出本次请求到底该给上游下发哪个档位词 —— 第十轮的统一四档契约入口。
 *
 * 这个函数是"外面统一设置推理等级，里面按对照表落地"的实现处。三条协议
 * （chat 的 `reasoning_effort` / anthropic 的 `thinking` / responses 的
 * `reasoning.effort`）都必须过这里，否则迟早分叉成"一条严、一条松"。
 *
 * ## 输入
 * - `deps`：需 `capabilities.describe()`（拿每档真实词表）。
 * - `plans`：**已经过能力闸门筛过的**链（不叫它为候选：筛后才是真候选）。
 * - `requested`：客户端给的原始值。可以是四档之一，也可以是某家的真实词
 *   （`xhigh` / `light` / `off` …）—— 都能被归一化。
 * - `hasThinking`（anthropic 专用）：客户端是否明确点了"开/关思考"。
 *
 * ## 输出（全部字段都要被调用方用上，少一个就是静默失真）
 * ```js
 * {
 *   word?: string,           // 真实下发的词；undefined = 不传 reasoningEffort
 *   contract?: string,       // 四档之一（回显给客户端）
 *   error?: { message, allowed },  // 非法值 → 400
 *   headers: Record<string,string>,  // 三个 X-Lantern-Effort-* 头
 *   servedEffort?: string,   // 这次实际用的真实词（与 word 同值，语义更清楚）
 * }
 * ```
 *
 * ## 三态语义（与能力闸门完全一致）
 * - `native`   → 有后端能同义兑现，直给；
 * - `fallback`  → 没人能同义兑现，用词表里最接近的；**必须写头说明**；
 * - `degraded`  → 整条链没人声明推理词表，**不下发**参数（用户要的"没一个支持"）。
 *
 * 注意 `degraded` **不是错误**：不会思考的模型收到推理档位本来也只能忽略它。
 * 拒绝反而会让"这个客户端只发四档"的调用方彻底用不了这类模型。
 *
 * @param {object} deps - 转发依赖。
 * @param {Array<object>} plans - 已筛过的后端链。
 * @param {unknown} requested - 客户端原始值。
 * @param {{ treatOffAsMinimal?: boolean }} [opts] - `treatOffAsMinimal` 用于 anthropic 的 `thinking.type=disabled`。
 * @returns {{ word?: string, contract?: string, error?: { message: string, allowed: string[] }, headers: Record<string,string>, resolved?: object }}
 */
async function resolveEffortForChain(deps, plans, requested, opts = {}) {
  const headers = {}
  // ── 按模型的白名单与默认档（第十轮 #118）──
  //
  // 用户反馈"推理等级不能设置、不能自定义"，指的就是这两个字段之前不存在：
  // 管理员没有任何地方规定"这个模型只开放 minimal/low"或"默认 high"。
  //
  //   · `reasoningEfforts`（白名单）：非空时只允许其中的档；传了不在列表里的 → 400。
  //   · `defaultReasoningEffort`：调用方**完全不传**时用它（不再是"不干预"）。
  //
  // 两者都来自 `target`（自定义模型的条目），普通模型没有这两个字段。
  const allowList = Array.isArray(opts.allowedLevels) && opts.allowedLevels.length > 0
    ? CONTRACT_LEVELS.filter((lv) => opts.allowedLevels.includes(lv))
    : undefined
  const defaultLevel = typeof opts.defaultLevel === 'string' ? opts.defaultLevel : undefined

  // ⚠ 未传档位时：有按模型的默认档就用它，否则什么都不做。
  //
  // "什么都不做"这条早退是不可省的：绝大多数客户端（OpenAI SDK 默认调用、
  // 所有只带 stop / temperature 的请求）根本不传 reasoning_effort，
  // 把它们送进 toContractLevel 会得到 undefined 并被当成"非法值"判 400。
  // 第十轮第一版就是这么把 chat / responses 两条通道全打死的。
  if (requested === undefined || requested === null || (typeof requested === 'string' && requested.trim().length === 0)) {
    if (defaultLevel === undefined) return { word: undefined, headers }
    // 有默认档：只有当它确实被允许时才用
    const dflt = toContractLevel(defaultLevel)
    if (dflt === undefined || (allowList !== undefined && !allowList.includes(dflt))) {
      return { word: undefined, headers }
    }
    headers['X-Lantern-Effort-Contract'] = dflt
    headers['X-Lantern-Effort-Source'] = 'model-default'
    const byDefault = await resolveChainWordFor(deps, plans, dflt)
    if (byDefault.word !== undefined) headers['X-Lantern-Effort-Served'] = byDefault.word
    const note = effortNote(byDefault.resolved)
    if (note !== undefined) headers['X-Lantern-Effort-Note'] = note
    return { word: byDefault.word, contract: dflt, headers, resolved: byDefault.resolved }
  }

  // 先把"客户端给的东西"归一成契约档；认不出就 400 并给可选值。
  const contract = toContractLevel(requested)
  if (contract === undefined) {
    return {
      error: {
        message: `reasoning_effort「${String(requested)}」不是可识别的推理等级。可选值：${(allowList ?? CONTRACT_LEVELS).join(' / ')}`
          + '（也接受各家的等价词：off/light/minimal/xhigh/extra_high/max）',
        allowed: [...(allowList ?? CONTRACT_LEVELS)],
      },
      headers,
    }
  }

  // 白名单闸门：管理员显式限制了这个模型能开放哪几档。
  // 这是**硬拒绝**而不是静默降档 —— 降档会让用户以为设置生效了。
  if (allowList !== undefined && !allowList.includes(contract)) {
    return {
      error: {
        message: `该模型只开放这些推理等级：${allowList.join(' / ')}（收到「${String(requested)}」）`,
        allowed: [...allowList],
      },
      headers,
    }
  }

  // 逐后端拿词表 → 算全链公共可达的真实词（抽成独立函数，默认档那条也要用）
  const resolved = await resolveChainWordFor(deps, plans, contract)
  headers['X-Lantern-Effort-Contract'] = contract

  // 三态里 native / scaled 都是**正常结果**（scaled 反而是常态：
  // 绝大多数后端用 xhigh/max 而不是 high）。只有 degraded 才是不下发。
  if (resolved.mode === 'native' || resolved.mode === 'scaled' || resolved.mode === 'fallback') {
    headers['X-Lantern-Effort-Served'] = resolved.word
    // 如实标出"落到了该家第几档"，用户能据此判断"是不是最高"
    if (resolved.mode === 'scaled' && resolved.position !== undefined) {
      headers['X-Lantern-Effort-Position'] = `${resolved.position}/${resolved.total}`
    }
    const note = effortNote(resolved)
    if (note !== undefined) headers['X-Lantern-Effort-Note'] = note    // 诊断头：每个后端**读到了什么词表**。
    //
    // 一律给词名，不再按 maskTopology 分级。理由：
    //   · 档位词（low/high/xhigh…）是**协议层的通用词汇**，不是 provider 名
    //     或上游模型名，不含"我在转卖谁的模型"这类信息；
    //   · 但在排查"四档全落同一档"时，**光有档数根本不够** ——
    //     实测卡了好几轮：diag 显示 `#3:5`（读到 5 档）却仍全落 `high`，
    //     只有看到词名才能发现"这 5 个词 rank 全都认不出、于是被排除出池"。
    //   · provider 名与模型名仍由 `maskTopology` 控制（见 /v1/models 的其它字段）。
    if (Array.isArray(resolved.__diag)) {
      headers['X-Lantern-Effort-Diag'] = resolved.__diag
        .map((d) => `${d.label}:[${(d.efforts ?? []).join('|')}]`)
        .join(',')
      // 投票明细：每个后端**实际投出的词**与权重，以及最终 winner。
      // 只有它才能回答"加权为什么没用上"——实测卡了很多轮：
      // diag 显示三个后端都有词表（1/1/5 档），结果仍全落 `high`。
      // 光看输入（词表）看不出问题，必须看输出（谁投了什么、得几票）。
      if (Array.isArray(resolved.detail)) {
        headers['X-Lantern-Effort-Votes'] = resolved.detail
          .map((d) => (d.ok ? `${d.label}=${d.word}(${d.total})` : `${d.label}=skip:${d.reason}`))
          .join(',')
        headers['X-Lantern-Effort-Winner'] = String(resolved.word ?? 'none') +
          '@' + String(resolved.position ?? '?') + '/' + String(resolved.total ?? '?') +
          ' mode=' + String(resolved.mode)
      }
    }
    return { word: resolved.word, contract, headers, resolved }
  }

  // degraded / reject：都不下发 reasoningEffort。
  // 区别在于 degraded 是设计内的退化（模型不会思考），reject 是词表认不出。
  const note = effortNote(resolved)
  if (note !== undefined) headers['X-Lantern-Effort-Note'] = note
  // ── #196：不下发时也要明确标记 served ──
  //
  // 原来这里**不写** `X-Lantern-Effort-Served`，于是客户端拿到的是空值。
  // 空值和"没这个头"在客户端看来几乎一样，都分不清是
  //   · 网关没算出来（bug）
  //   · 还是模型不支持（正常降级）
  //
  // 实测 `Qwen4-Max`：它的上游不声明任何可识别的档位词，
  // 网关正确地选择"不发这个参数"，但响应头是空的 —— 用户看不出这是正确行为。
  //
  // 现在明确写 `not-sent`：客户端一眼能区分
  //   · `served: low/high/xhigh…` → 映射成功，下发了这个词
  //   · `served: not-sent`        → 没下发（原因见 X-Lantern-Effort-Note）
  headers['X-Lantern-Effort-Served'] = 'not-sent'
  return { word: undefined, contract, headers, resolved }
}

/**
 * 从目标模型条目里取出"按模型的推理档位配置"（第十轮 #118）。
 *
 * 普通模型（`model@provider` 形式）没有这两个字段，返回空对象 ——
 * 于是普通模型的行为与改动前**完全一致**，不会因为这条新功能而变化。
 *
 * @param target - resolveModel() 的结果。
 * @returns `{ allowedLevels?: string[], defaultLevel?: string }`
 */
function effortOptsOf(target) {
  if (target?.custom !== true) return {}
  const allowed = Array.isArray(target.reasoningEfforts) && target.reasoningEfforts.length > 0
    ? target.reasoningEfforts
    : undefined
  const dflt = typeof target.defaultReasoningEffort === 'string' ? target.defaultReasoningEffort : undefined
  return {
    ...(allowed === undefined ? {} : { allowedLevels: allowed }),
    ...(dflt === undefined ? {} : { defaultLevel: dflt }),
  }
}

/**
 * 按链上各档的真实词表，算出某个契约档最终该发哪个词。
 *
 * 单独抽出来是因为**两条路径都要用**：
 *   · 调用方显式传档 → `resolveEffortForChain` 的主路径；
 *   · 调用方不传、但模型配了 `defaultReasoningEffort` → 默认档路径。
 * 两条路径如果各写一份映射，"显式传 medium" 与 "默认 medium" 可能落到不同的词，
 * 这是最难解释的一类不一致。
 *
 * @param {object} deps - 转发依赖（需 capabilities.describe）。
 * @param {Array<object>} plans - 已筛过的后端链。
 * @param {string} contract - 四档之一。
 * @returns {Promise<ReturnType<typeof resolveChainLevel>>}
 */
async function resolveChainWordFor(deps, plans, contract) {
  // 逐后端拿词表。拿不到就当作"无档案"（empty-list），不影响别人。
  const rows = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    let efforts = []
    try {
      const view = await deps.capabilities?.describe(plan.provider, plan.model)
      const list = view?.reasoning?.efforts
      if (Array.isArray(list)) efforts = list.filter((e) => typeof e === 'string')
    } catch {
      // 单档查询失败不拉黑整条链：以空词表参与，走"无档案"分支。
    }
    rows.push({ label: plan.binding ?? `${plan.model}@${plan.provider}`, efforts })
  }
  // 诊断：把每个后端读到的词表写进响应头（默认只给档数，脱敏模式下不泄露词）
  if (process.env.LANTERN_DEBUG_EFFORT === '1') {
    console.error('[lantern][effort] contract=' + contract + ' rows=' +
      JSON.stringify(rows.map((r) => ({ label: r.label, n: r.efforts.length, efforts: r.efforts }))))
  }
  const resolvedOut = resolveChainLevel(rows, contract)
  // 诊断：把每个后端读到的词表写进响应头。
  //
  // 分两级，因为**档数和档名能区分完全不同的故障**：
  //   · 档数对但落点错  → 投票/映射算错（看词名才能定位）
  //   · 档数是 0        → 取词表失败（#166 那类）
  // 脱敏（maskTopology）开启时只给档数：词名本身是上游厂商的私有命名，
  // 属于"我在转卖谁的模型"这类信息，不该对公网泄露。
  // 但**序号和档数**不含拓扑，任何情况下都给 —— 上一版把它一起门控掉了，
  // 结果默认配置下永远看不到 diag，排查只能靠猜。
  resolvedOut.__diag = rows.map((r) => ({ label: r.label, n: r.efforts.length, efforts: r.efforts }))
  return resolvedOut
}

/**
 * 从 `resolved.detail` 里抽出每档的真实词表（给 /v1/models 与面板外显用）。
 *
 * @param {object} deps - 转发依赖。
 * @param {Array<object>} plans - 后端链。
 * @returns {Promise<Array<{ backend: string, efforts: string[], contract: Array<{level:string, word:string|undefined, mode:string}> }>>}
 */
async function describeChainEfforts(deps, plans) {
  const out = []
  for (const plan of Array.isArray(plans) ? plans : []) {
    let efforts = []
    try {
      const view = await deps.capabilities?.describe(plan.provider, plan.model)
      const list = view?.reasoning?.efforts
      if (Array.isArray(list)) efforts = list.filter((e) => typeof e === 'string')
    } catch {
      /* 无档案 */
    }
    out.push({
      backend: plan.binding ?? `${plan.model}@${plan.provider}`,
      efforts,
      contract: describeChainLevels([{ efforts }]),
    })
  }
  return out
}

/**
 * 把消息构建期的降级写进响应头（第十轮 #108）。
 *
 * `buildMessages()` 一直返回 `warnings`，但三个协议调用点全都只取了
 * `.messages` / `.imageRefs` —— 这个数组从产生到销毁没有任何消费者。
 *
 * 丢掉的是这些事件：
 *   · messages 超 `MAX_MESSAGES`（500）被截断
 *   · 单条消息超 `MAX_TEXT_BYTES`（512 KB）被截断
 *   · 不认识的 role 被忽略
 *   · 不支持的图片格式被丢弃
 *
 * 为什么必须补回来：模型看到的内容比调用方以为的少，回答自然对不上；
 * 而调用方手里没有任何线索，只能去怪模型或怪 prompt。这是本插件
 * "降级永远可见"那条铁律最隐蔽的反例。
 *
 * 脱敏时只给条数（文案里可能带内部限制值），未脱敏时给完整文案。
 *
 * @param res - HTTP 响应。
 * @param built - `buildMessages()` 的返回值。
 * @param cfg - 当前配置（决定是否脱敏）。
 */
function applyMessageWarnings(res, built, cfg) {
  try {
    const warnings = Array.isArray(built?.warnings) ? built.warnings.filter((w) => typeof w === 'string' && w.length > 0) : []
    if (warnings.length === 0) return
    if (res.headersSent || res.writableEnded) return
    res.setHeader('X-Lantern-Warnings', String(warnings.length))
    if (!isHintMasked(cfg)) {
      // 逐条给原文（管理员排障要看得懂），用 encodeURIComponent 防止头里出现非法字符。
      res.setHeader('X-Lantern-Warning-Texts', warnings.map((w) => encodeURIComponent(w)).join('|'))
    }
  } catch {
    // 写头失败绝不影响请求本身：这是纯可观测性。
  }
}

/**
 * 决定这次请求到底该下发哪些工具定义（第十轮 #117）。
 *
 * 原来三个通道的写法都是：
 *     ...(built.tools === undefined && parsed.toolSchemas === undefined
 *       ? {}
 *       : { tools: parsed.toolSchemas })
 * 判空看了 built.tools，**下发的却是 parsed.toolSchemas** —— 判一个发另一个。
 *
 * 后果：buildMessages() 会从 messages 里的 tool_calls / tool_result 重建出
 * 工具定义（built.tools），那是多轮工具调用时唯一的来源；而 parsed.toolSchemas
 * 只来自请求体顶层的 tools 字段。于是这两种情形工具定义会整块丢失：
 *   · 客户端只在第一轮发 tools、续轮不再发（绝大多数 agent 框架都这样）；
 *   · 客户端完全靠历史里的 tool_calls 让模型知道有哪些工具。
 * 表现就是用户说的"轮询时工具引用有问题"：第一轮能调，第二轮开始模型拿不到
 * 工具定义，要么答纯文本、要么自己编一个工具名。
 *
 * 现在的口径：两个来源合并，built.tools（历史重建）作基底，
 * parsed.toolSchemas（本轮显式声明）按 name 覆盖同名项。
 *
 * @param built - buildMessages() 的返回值。
 * @param parsed - 解析结果。
 * @returns 工具定义数组，或 undefined（都没有时不下发这个字段）。
 */
function mergeToolSchemas(built, parsed) {
  const fromHistory = Array.isArray(built?.tools) ? built.tools : []
  const fromRequest = Array.isArray(parsed?.toolSchemas) ? parsed.toolSchemas : []
  if (fromHistory.length === 0 && fromRequest.length === 0) return undefined
  if (fromHistory.length === 0) return fromRequest
  if (fromRequest.length === 0) return fromHistory
  const nameOf = (t) => (typeof t?.name === 'string' ? t.name : typeof t?.function?.name === 'string' ? t.function.name : undefined)
  // 本轮显式声明的优先（它是最新意图），历史里同名的被覆盖。
  const byName = new Map()
  for (const t of fromHistory) {
    const n = nameOf(t)
    if (n !== undefined) byName.set(n, t)
  }
  const nameless = []
  for (const t of fromRequest) {
    const n = nameOf(t)
    if (n === undefined) nameless.push(t)
    else byName.set(n, t)
  }
  // 无名字的项不参与去重，直接追加（不能因为一个畸形项丢掉别人）
  return [...byName.values(), ...nameless]
}

/**
 * 把本次实际要下发的工具写进 options（第十轮 #117）。
 *
 * @param built - buildMessages() 的返回值。
 * @param parsed - 解析结果。
 * @returns GenerateOptions 的片段。
 */
function toolsOptionOf(built, parsed) {
  const tools = mergeToolSchemas(built, parsed)
  return tools === undefined ? {} : { tools }
}

/**
 * 给每个后端算它自己该用的推理档词（第十一轮 #121）。
 *
 * ## 为什么必须逐档算，不能共享一个值
 *
 * `reasoningEffort` 是 `GenerateOptions` 里的**单值字段**，而故障转移链上每个
 * 后端的词表长度可以完全不同：
 *
 *   glm-5.3 的 6 个绑定 = [low,high,max] / [light,high,extra_high] / [none,low,medium,high,xhigh] / …
 *
 * 用户传 `max`（= "给我最强的"）时：
 *   · 若共享一个值 → 只能全链投票取多数 → `extra_high` 或 `high`，
 *     那 3 档里真正有 `max` 的后端反而拿不到自己的天花板；
 *   · 逐档算 → 有 `max` 的给 `max`、只有 `xhigh` 的给 `xhigh`、
 *     只有 `extra_high` 的给 `extra_high` —— **每家都是自己的最强**。
 *
 * 实测（修复前）：`glm-5.3 max → served=extra_high`（被 3 档的多数投低了）；
 * 修复后应该是 `served=max`（链首那档的自身最强）。
 *
 * ## 不改 plan 的形状
 *
 * 用 `plan.effortWord` 这个**附加字段**携带，不动现有 `binding/provider/model`
 * 三件套 —— 那三件套被 `orderByHealth`、`applyServedHeaders`、
 * `recordCall` 等多处按引用读取，改形状会波及一片。
 *
 * @param deps - 转发依赖（需 capabilities.describe）。
 * @param plans - 已筛过的后端链。
 * @param contract - 四档之一（调用方要的语义档）。
 * @returns {Promise<Array<object>>} **新的** plans 数组（每条带 effortWord，可能没有）。
 */
async function annotatePlanEfforts(deps, plans, contract) {
  const list = Array.isArray(plans) ? plans : []
  if (contract === undefined) return list
  const out = []
  for (const plan of list) {
    let efforts = []
    try {
      const view = await deps.capabilities?.describe(plan.provider, plan.model)
      const arr = view?.reasoning?.efforts
      if (Array.isArray(arr)) efforts = arr.filter((e) => typeof e === 'string')
    } catch {
      /* 单档查询失败 = 无档案，不影响别人 */
    }
    const mapped = mapLevelToBackend(efforts, contract)
    out.push({
      ...plan,
      // 只在真的算出来时才挂字段：没有词表的后端不该带一个 undefined 进 options
      ...(mapped.ok === true
        ? { effortWord: mapped.word, effortPosition: mapped.position, effortTotal: mapped.total }
        : {}),
    })
  }
  return out
}

/**
 * 给每个后端挂上它自己的输出上限（第十三轮 #150）。
 *
 * ## 为什么必须逐档算
 *
 * `maxTokens` 在 `GenerateOptions` 里是**单值**，而链上每个绑定的真实上限不同：
 *
 *   deepseek-v4.1-flash
 *     #1@xdpool   ctx=1,000,000   maxTokens 上限 ?
 *     #2@trae     ctx=960,000     maxTokens: 128,000   ← 你 cordis.patch.yml 里写的
 *     #3@loomy    ctx=1,048,576   maxTokens 上限 ?
 *
 * 用户传 `max_tokens: 200000` 时，若原样发给 `@trae`：
 *   · 严格的上游会 400 拒绝 → 白烧一次调用
 *   · 宽松的上游会**静默截断**到 128K → 用户拿到半截回答，且不知道为什么
 *
 * 面板探测显示"最大输出 128K"就是这个原因：探测打到了 `@trae` 那一档。
 *
 * ## 做法
 *
 * 给每个 plan 挂 `maxOutput`（该绑定的上限）。执行时 `maxTokens` 取
 * `min(用户要的, plan.maxOutput)`。这样：
 *   · 轮到高上限的绑定 → 用户要多少给多少
 *   · 轮到低上限的绑定 → 自动降到它撑得住的值，**不会失败**
 *   · 降了多少通过 `X-Lantern-MaxTokens-Capped` 如实告知
 *
 * 拿不到上限的绑定（`unknown`）→ 不限制，交给上游自己拒绝。
 *
 * @param deps - 转发依赖（需 capabilities.describe）。
 * @param plans - 已筛过的链。
 * @returns {Promise<Array<object>>} 新数组，每条可能带 `maxOutput`。
 */
async function annotatePlanMaxOutput(deps, plans) {
  const list = Array.isArray(plans) ? plans : []
  const out = []
  for (const plan of list) {
    let cap
    try {
      const view = await deps.capabilities?.describe(plan.provider, plan.model)
      const v = view?.maxOutputTokens?.value
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) cap = v
    } catch {
      /* 单档查询失败 = 不知道上限，不限制 */
    }
    out.push(cap === undefined ? plan : { ...plan, maxOutput: cap })
  }
  return out
}

/**
 * 把"本次实际落到哪一档后端"写成响应头。
 *
 * ## 为什么这个头比什么都重要
 *
 * `X-Lantern-Failover-Chain` 报的是**链上有几档**（脱敏时只是个数字），
 * 它回答不了"这次到底用了第几档"。于是链上某档挂了、请求静默切到另一档时，
 * 调用方完全无感 —— 而那一档可能不认识刚才那个推理档位。
 *
 * 脱敏时只给序号（`#3`），不给 provider 名：序号是排障信息，名字是拓扑。
 *
 * @param {object} res - HTTP 响应。
 * @param {object} state - `{ plan, attempts }`（故障转移执行器的出参）。
 * @param {Array<object>} plans - 本次真正使用的链（用于算序号）。
 * @param {object} cfg - 当前配置（决定是否脱敏）。
 */
/**
 * 往 SSE 响应里写一帧，并**立刻推出去**（第十六轮 #172）。
 *
 * ## 为什么不能只 `res.write()`
 *
 * `res.write(str)` 只保证"交给 Node 的 socket 写缓冲"，不保证"已经发到内核"。
 * Node 的 socket 写缓冲默认 16KB —— 短帧会先攒着，等攒满或下次事件循环才真正
 * flush。于是客户端看到的是"几个小帧 + 一个 16KB 大块"交替。
 *
 * 实测（同一模型、同一 prompt）：
 *   · 最小块 190 字节  ← 说明逐帧转发确实在发生
 *   · 最大块 16,750 字节 ← 说明有些帧被 socket 缓冲合并了
 * 用户感知就是"卡一下、蹦一大段"，不是丝滑打字机。
 *
 * `res.flush?.()` 会立刻把缓冲推给内核；`res.socket.uncork()` 处理被 cork 的情况。
 * 两者都做了防御性判断——不同 Node 版本 / 不同 res 实现里可能不存在。
 *
 * 代价：每个 SSE 帧一次系统调用。对聊天场景（每秒几十帧）完全可接受。
 *
 * @param res - Node 响应对象。
 * @param frame - 要写出的 SSE 文本（含结尾的空行）。
 */
function writeFrame(res, frame) {
  if (res.writableEnded === true) return
  res.write(frame)
  try { res.flush?.() } catch { /* 实现不支持则跳过 */ }
  try {
    const socket = res.socket
    // 有些中间层会 cork 住 socket，显式 uncork 一次把缓冲放出去
    if (socket !== null && socket !== undefined && typeof socket.uncork === 'function') {
      socket.uncork()
    }
  } catch { /* 连接已断则忽略 */ }
}

function applyServedHeaders(res, state, plans, cfg) {
  if (res.headersSent || res.writableEnded) return
  const used = state?.plan
  if (used === undefined) return
  const list = Array.isArray(plans) ? plans : []
  const index = list.findIndex((p) => p.provider === used.provider && p.model === used.model)

  // ── #204：把「每次尝试的失败原因」暴露出来（排障必需）──
  //
  // 用户反馈的真实痛点：`@loomy` 明明超时了却**不进冷却**，
  // 而从面板只能看到"有记录 N 档"，看不到它到底报了什么码、
  // 为什么被 `isBackendBlame` 判成"不是后端的锅"。
  //
  // `attempt.errorCode` 一直在记（第 2004 行等处），却从来没被输出过 ——
  // 于是这类问题只能靠推测。现在把它输出成响应头：
  //   `X-Lantern-Attempt-Codes: #1=backend_timeout,#2=ok`
  //
  // ⚠ 只给**错误码**，不给错误原文、不给 provider 名：
  //   · 错误码（backend_timeout / QUOTA_EXCEEDED / TRANSPORT…）是协议层通用词汇，
  //     不含"我在转卖谁的模型"这类拓扑信息；
  //   · 原文可能带上游端点/邮箱/密钥，那是必须脱敏的；
  //   · 序号 `#N` 与 X-Lantern-Served 同一坐标，不额外泄露顺序。
  // 所以这个头在**脱敏模式也照发**——它是排障刚需，且泄露面为零。
  const attemptList = Array.isArray(state?.attempts) ? state.attempts : []
  if (attemptList.length > 0) {
    const codes = attemptList.map((a, i) => {
      const idx = typeof a?.order === 'number' ? a.order : i + 1
      const code = a?.ok === true ? 'ok' : (a?.errorCode ?? a?.kind ?? (a?.error !== undefined ? 'error' : 'unknown'))
      // #206：把每档**本次是否进了冷却**也带上（`+600s` / `-`）
      // ——只给秒数，不泄露 provider 名。这样一眼能看出"记了却没用"还是"没记上"。
      const cd = typeof a?.cooldownSec === 'number' && a.cooldownSec > 0 ? `+${a.cooldownSec}s` : '-'
      return `#${idx}=${code}${cd === '-' ? '' : '(' + cd + ')'}`
    })
    res.setHeader('X-Lantern-Attempt-Codes', codes.join(','))
  }

  if (isMasked(cfg)) {
    // 序号 + 尝试次数：既能让运维对上面板，又推不出拓扑。
    if (index >= 0) res.setHeader('X-Lantern-Served', `#${index + 1}`)
    // ⚠ 只在真的试过之后才发尝试次数（第十四轮 #158）。
    //
    // 流式路径为了赶在首字节之前发头，调用这里时 `attempts` 还是空数组，
    // 于是对外报 `X-Lantern-Attempts: 0` —— "一次都没试过" 对客户端等于
    // 没有信息，还会让人以为网关没真正请求上游。实测流式 hy4 就是 att=0。
    // 未尝试时不发这个头，比发一个 0 更诚实。
    const attempts = Array.isArray(state?.attempts) ? state.attempts.length : undefined
    if (attempts !== undefined && attempts > 0) res.setHeader('X-Lantern-Attempts', String(attempts))
    return
  }
  res.setHeader('X-Lantern-Served', used.binding ?? `${used.model}@${used.provider}`)
  const attempts = Array.isArray(state?.attempts) ? state.attempts.length : undefined
  if (attempts !== undefined && attempts > 0) res.setHeader('X-Lantern-Attempts', String(attempts))
}

/**
 * 按后端健康记忆重排执行链（**只改顺序，不删档**）。
 *
 * 为什么这件事必须做（用户实测提出，m04349）：
 * 链是 `[A, B, C]`，A 挂了以后，**每个**请求都要先等满 A 的首包超时（默认 30 秒）
 * 才轮到 B——同一个已知故障被反复付费，体感就是「明明 B 好的，每次先卡半分钟」。
 * 而把 A 禁用又不成立：它可能几分钟后就恢复，禁用等于要人手动回来点。
 *
 * 折中：失败的后端进冷却（默认 30 秒），冷却期内**排到链尾**（不是移除）——
 * 健康的后端先试，A 只在别人也全挂时才被碰到；冷却到期自动回到它原本的
 * 配置位置（用户配的顺序就是首选顺序，插件不偷偷改语义）。
 *
 * 两个必须守住的边界：
 * 1. **链上一个都不少**：全挂时仍按原序全部试一遍，报错信息依旧完整；
 * 2. **客户端自己的错不记在后端头上**（400/401 这类），见 `isBackendBlame`。
 *
 * @param deps - 转发依赖（需要 backendHealth，缺省时原样返回）。
 * @param plans - `buildFailoverPlans()` 的结果。
 * @param headersSink - 可选，`{ ineligible }` 之类的出参容器；这里只读不写。
 * @returns 重排后的链（顺序可能变，内容不变）。
 */
function orderByHealth(deps, plans) {
  const list = Array.isArray(plans) ? plans : []
  if (deps.backendHealth === undefined) return list
  try {
    const ordered = deps.backendHealth.order(list)
    if (ordered.allCooling === true) {
      // ── #216（用户最终设计）：用户请求立即 503，后台自己去做一次自检 ──
      //
      // 用户原话：「全部冷却了，用户正常返回 503 没问题，我们后端检测到
      //   模型全部冷却了，自己自检跑一遍之后，如果还是全都失败，
      //   那就等冷却结束，不会再去自检」
      //
      // 所以这里做两件事，顺序不能反：
      //   1. **立刻**返回空链 → 调用方走既有分支返回 503（用户零等待）
      //   2. **异步**发起一次自检（不 await、不阻塞这个请求）
      //
      // 关键：自检结果只影响**之后的**请求。本次请求已经明确告诉用户
      // "现在不可用"，绝不让用户为自检付费（那是上一版做错的地方：
      // 把冷却档塞进用户请求的执行链，用户白等 60 秒）。
      deps.log?.(
        'warn',
        `[lantern] 链上 ${list.length} 档全部在冷却中 → 本次请求立即返回不可用，` +
          `同时后台自检一次（好的解除冷却，坏的保持到冷却到期）`,
      )
      triggerBackgroundSweep(deps, list)
      return []
    }
    if (ordered.cooling > 0) {
      deps.log?.(
        'info',
        `[lantern] 故障转移链按健康度过滤：${ordered.cooling} 档在冷却中被**本次跳过**` +
          `（原 ${list.length} 档 → 实试 ${ordered.plans.length} 档）`,
      )
    }
    return ordered.plans
  } catch (error) {
    // 排位是纯优化：它出错绝不能影响转发本身。
    deps.log?.('error', `[lantern][health] 链重排失败（按原序继续）：${error?.message}`)
    return list
  }
}

/**
 * #216：后台自检 —— 逐档真打一次，成功的当场解除冷却。
 *
 * ## 为什么必须有它
 *
 * `#208` 让"全部冷却 → 立即 503"。方向对（不让用户白等），
 * 但它把"全部冷却"当成了终点 —— 实测中一批异常请求（比如客户端
 * 发来 8 种畸形 messages）就能把 6 个后端挨个打进 600 秒冷却，
 * 之后**所有正常请求**都被拒绝 10 分钟，而那些后端大多是好的。
 *
 * 所以补一条自愈路径：全冷却时在**后台**探一遍，探通的立刻恢复。
 *
 * ## 关键约束（用户明确要求）
 *
 * 1. **只在后台跑**：绝不阻塞用户请求，用户该拿 503 就拿 503。
 * 2. **同一批全冷却只自检一次**：靠 `shouldSweep()` 的时间窗防抖。
 *    自检完还是全挂 → 保持冷却、等下轮冷却到期，**不再反复打上游**
 *    （用户原话："如果还是全都失败，那就等冷却结束，不会再去自检"）。
 * 3. **探测失败不延长冷却**：`recordFailure` 里 `alreadyCooling` 判定
 *    保证冷却期内重复失败不累加 streak，所以自检不会把冷却越滚越长。
 *
 * ## 为什么用 stream 而不是别的
 *
 * 走 `ctx.llm.stream` 与真实请求同一条路径 —— 只有这样才能保证
 * "自检通过"意味着"用户请求也能通过"。用 ping/健康检查接口不行：
 * 那些通常不经过与生成相同的鉴权、配额、模型路由。
 *
 * @param deps - 转发依赖（需要 backendHealth / log / 以及 ctx）。
 * @param plans - 当前全冷却的后端计划列表。
 */
function triggerBackgroundSweep(deps, plans) {
  const health = deps.backendHealth
  if (health === undefined) return
  if (health.shouldSweep !== undefined && health.shouldSweep() !== true) {
    // 时间窗内已经自检过 → 直接放过（用户要的"不再反复自检"）
    return
  }
  const sctx = deps.sweepContext?.()
  if (sctx === undefined || sctx?.llm === undefined) return

  health.beginSweep?.()
  const list = Array.isArray(plans) ? plans.slice() : []

  // 刻意**不 await**：这是一条独立的后台任务。
  // 用 `void` + 末尾 catch 明确表达"故意忽略返回值"，
  // 避免被误认为忘记 await。
  void (async () => {
    let ok = 0
    let bad = 0
    const timeoutMs = SWEEP_PROBE_TIMEOUT_MS
    for (const plan of list) {
      if (sctx.llm === undefined) break
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      let succeeded = false
      try {
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const messages = [createUserMessage({ content: [{ type: 'text', text: 'ping' }] })]
        for await (const chunk of sctx.llm.stream({
          provider: plan.provider,
          model: plan.model,
          messages,
          maxTokens: 8,
          ...(plan.effortWord === undefined ? {} : { reasoningEffort: plan.effortWord }),
          signal: ac.signal,
        })) {
          // 只要吐出任何一个实质 chunk（正文/思考/工具调用）就算这一档活着。
          // 不用 `finish` 判定：纯 finish 帧在"限流静默/风控静默"时也会出现，
          // 那不是"活着"的证据（见 isSubstantiveChunk 的注释）。
          if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta') {
            succeeded = true
            break
          }
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') break
        }
      } catch {
        succeeded = false
      } finally {
        clearTimeout(timer)
        try { ac.abort() } catch { /* 已结束 */ }
      }

      if (succeeded) {
        ok += 1
        // 探通了 → 解除它的冷却，下一个用户请求立刻能用上。
        health.recordSuccess?.(plan)
        deps.log?.('info', `[lantern] 后台自检：${plan.binding} 已恢复，解除冷却`)
      } else {
        bad += 1
        // 刻意**不**调 recordFailure：它本来就还在冷却中，
        // 再记一次只会把到期时间往后推（虽然不累加 streak），
        // 而用户要的是"还是全都失败就等冷却结束" —— 保持原状即可。
      }
    }
    health.endSweep?.(ok, bad)
    deps.log?.(
      ok > 0 ? 'info' : 'warn',
      `[lantern] 后台自检完成：${ok} 档恢复、${bad} 档仍不可用` +
        (ok > 0 ? '（下一个请求即可用）' : '（保持冷却，等到期自动恢复，不再重复自检）'),
    )
  })().catch((error) => {
    health.endSweep?.(0, 0)
    deps.log?.('error', `[lantern][health] 后台自检异常：${error?.message}`)
  })
}

/**
 * 把自定义模型的绑定列表整理成「对外可看」的样子。
 *
 * 内部形状含 binding（model@provider）、provider、model、reason——
 * 那是给管理面板看的（面板走的是 RPC，不经过这里）。
 * 但 /v1/models 是**给调用方**看的：谁都能 curl /v1/models 一下，
 * 于是「我这个名字背后挂了 trae 的 deepseek 和 xdpool 的 deepseek」这件事
 * 就被完整地摆在了台面上。
 *
 * 对外只保留两样东西：
 * - order：绑定顺序。这是有价值的（客户端能判断首选后端是不是经常不可用），
 *   而且顺序本身不透露身份；
 * - available：这一档现在能不能用。
 *
 * @param bindings - 条目里的绑定数组（有序）。
 * @param plans - buildFailoverPlans 的结果。
 * @param skipped - 同上。
 * @param cfg - 当前配置（决定是否脱敏）。
 * @returns 对外绑定视图。
 */
function publicBindingRows(bindings, plans, skipped, cfg) {
  const list = Array.isArray(bindings) ? bindings : []
  if (!isMasked(cfg)) {
    return list.map((b, index) => {
      const plan = plans.find((pp) => pp.binding === b)
      return {
        binding: b,
        order: index + 1,
        available: plan !== undefined,
        ...(plan === undefined
          ? { reason: skipped.find((s) => s.binding === b)?.reason ?? '不可用' }
          : { provider: plan.provider, model: plan.model }),
      }
    })
  }
  return list.map((b, index) => {
    const plan = plans.find((pp) => pp.binding === b)
    return { order: index + 1, available: plan !== undefined }
  })
}

/**
 * 计算故障转移链要发的两个响应头的值。
 *
 * 未脱敏时原样给绑定名，便于管理员排障；
 * 脱敏时只给「几档」，因为档数本身不透露身份，
 * 而调用方唯一能做的事就是「再试一次」——知道是三档还是五档没有区别。
 *
 * @param plans - 可用的后端计划。
 * @param skipped - 解析期就跳过的绑定。
 * @param cfg - 当前配置。
 * @returns { chain, skipped } 两个头的值（skipped 可能为 undefined）。
 */
function failoverHeaderValues(plans, skipped, cfg) {
  if (!isMasked(cfg)) {
    return {
      chain: plans.map((p) => p.binding).join(' > '),
      skipped: skipped.length > 0 ? skipped.map((s) => s.binding).join(',') : undefined,
    }
  }
  return {
    chain: String(plans.length),
    skipped: skipped.length > 0 ? String(skipped.length) : undefined,
  }
}

/**
 * 统一发故障转移相关的响应头。
 *
 * @param res - HTTP 响应。
 * @param plans - 可用的后端计划。
 * @param skipped - 解析期跳过的绑定。
 * @param cfg - 当前配置。
 */
function applyFailoverHeaders(res, plans, skipped, cfg) {
  const values = failoverHeaderValues(plans, skipped, cfg)
  res.setHeader('X-Lantern-Failover-Chain', values.chain)
  if (values.skipped !== undefined) res.setHeader('X-Lantern-Failover-Skipped', values.skipped)
}
/**
 * 构造「所有后端都失败」时的错误体（已按脱敏开关整理）。
 *
 * 为什么要单独抽出来：这条路径上有三样东西会泄露内部信息——
 * failure.message（可能写着「模型 X 不在 provider 的模型列表中」）、
 * failure.code（上游特有错误码）、attempts（整条绑定链连同 provider 名）。
 * 三者对调用方都没有任何可操作性：他改不了后端，也看不见后端。
 *
 * 未脱敏时保持原样（管理员调试要看全部细节）。
 *
 * @param options - { target, failure, attempts, cfg, custom }。
 * @returns `{ message, details }`，可直接喂给 errorBody。
 */
function maskedFailureBody(options) {
  const { target, failure, attempts, cfg, custom } = options
  const raw = failure ?? {}
  if (!isTopologyMasked(cfg)) {
    return {
      message: maskSecrets(raw.message ?? '上游调用失败'),
      details: {
        ...(raw.status === undefined ? {} : { status: raw.status }),
        ...(raw.requestId === undefined ? {} : { request_id: raw.requestId }),
        ...(custom === true ? { attempts } : {}),
      },
    }
  }
  const all = publicAllFailedError({ target, attempts: custom === true ? attempts : undefined, cfg })
  return {
    // status 保留：它是 HTTP 语义（429/503），不含任何拓扑；
    // request_id 也保留：它本来就只用于对日志，且不含 provider 名。
    details: {
      ...(raw.status === undefined ? {} : { status: raw.status }),
      ...(raw.requestId === undefined ? {} : { request_id: raw.requestId }),
      ...all.details,
    },
    message: all.message,
  }
}

/**
 * 把外层中止信号（客户端断开 / 请求超时）与本次尝试自己的超时合并成一个信号。
 *
 * 为什么不能直接用外层 signal：故障转移需要「只放弃这一次尝试」，
 * 而不是把整个请求取消掉。所以每次尝试都要有自己的 controller，
 * 同时**必须**继承外层的中止——否则客户端早就断开了，我们还在傻等上游。
 *
 * @param outer - 外层 AbortSignal（baseOptions.signal）。
 * @returns `{ signal, abort, dispose }`。
 */
function linkSignals(outer) {
  const controller = new AbortController()
  const onAbort = () => {
    try {
      controller.abort(outer?.reason)
    } catch {
      controller.abort()
    }
  }
  if (outer?.aborted === true) {
    onAbort()
  } else {
    outer?.addEventListener?.('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    abort(reason) {
      try {
        controller.abort(reason)
      } catch {
        controller.abort()
      }
    },
    dispose() {
      outer?.removeEventListener?.('abort', onAbort)
    },
  }
}

/**
 * 从 adapter 的拒绝里认出「它不吃哪个 GenerateOptions 字段」，并把该字段摘掉。
 *
 * 为什么需要这一层（真实故障）：DSH 的 pi-ai adapter 在
 * `try {` 第一行写死
 * `if (options.stop !== void 0) throw new LlmError("llm-pi-ai does not support
 * GenerateOptions.stop", "UNSUPPORTED_OPTION")`。它不收 stop，但我们不知道
 * ——`dsh-llm` 里没有 `supportsGenerateOption` 之类的接口，能力档案又只有
 * 「模型支不支持停止序列」这个业务口径，回答不了「这个 adapter 认不认这个
 * 字段」。于是只要用户把 stop 标成 supported、链上又有一条 pi-ai 系后端，
 * 这一档就必挂，而且挂在一个纯网关自身的问题上。
 *
 * 摘字段重试优先级**高于**换后端：错误是我们多发了参数，换一家照样发。
 * 只有认不出字段（返回 undefined）时才交给原来的故障转移逻辑。
 *
 * @param options - 当前 GenerateOptions。
 * @param message - 失败原文。
 * @param already - 本请求已摘过的字段集合（防死循环）。
 * @returns `{ next, field }` 或 undefined。
 */
const OPTION_FIELD_PATTERN = /(?:does\s+not|doesn't)\s+support[^.]{0,40}?GenerateOptions\s*\.\s*([A-Za-z]+)/i
function stripUnsupportedOption(options, message, already) {
  if (typeof message !== 'string' || message.length === 0) return undefined
  const hit = OPTION_FIELD_PATTERN.exec(message)
  if (hit === null) return undefined
  const field = hit[1]
  if (options === undefined || options === null) return undefined
  if (!Object.hasOwn(options, field)) return undefined
  if (already.has(field)) return undefined
  const next = { ...options }
  delete next[field]
  already.add(field)
  return { next, field }
}

/**
 * 判断一次失败值不值得「在同一个后端上再补一次」。
 *
 * 这个判据直接决定重试会不会变成放大器：
 * - 模型名拼错、参数不合法、鉴权失败——再试一百次也一样，重试只会拖长等待；
 * - 限流（429）、上游 5xx、网络中断、超时——换一次时机有可能就好，值得补。
 *
 * 所以这里**不是**「有错就重试」，而是「有可能自愈的错才重试」。
 *
 * @param failure - 失败信息 `{ message, code, status }`。
 * @returns 是否值得重试。
 */
function isRetryableFailure(failure) {
  if (failure === undefined || failure === null) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  // 工具调用被渲染成文本标记 = 这一档接不住结构化工具（#127）。
  // 值得换后端：下家可能支持。但**不在同一后端原地重试** —— 它的模板就是那样，
  // 再问一次还是同样的标记，只会多花一次预算。所以这里返回 false，
  // 由故障转移逻辑直接顺延到下一个绑定（换后端不依赖 isRetryableFailure）。
  if (code === 'tool_markup_leaked') return false
  // 空内容值得重试：同一个后端再问一次可能就有字，换后端更可能。
  // 若判成"不可重试"，一次静默空回答就直接变成对客户端的空回答——
  // 而这正是最该被换后端掩盖掉的失败（上游限流静默、风控静默）。
  if (code === 'empty_completion') return true
  // 「只思考不回答」同样值得再试一次（第十四轮 #152）：
  // 这不是后端挂了，而是这一次它的思考吃光了预算 / 没落到正文。
  // 换一次预算或换一档，往往就能给出正文 —— 比直接给用户一个空回答好得多。
  if (code === 'reasoning_only_empty') return true
  // 超时**不**原地重试：同一个后端在 30 秒里没吐一个字，再给它 30 秒只是
  // 把用户的等待翻倍。用户要的是"超时就切下一个"，换后端才是这里的衔接。
  if (code === 'backend_timeout') return false
  // 请求本身有问题：重试无意义（这些错误码来自上游与网关自身两侧）
  if (/^(model_not_found|invalid_request_error|INVALID_REQUEST|capability_unsupported|invalid_reasoning_effort|payload_too_large|bad_request|unauthorized|invalid_api_key|authentication_error|forbidden)$/i.test(code)) {
    return false
  }
  const status = typeof failure.status === 'number' ? failure.status : undefined
  if (status !== undefined) {
    if (status === 408 || status === 429) return true
    if (status >= 500) return true
    return false
  }
  // 没有状态码可依据（网络错误 / 上游内部异常）——再给一次机会
  return true
}

/**
 * 解析一次请求的故障转移调参。
 *
 * 三个取值域必须分清楚，混在一起会出人命：
 * - 未给（undefined）→ 用默认 30 秒 / 2 次重试。自定义模型没填就是这套；
 * - 0 → **不启用**。普通模型（单后端）必须走这条：它本来就没有「换下一个」
 *   这回事，给它加 30 秒首包超时只会把「正常但慢」的回答砍掉，
 *   那是把一个新功能变成一个回归缺陷；
 * - 正数 → 用它。
 *
 * @param tune - `{ timeoutMs, retries }`。
 * @returns `{ timeoutMs, retries }`，timeoutMs 为 0 表示不设超时。
 */
function resolveTune(tune) {
  const rawTimeout = tune?.timeoutMs
  let timeoutMs
  if (rawTimeout === 0) timeoutMs = 0
  else if (Number.isFinite(rawTimeout) && rawTimeout > 0) timeoutMs = Math.round(rawTimeout)
  else timeoutMs = DEFAULT_BACKEND_TIMEOUT_MS
  const retries = Number.isInteger(tune?.retries) ? Math.max(0, tune.retries) : DEFAULT_BACKEND_RETRIES
  return { timeoutMs, retries }
}
/**
 * 从解析结果里取本次请求的调参。
 *
 * 普通模型一律 `{ timeoutMs: 0, retries: 0 }`：它只有一条后端，「等多久换下一个」
 * 对它没有意义，套上 30 秒首包超时反而会把「慢但正常」的回答砍断。
 * 只有自定义模型才有真正的多后端链，才需要这套调参。
 *
 * @param target - resolveModel 的结果。
 * @returns `{ timeoutMs, retries }`。
 */
function tuneOf(target) {
  if (target?.custom !== true) return { timeoutMs: 0, retries: 0 }
  return { timeoutMs: target.timeoutMs, retries: target.retries }
}
/**
 * 流式故障转移执行器。
 *
 * 逐后端尝试，把 chunk 先缓冲；第一个实质 chunk 到达才「提交」并向客户端透传。
 * 提交前的任何失败都静默切到下一个后端；提交后的失败原样抛出（由调用方 markFailed）。
 *
 * 三条控制律（顺序不可换）：
 * 1. **首包超时**：一个后端在 timeoutMs 内没吐出任何实质内容，就当它不会回话，
 *    直接放弃这一次尝试（不是放弃整个请求）。这条是用户最直接的诉求——
 *    排在首位的后端挂死时，用户不该盯着空屏等一分钟。
 * 2. **同后端重试**：失败且值得重试（见 isRetryableFailure）时先补一次，
 *    但重试**共用一份全局预算**（默认 5 次），不是每个后端各给 5 次。
 *    按后端给会让 3 个绑定的模型在真挂时打出 18 次上游调用，
 *    既拖时间又会把上游的限流彻底点着。
 * 3. **换后端**：预算耗尽或错误不值得重试，才顺延到下一个绑定。
 *
 * @param sctx - 作用域上下文（取 llm）。
 * @param deps - 转发依赖（用于记日志）。
 * @param plans - 后端计划列表（有序）。
 * @param baseOptions - GenerateOptions 的公共部分（messages / tools / temperature …）。
 * @param state - 出参：写入 plan（最终使用的后端）与 attempts（逐次尝试记录）。
 * @param tune - `{ timeoutMs, retries }`，未给则用默认值。
 * @returns 异步生成器。
 */
const PLUGIN_ID = 'dsh-lantern'

/**
 * #216：后台自检每一档的探测超时。
 *
 * 与用户请求的 `timeoutMs`（10-15 秒）刻意**分开**：
 *   · 自检在后台跑，不占用户时间，所以可以宽一点（探测要真正建立连接+等首包）
 *   · 但也不能太大 —— 一次自检要逐档跑，8 档 × 12 秒 = 96 秒，
 *     太久会让"链自愈"显得迟滞
 * 12 秒是折中：足够覆盖慢后端正常首包，又不会让整轮自检超过两分钟。
 */
const SWEEP_PROBE_TIMEOUT_MS = 12_000

/**
 * #215：思考预算保护的放大倍数。
 *
 * 实测 `hy4` 这类"思考很长"的模型：给 max_tokens=200 时，
 * 200 全被 thinking 吃光、正文 0 字（finish_reason=length / reasoning_only）。
 * 换后端治不了（它的多个绑定都这样），用户只会看到空回答。
 *
 * ×3 的依据：思考通常占 1/2~2/3 的预算，×3 后一般够"想完 + 写正文"。
 * 再大就要考虑是不是用户的 max_tokens 本身给得太小。
 */
const REASONING_BUDGET_BOOST = 3

/** #215：放大后的绝对上限（plan.maxOutput 缺失时的兜底）。 */
const REASONING_BUDGET_CEILING = 32768

async function* streamWithFailover(sctx, deps, plans, baseOptions, state, tune) {
  const { timeoutMs, retries } = resolveTune(tune)
  const attempts = []
  state.attempts = attempts
  let finalFailure
  /** #212：整个请求期间是否出现过首包超时（仅日志/诊断，不参与判定）。 */
  let anyTimedOut = false
  let budget = retries
  let index = 0
  let round = 0
  // ── 断点续写（committed 后断流）状态 ──
  // resumeText：本请求已向客户端吐出的全部 text-delta（跨后端累计，续写前缀）
  // committedFailure：committed 后的上游失败（触发续写的原因）
  // resumed：已续写次数（防 token 翻倍失控；每次请求最多 MAX_RESUMES 次）
  let resumeText = ''
  // #211：本轮累计的思考内容长度（不保留内容，只用来区分"只思考"与"完全空"）。
  let reasoningTextLen = 0
  // #215：本次请求是否已经尝试过"放大预算重试"（每请求最多一次，防无限增长）。
  let budgetBoosted = false
  let committedFailure = undefined
  let resumed = 0
  const MAX_RESUMES = 2
  // 本请求已被 adapter 明确拒掉的 GenerateOptions 字段（摘掉后原后端重试）。
  const strippedOptions = new Set()

  while (index < plans.length) {
    const plan = plans[index]
    round += 1
    const attempt = {
      binding: plan.binding,
      provider: plan.provider,
      model: plan.model,
      ok: false,
      ms: 0,
      fallback: index > 0,
      retry: round > index + 1,
      round,
    }
    attempts.push(attempt)
    const started = Date.now()
    const pending = []
    let committed = false
    let failure
    // ── #212：timedOut 的语义写清楚，避免"重试后重置"变成隐式陷阱 ──
    //
    // 它是**本轮尝试级**标记：每次进入 while 循环体重新设为 false，
    // 由下面的 setTimeout 在 timeoutMs 到点时置真。
    //
    // 当前"重试时重置"是无害的 —— 可重试的码（empty_completion /
    // reasoning_only_empty）与超时互斥，不会同时为真。
    // 但那是隐式假设：若哪天把 backend_timeout 改成可重试，
    // 第二次重试的 timedOut 就是 false，超时会被误判成空回答
    // → 漏记冷却 → 又回到"每个请求都陪慢后端等满 timeoutMs"的老问题。
    //
    // 所以额外维护一个**请求级**的 anyTimedOut（只用于日志与诊断，
    // 不参与任何判定），让"这次请求到底超时过没有"永远可查。
    let timedOut = false

    const guard = linkSignals(baseOptions.signal)
    // timeoutMs === 0 = 这个模型没配首包超时（普通模型的唯一路径）。
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          anyTimedOut = true
          guard.abort('lantern_timeout')
        }, timeoutMs)
      : undefined

    try {
      for await (const chunk of sctx.llm.stream({
        ...baseOptions,
        // 每档用**自己**的档位词（第十一轮 #121）：`baseOptions.reasoningEffort`
        // 是全链共享的单值，会在 3 档/5 档/8 档混编时被拉平。
        // 这里按 plan 覆写，没算出来的（无词表）就删掉该字段、交给上游默认。
        ...(plan.effortWord === undefined
          ? { reasoningEffort: undefined }
          : { reasoningEffort: plan.effortWord }),
        // 每档用**自己**的输出上限（第十三轮 #150）：
        // 用户要 200K 时，低上限绑定（如 @trae 128K）自动降到 128K 而不是被拒/截断。
        ...(plan.maxOutput === undefined || baseOptions.maxTokens === undefined
          ? {}
          : { maxTokens: Math.min(baseOptions.maxTokens, plan.maxOutput) }),
        provider: plan.provider,
        model: plan.model,
        signal: guard.signal,
      })) {
        // usage 由引擎统一采集：它可能在 commit 之前就到（被缓冲），调用方不能只在自己
        // 的循环里捕获，否则会丢掉这一次真实消耗的 token 记账。
        if (chunk?.type === 'usage') state.usage = chunk.usage
        const errorFinish = chunk?.type === 'finish' && chunk.reason?.kind === 'error'
        if (errorFinish && !committed) {
          // ── #203：超时的判定优先于上游给的错误码 ──
          //
          // 用户实测反馈（真实场景）：
          //   deepseek-v4-flash-1017@loomy 显示 time out，但**没进冷却**，
          //   下次请求又轮到它，再等 25 秒。而同一条链上
          //   sn-deepseek-v4-1-flash-1017@raccoon 报了 QUOTA_EXCEEDED 就正常进冷却。
          //
          // 根因就在这里：原来无条件用 `chunk.reason.failure`。
          // 而 `loomy` 这类慢后端在超时窗口的同一时刻可能返回一个 error finish 帧
          // （它自己也想说"我出错了"），于是 `failure.code` 变成**上游的码**。
          // 若那个码落在 `isBackendBlame` 的黑名单里（如 TRANSPORT + status:400），
          // 就判成"这次请求不对、不是后端的锅" → `recordFailure` 直接返回 0
          // → 永不冷却 → 每个请求都要先陪它等满 25 秒。
          //
          // 判定顺序必须是「我们的定时器先说」：
          //   · `timedOut` 为真 → 无论上游说什么，这次失败的性质就是**超时**，
          //     记 `backend_timeout`（isBackendBlame 对它恒为 true）；
          //   · `timedOut` 为假 → 才是上游自己的错误，照原样用它。
          //
          // 这也和 catch 分支（第 1881 行附近）的写法保持一致：
          // 那里本来就是 `failure = timedOut ? {code:'backend_timeout'} : {...}`。
          // 两处不一致会导致"抛异常的超时会冷却、返回错误帧的超时不会冷却"，
          // 而后者恰恰是更常见的形态（HTTP 200 + SSE error 帧）。
          failure = timedOut
            ? { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有返回内容', code: 'backend_timeout' }
            : (chunk.reason.failure ?? { message: '上游模型调用失败' })
          break
        }
        if (errorFinish && committed) {
          // committed 后的错误收尾：走续写，不把 error finish 帧抛给客户端
          committedFailure = chunk.reason.failure ?? { message: '上游模型调用失败' }
          break
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          resumeText += chunk.text
        }
        // ── #211：流式路径也要统计思考内容 ──
        //
        // 原来只累加 `text-delta`，`reasoning-delta` 完全被忽略，
        // 于是"想了 2000 字但一个字正文都没有"被判成 `empty_completion`。
        // 而非流式路径有 `aggregator.isReasoningOnly()`，能报出更准确的
        // `reasoning_only_empty`。
        //
        // 后果不是功能问题（两者都会换后端、都会记冷却），而是**排障问题**：
        // 同一个后端，流式报 `empty_completion`、非流式报 `reasoning_only_empty`，
        // 看 `X-Lantern-Attempt-Codes` 的人会以为这是两种不同的故障 ——
        // 我就为此在这轮调试里白绕过一次。
        //
        // 这里只做计数（不需要内容本身，续写前缀只要正文）：
        // 结束时据此在下面区分 `reasoning_only_empty` 与 `empty_completion`。
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          reasoningTextLen += chunk.text.length
        }
        if (committed) {
          yield chunk
          continue
        }
        // ── 关于 pending 缓冲（第十六轮 #173 调研结论，未改代码）──
        //
        // 曾怀疑是 `pending` 攒包导致"假流式"，动手改成"最后一档不缓冲"。
        // **实测证明这个假设是错的**，所以代码保持原样：
        //
        //   · `deepseek-v4.1-flash` 连测 8 次 → 8/8 真流式（13–16 时段有帧）
        //   · `hy4` 连测 8 次 → 8/8 真流式（18–19 时段有帧）
        //   · 两者最大静默都在 400–1,200ms，没有"卡几秒"的现象
        //
        // 真正的规律是**请求形状**决定的：
        //   单轮 user          → 11/20 时段 ✅
        //   system + user     →  2/20     ❌
        //   多轮对话            →  2/20     ❌
        //   长历史              →  2/20     ❌ 静默 4,917ms
        //   带 tools           →  2/20     ❌
        //
        // 但这与 pending 无关（pending 在首个实质帧到达时就清空了）。
        // 更可能是**上游（DSH llm.stream）在大请求上本身就吐得晚**——
        // 那属于内核行为，不在本插件能改的范围内。留此记录避免以后再走一遍。
        //
        // ⚠⚠ 第十八轮 #184 惨痛教训：这里曾经**写了两行 `pending.push(chunk)`**。
        //
        // 后果是灾难性的，而且是"静默的正确性错误"——不报错、不崩溃，
        // 只是每一帧都发两遍：
        //   · 文本重复：`TheThe`、`II`、`TheThe model output is weird`
        //     （客户端把两个 "The" 拼起来）
        //   · **tool_calls 重复**：模型看到"两个一模一样的工具调用"，
        //     执行完一个发现还有一个没执行 → 再调 → 无限死循环
        //   · 用户侧表现：`已搜索 14 次文件，执行 22 条命令` 反复刷屏
        //
        // 为什么难发现：单看代码像"多推一次没关系"（反正会清空），
        // 但 `for (const buffered of pending) yield buffered` 会把
        // 重复的帧**原样转发给客户端**，于是每次提交都翻倍。
        //
        // 只允许一行。改动这块时请连同 `yield` 循环一起看。
        pending.push(chunk)
        if (isSubstantiveChunk(chunk)) {
          committed = true
          // 已经出声了：首包超时到此结束，后面的慢属于「生成得久」，
          // 不该被首包超时打断（长回答本来就慢，砍掉等于伪造截断）。
          clearTimeout(timer)
          state.plan = plan
          attempt.ok = true
          attempt.ms = Date.now() - started
          attempt.committed = true
          // 已经吐出实质内容 = 这一档确实接住了请求，先把它从冷却里放出来。
          // **但不能当成"完整成功"**：它可能中途断流（这正是用户报的场景：
          // 第一个后端正常响应、中途断掉）。所以用 recordEngaged ——
          // 清掉 streak/冷却，但保留 breakStreak；真正的 recordSuccess
          // 要等这一轮写完（见下面的无 failure 分支）。
          deps.backendHealth?.recordEngaged(plan)
          for (const buffered of pending) yield buffered
          pending.length = 0
        }
      }
    } catch (error) {
      if (committed) {
        // 数据已吐出无法撤回——改为**断点续写**：
        // 半截内容作为 assistant 前缀重发给下一个后端，让它接着写完。
        // 注意：这里不能 break——catch 在 for await 的外层，break 会跳出整个
        // while 循环，绕过紧跟其后的续写块。置完 committedFailure 让控制流
        // 自然落到 if (committed) 分支即可（finally 已负责清理定时器/监听）。
        committedFailure = {
          message: error?.message ?? '上游调用失败',
          code: error?.code,
          status: error?.status,
        }
      }
      failure = timedOut
        ? { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有返回内容', code: 'backend_timeout' }
        : { message: error?.message ?? '上游调用失败', code: error?.code, status: error?.status };
    } finally {
      clearTimeout(timer)
      guard.dispose()
    }

    if (committed) {
      if (committedFailure === undefined) return
      // ── 断点续写：committed 后断流 ──
      attempt.error = maskSecrets(committedFailure.message ?? '上游调用失败')
      if (committedFailure.code !== undefined) attempt.errorCode = committedFailure.code
      attempt.committed = true
      // 健康记忆：这一档刚才出过字（上面已 recordEngaged：冷却清了，但
      // breakStreak 留着——这正是为了让"反复断流"能累进升级冷却）。
      // 中途断流同样是它不靠谱的证据——用户描述的场景正是这个：
      // 「第一个模型正常响应，期间中间断掉了，轮询到第二个」。
      // 不记这一笔的话，下次请求它仍会排在最前面，等于每条长回答都要
      // 在同一个位置断一次、再让下一个后端重写半篇。记在它头上，冷却期内
      // 它排到链尾，长回答直接由健康的那家从第一字开始写。
      //
      // 例外：**客户端自己掐断的不算**。用户关页面/按停止会让外层 signal abort，
      // 那不是后端的锅，记上去等于「谁先被取消谁进冷宫」。
      const abortByClient = baseOptions.signal?.aborted === true
      const streamCooldownMs = abortByClient
        ? 0
        : deps.backendHealth?.recordStreamBreak(plan, committedFailure) ?? 0
      if (streamCooldownMs > 0) {
        attempt.cooldownSec = Math.ceil(streamCooldownMs / 1000)
        deps.log?.(
          'warn',
          '[lantern] 后端冷却 ' + attempt.cooldownSec + ' 秒（' + plan.binding + '，已输出中途断流）：后续请求把它排到链尾，到期自动归位',
        )
      }
      deps.log?.(
        'warn',
        '[lantern] 后端已输出中途断流（' + plan.binding + '，已产出 ' + resumeText.length + ' 字符）：' + (committedFailure.message ?? '未知错误'),
      )
      const hasNext = index + 1 < plans.length
      const canResume = hasNext && resumed < MAX_RESUMES && resumeText.length > 0
      if (!canResume) {
        // 无处续写：保持旧语义——把 committed 后的失败抛给调用方（markFailed → error 帧）
        state.failure = committedFailure
        state.committedFailure = true
        throw Object.assign(new Error(committedFailure.message ?? '上游调用失败'), {
          code: committedFailure.code,
          status: committedFailure.status,
          lanternCommittedFailure: true,
        })
      }
      // 换下一个后端，把半截 assistant 内容作为前缀塞进 messages 续写。
      index += 1
      resumed += 1
      state.resumed = resumed
      const resumePlan = plans[index]
      deps.log?.(
        'warn',
        '[lantern] 断点续写：切到后端 ' + resumePlan.binding + '，携带 ' + resumeText.length + ' 字符前缀',
      )
      // 续写 messages：原上下文 + 半截 assistant 前缀 + 续写指令（user）。
      // 不改 baseOptions 引用本身的安全——这里赋值的是新对象，外层调用方已解构使用。
      baseOptions = {
        ...baseOptions,
        messages: [
          ...baseOptions.messages,
          createAssistantMessage({
            content: [{ type: 'text', text: resumeText }],
            source: { kind: 'model', provider: PLUGIN_ID, model: 'lantern' },
          }),
          createUserMessage({
            content: [{ type: 'text', text: '（系统提示：上一条回答因上游中断停在这里。请从该内容结尾处继续写完剩余部分，不要重复已写内容，不要解释中断原因，直接续写。）' }],
          }),
        ],
      }
      committedFailure = undefined
      continue
    }
    attempt.ms = Date.now() - started

    // 零产出：流跑完了、没有失败、但一个字都没吐（也没有工具调用）。
    // 不能当成功——见 isSubstantiveChunk 里 finish 那条的说明。
    //
    // ── #205：超时要优先于 empty_completion 判定 ──
    //
    // 用户实测（决定性证据，`X-Lantern-Attempt-Codes` 头）：
    //   x-lantern-attempt-codes: #1=empty_completion,#2=empty_completion,#3=QUOTA_EXCEEDED,#4=ok
    //   → 链首的 `deepseek-v4-flash-1017@loomy` 明明超时了（10 秒 timeoutMs），
    //     却被标成 `empty_completion` 而不是 `backend_timeout`。
    //
    // 原因就在这行原来只判 `failure === undefined`：
    //   `guard.abort('lantern_timeout')` 让 for-await **正常结束**（不抛异常），
    //   上游也没返回 error finish 帧 —— 于是 `failure` 仍是 undefined，
    //   `resumeText` 是空串，直接落进 `empty_completion` 分支。
    //
    // 而 `empty_completion` 在下方（第 2074 行）被明确排除在冷却之外：
    //   skipCooldown = code === 'empty_completion' || code === 'reasoning_only_empty'
    // 那条规则本来是对的（空回答是单次运气，不该一票否决一个后端），
    // 但它**不该套在超时上**：超时是"这个后端 10 秒里一个字都没给"，
    // 是明确的能力/可用性问题，必须记冷却。
    //
    // 所以先判 `timedOut`：
    //   · 超时 → `backend_timeout`（isBackendBlame 恒 true → 记冷却）
    //   · 未超时且零产出 → 再看有没有思考内容：
    //       - 有 → `reasoning_only_empty`（想了但没写，语义同非流式路径）
    //       - 没有 → `empty_completion`（什么都没给）
    //
    // #211：最后这两档的区分是补齐流式/非流式的口径。
    // 两者**行为完全一致**（都会换后端、都记完整冷却），
    // 区别只在诊断头里报哪个码 —— 但排障时那个名字很重要。
    if (failure === undefined && resumeText.length === 0) {
      if (timedOut) {
        failure = { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有返回任何内容', code: 'backend_timeout' }
      } else if (reasoningTextLen > 0) {
        failure = {
          message: '上游只输出推理、没有正文（已思考 ' + reasoningTextLen + ' 字符），按空回答处理',
          code: 'reasoning_only_empty',
        }
        attempt.reasoningOnly = true
      } else {
        failure = { message: '上游返回了空内容（0 字，也没有工具调用）', code: 'empty_completion' }
      }
      attempt.empty = true
    }

    // ── #215：思考预算保护（流式）──
    //
    // 实测 `hy4`：max_tokens=200 时 200 全给 thinking，正文 0 字。
    // 现有处理只是换下一个后端 —— 但它的所有绑定都思考很长，
    // 换过去还是同样结果，用户最终拿到空回答。
    //
    // 所以这里先试着"放大预算重试当前后端"：
    //   条件：失败码是 reasoning_only_empty（网关已判定"想了但没写"）
    //        且本请求还没放大过
    //        且放大后确实能变大（不超过 plan.maxOutput）
    //   动作：max_tokens × REASONING_BUDGET_BOOST，continue 重试当前档
    //
    // 为什么**不消耗 retry budget**：这不是"再赌一次同样的请求"，
    // 而是"用一个更合适的参数再发一次"（与摘掉 stop 字段重试同一纪律）。
    // 为什么优先于换后端：换后端要重新付一次首包延迟，而放大预算
    // 大概率一次就能拿到正文 —— 先试成本更低的那个。
    if (failure !== undefined
        && failure.code === 'reasoning_only_empty'
        && budgetBoosted === false
        && typeof baseOptions.maxTokens === 'number'
        && baseOptions.maxTokens > 0) {
      const cap = typeof plan.maxOutput === 'number' ? plan.maxOutput : REASONING_BUDGET_CEILING
      const boosted = Math.min(Math.round(baseOptions.maxTokens * REASONING_BUDGET_BOOST), cap)
      if (boosted > baseOptions.maxTokens) {
        budgetBoosted = true
        const from = baseOptions.maxTokens
        baseOptions = { ...baseOptions, maxTokens: boosted }
        deps.log?.(
          'warn',
          '[lantern] 思考吃光预算（' + plan.binding + '）→ max_tokens ' + from + ' → ' + boosted + ' 后重试',
        )
        attempt.budgetBoosted = true
        attempt.budgetFrom = from
        attempt.budgetTo = boosted
        // #217：给这次 attempt 一个明确的终态，别让它落成 `unknown`。
        //
        // 预算放大用的是 `continue`（重试当前档、不换后端）——
        // 于是这一轮 attempt 既没设 ok、也没设 error/errorCode，
        // 诊断头里就成了 `#1=unknown`。功能上无害（那次尝试确实"没结论，
        // 因为换了预算重来"），但看头的人会以为"这里出了个奇怪的错误"。
        //
        // 实测：重启后所有模型的 #1 都显示 unknown，非常容易误导排障方向。
        attempt.errorCode = 'budget_boosted'
        attempt.error = `思考占满 max_tokens=${from}，已提升到 ${boosted} 重试`
        failure = undefined
        finalFailure = undefined
        continue
      }
    }

    // ── #214：流式路径也要检测「工具调用被渲染成文本标记」──
    //
    // 非流式路径一直有这个检测（见 `collectWithFailover` 里的
    // `aggregator.leakedToolMarkup()`），但流式路径**完全没有** ——
    // 同一个后端在 stream=true / false 下行为不一致：
    //   · 非流式：标 `tool_markup_leaked`、换下一个后端（下家可能支持）
    //   · 流式  ：把标记原样流给客户端，一个字都不提示
    //
    // 后果是用户看到"模型在胡说八道"（一堆 `<｜｜DSML｜｜ invoke>`），
    // 而模型其实是想调工具，换一个支持结构化工具的后端就好了。
    //
    // 判定条件与非流式逐字对齐：
    //   1. 本轮确实带了 tools（`hasToolsHere`）
    //   2. 正文里命中了已知的标记形态
    // 命中后把它降级成一次可重试失败，让故障转移顺延到下一个绑定。
    //
    // ⚠ 只在 `failure === undefined` 时判：已经有更明确的失败原因时，
    //    不该被这个"软"判定覆盖（超时/限流更值得被优先报告）。
    if (failure === undefined) {
      const hasToolsHere = Array.isArray(baseOptions?.tools) && baseOptions.tools.length > 0
      if (hasToolsHere) {
        const leaked = detectLeakedToolMarkup(resumeText)
        if (leaked !== undefined) {
          failure = {
            message: '后端把工具调用渲染成了文本标记（' + leaked.slice(0, 24) + '），不支持结构化工具调用',
            code: 'tool_markup_leaked',
          }
          attempt.markupLeaked = true
        }
      }
    }

    if (failure === undefined) {
      state.plan = plan
      attempt.ok = true
      // 健康记忆：这一档**写完了** → 全部清零（连败、断续、冷却），
      // 下次请求回到它配置的位置。这才是真正的"完整成功"。
      deps.backendHealth?.recordSuccess(plan)
      for (const buffered of pending) yield buffered
      return
    }

    attempt.error = maskSecrets(failure.message ?? '上游调用失败')
    if (failure.code !== undefined) attempt.errorCode = failure.code
    finalFailure = failure

    // ── 先判「我们自己发错了参数」，再判「后端坏了」 ──
    // 顺序不能反：adapter 拒收 stop 是网关侧的问题，把这一档记进冷却等于
    // 让一个完全健康的后端替我们的多嘴背锅，接下来的请求就再也用不上它。
    // 摘字段后在同一后端重来一次，不花重试预算——这不是"再赌一次"，
    // 而是换一个正确的请求发出去。
    if (!committed && baseOptions.signal?.aborted !== true) {
      const stripped = stripUnsupportedOption(baseOptions, failure.message, strippedOptions)
      if (stripped !== undefined) {
        baseOptions = stripped.next
        deps.log?.(
          'warn',
          '[lantern] 后端 ' + (index + 1) + '/' + plans.length + ' 的 adapter 不支持 ' +
            stripped.field + '，已摘掉该参数并在同一后端重试（' + plan.binding + '）',
        )
        attempt.strippedOption = stripped.field
        failure = undefined
        finalFailure = undefined
        continue
      }
    }

    // 健康记忆：这次失败记在这一档头上（客户端自己的错不记，见 isBackendBlame）。
    // 下一次请求构造链时它会被排到链尾，于是不必每个请求都为同一个已知故障
    // 再等满一次首包超时；冷却到期它自己回到原位。
    //
    // 客户端自己掐断的不算：用户点停止会让外层 signal abort，抛出来的
    // 取消错误既没有 status 也没有 code，isBackendBlame 会把它当成后端的锅
    // ——「谁先被取消谁进冷宫」，这是纯粹的错误归因。
    const abortByClient = baseOptions.signal?.aborted === true
    // ── #210：不再区分"软/硬"失败，一律按完整冷却处理 ──
    //
    // 历史（同一个问题的三次演进，留档避免以后又绕回去）：
    //   · 第十四轮 #153：`empty_completion`/`reasoning_only_empty` **完全不冷却**
    //     —— 理由是"空回答是单次运气，不该一票否决后端"。
    //     实测反例：`@loomy` 反复只思考不回答，每个请求都要先陪它等满 timeoutMs。
    //   · #209：改成"软冷却"（baseMs/6，不动 streak）。
    //     —— 能用，但多了一套特殊路径、两处代码要同步、面板多一个 softFail 字段。
    //   · #210（当前）：用户明确"没有必要搞软冷却"，于是统一成完整冷却。
    //
    // 为什么统一更对：#207 之后冷却中的后端是**直接跳过**的，
    // 所以"冷却时长"才是唯一的调节旋钮 —— 再区分软硬只是把旋钮拆成两个，
    // 而两个旋钮的组合行为更难解释、更难排障。
    // 一次空回答让一个后端冷却几分钟，代价远小于"每个请求都白等 10 秒"。
    //
    // #232：加 `noEscalate` —— 空回答类失败仍记完整冷却，但**不指数翻倍**。
    // 实测：hy4 在 max_tokens=40 时每档都 reasoning_only_empty，streak 累加到封顶
    // → 该模型整整 1 小时不可用（连合理参数也进不来）。这类失败随参数会自愈，
    // 不该按"后端坏了"那样升级冷却。
    const cooldownMs = abortByClient ? 0 : deps.backendHealth?.recordFailure(plan, failure, {
      noEscalate: failure?.code === 'reasoning_only_empty' || failure?.code === 'empty_completion',
    }) ?? 0
    if (cooldownMs > 0) {
      attempt.cooldownSec = Math.ceil(cooldownMs / 1000)
      deps.log?.(
        'warn',
        '[lantern] 后端冷却 ' + attempt.cooldownSec + ' 秒（' + plan.binding + '）：后续请求把它排到链尾，到期自动归位',
      )
    }

    // 先决定「原地重试」还是「换后端」。重试要花预算，且只对可能自愈的错误花。
    const canRetry = budget > 0 && isRetryableFailure(failure)
    deps.log?.(
      'warn',
      '[lantern] 后端 ' + (index + 1) + '/' + plans.length + (canRetry ? ' 重试' : ' 失败') + '（' + plan.binding + '）：' + (failure.message ?? '未知错误'),
    )
    if (canRetry) {
      budget -= 1
      attempt.retried = true
      continue
    }
    index += 1
  }

  state.failure = finalFailure ?? { message: '上游调用失败' }
}

/**
 * 非流式故障转移执行器。
 *
 * 非流式天然安全：整段回答在聚合完成后才发出，因此只要聚合结果是失败就能重试。
 * 聚合器由调用方提供工厂（OpenAI / Anthropic 形状不同）。
 *
 * 控制律与流式版**完全一致**（首包超时 → 同后端重试 → 换后端），
 * 只是这里没有「提交」这一层，所以超时定时器要覆盖整个生成过程。
 * 这也是有意的：非流式本来就要等全部生成完才回话，中途断开没有任何收益。
 *
 * @param sctx - 作用域上下文。
 * @param deps - 转发依赖。
 * @param plans - 后端计划列表。
 * @param baseOptions - GenerateOptions 公共部分。
 * @param state - 出参：plan / attempts。
 * @param createAggregator - (plan) => 聚合器实例。
 * @param tune - `{ timeoutMs, retries }`。
 * @returns 成功的聚合器；全部失败时返回最后一次的聚合器（其 failure 有完整错误信息）。
 */
async function collectWithFailover(sctx, deps, plans, baseOptions, state, createAggregator, tune) {
  const { timeoutMs, retries } = resolveTune(tune)
  const attempts = []
  state.attempts = attempts
  let finalFailure
  let lastAggregator
  /** #212：整个请求期间是否出现过首包超时（仅日志/诊断，不参与判定）。 */
  let anyTimedOut = false
  /** #215：本次请求是否已经尝试过"放大预算重试"（每请求最多一次）。 */
  let budgetBoosted = false
  let budget = retries
  let index = 0
  let round = 0
  // 与流式路径同一套：adapter 明确拒收的字段，摘掉后在同一后端重来。
  const strippedOptions = new Set()

  while (index < plans.length) {
    const plan = plans[index]
    round += 1
    const attempt = {
      binding: plan.binding,
      provider: plan.provider,
      model: plan.model,
      ok: false,
      ms: 0,
      fallback: index > 0,
      retry: round > index + 1,
      round,
    }
    attempts.push(attempt)
    const started = Date.now()
    const aggregator = createAggregator(plan)
    lastAggregator = aggregator
    let failure
    let timedOut = false

    const guard = linkSignals(baseOptions.signal)
    // 非流式用**空闲超时**（每收到一块就重新计时），不是「整段生成」超时。
    // 用户能忍受的是「迟迟不开口」，不是「说话慢」：一个 40 秒的正常长回答
    // 若被 30 秒定时器从中间掐断，会被误判成后端故障并切走——把好后端当坏后端。
    // 空闲超时两头都对：迟迟不来 → 切；中途卡死 30 秒无任何事件 → 也切；
    // 只要还在持续吐字，就不会被打断。
    let timer
    const armTimer = () => {
      if (!(timeoutMs > 0)) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        anyTimedOut = true
        guard.abort('lantern_timeout')
      }, timeoutMs)
    }
    armTimer()

    try {
      for await (const chunk of sctx.llm.stream({
        ...baseOptions,
        // 每档用自己的档位词（同流式路径，#121）
        ...(plan.effortWord === undefined
          ? { reasoningEffort: undefined }
          : { reasoningEffort: plan.effortWord }),
        // 每档用自己的输出上限（同流式路径，#150）
        ...(plan.maxOutput === undefined || baseOptions.maxTokens === undefined
          ? {}
          : { maxTokens: Math.min(baseOptions.maxTokens, plan.maxOutput) }),
        provider: plan.provider,
        model: plan.model,
        signal: guard.signal,
      })) {
        // ⚠ 非流式的 usage 也必须在这里接住（第十轮 #105）。
        //
        // 原来只有这一行 `aggregator.push(chunk)`，而三个非流式调用点读的都是
        // `fo2.usage` —— 那个字段**从来没有人写过**。后果不是"少记一次"：
        //   · 账本里非流式请求的 usage 字段整块缺失 → 成本/命中率报表系统性失真；
        //   · 熔断器的 token 计量 `recordSuccess(..., options.usage?.outputTokens ?? 0)`
        //     恒为 0 → 对非流式请求完全失效；
        //   · `toLedgerUsage(undefined)` 被当成 0 → 用户看到"所有请求都没用量"。
        //
        // 流式路径的同一位置（streamWithFailover）一直有这行，两边必须逐字对齐 ——
        // 这也是本文件里反复写"两处判据必须一致"的原因。实测：三条协议的非流式
        // 请求 HTTP 响应里 usage 正常（prompt_tokens:9），账本里却什么都没有。
        if (chunk?.type === 'usage') state.usage = chunk.usage
        aggregator.push(chunk)
      }
    } catch (error) {
      failure = timedOut
        ? { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有任何响应', code: 'backend_timeout' }
        : { message: error?.message ?? '上游调用失败', code: error?.code, status: error?.status };
    } finally {
      clearTimeout(timer)
      guard.dispose()
    }
    attempt.ms = Date.now() - started

    if (failure === undefined && aggregator.failure !== undefined) failure = aggregator.failure
    // 空产出不能算成功：上游秒回一个 0 字回答时 content 是 null / ""，
    // 而这里一旦判成 ok 就等于「这一档已经交付了结果」——既不会换后端，
    // 又会被账本记成 status=ok。实测这组合把整条链的可用性变成假象：
    // data/usage.jsonl 里 1003 条 out=0 全是这种"成功的空回答"。
    // 与流式路径同一判据（那里用 resumeText.length === 0），两处必须一致，
    // 否则"非流式好、流式坏"或反之的差异会变成极难查的偶发。
    //
    // #205：同样要优先判超时（与流式路径的第 2015 行保持一致）。
    // 非流式的 `guard.abort('lantern_timeout')` 会让 for-await 正常结束、
    // 不抛异常，于是 `failure` 仍是 undefined、aggregator 是空的 ——
    // 结果和"上游真给了空回答"完全一样，无法区分。
    // 不加这个判定的话，非流式的超时会同样被标成 empty_completion 而跳过冷却。
    if (failure === undefined && typeof aggregator.isEmpty === 'function' && aggregator.isEmpty()) {
      failure = timedOut
        ? { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没有任何响应', code: 'backend_timeout' }
        : { message: '上游返回了空内容（0 字，也没有工具调用）', code: 'empty_completion' }
      attempt.empty = true
    }
    // ── 「只思考不回答」也必须当失败重试（第十四轮 #152）──
    //
    // 实测 `Qwen3.8-Flash`：要它写 300 字短文，`max_tokens` 给 500 / 2000 / 4000 时
    // **三次里有三次**返回 `finish_reason: reasoning_only`、正文 0 字、正文空。
    // 只有给 1000 那次正常（270 字）。
    //
    // 对调用方来说这就是「模型什么都没说」—— 它不可用，和报错等价。
    // 而原来这里只要 `text.length > 0` 之外还有 reasoning 就判成功，
    // 于是把「空回答」当成交付，用户看到的是「有响应但没内容 → 这个模型用不了」。
    //
    // 现在降级成可重试失败：换后端 / 换预算再试一次，比直接给个空回答强。
    // 判据用 aggregator 的公开方法（`isReasoningOnly` 存在时才算数），
    // 避免对不认识的聚合器类型误伤。
    if (failure === undefined && typeof aggregator.isReasoningOnly === 'function'
        && aggregator.isReasoningOnly() === true) {
      // ── #206：超时优先于 reasoning_only_empty ──
      //
      // 用户实测（`X-Lantern-Attempt-Codes` 头）：
      //   #1=reasoning_only_empty  ← 链首的 loomy 又被这个码挡在冷却门外
      //
      // 这两个码语义完全不同，但都跳过冷却（见下方 skipCooldown）：
      //   · `reasoning_only_empty`：模型**想完了**，只是正文没写出来
      //     —— 可能是 `max_tokens` 给少了，换个预算再试可能就好，不该一票否决后端；
      //   · `backend_timeout`：模型**10 秒里连思考都没跑完**（或思考吃光了时间）
      //     —— 这是明确的能力/可用性问题，必须冷却。
      //
      // 如果不区分，一个"思考极慢"的后端会永远停在链首：
      // 它的表现就是 reasoning_only_empty，于是永不冷却，每个请求陪它等满 10 秒。
      failure = timedOut
        ? { message: '上游在 ' + Math.round(timeoutMs / 1000) + ' 秒内没能产出正文', code: 'backend_timeout' }
        : {
            message: '上游只输出推理、没有正文（reasoning_only），按空回答处理',
            code: 'reasoning_only_empty',
          }
      attempt.reasoningOnly = true
    }
    // ── #215：思考预算保护（非流式，与流式路径同一判据）──
    //
    // 实测 `hy4` 非流式：max_tokens=200 时 finish_reason=reasoning_only、
    // content=""、completion_tokens=200 里 reasoning_tokens=200 ——
    // 预算全给思考，正文零字。
    //
    // 现有处理只是换后端，但该模型所有绑定都思考很长，换过去还是空。
    // 这里先试"放大预算重试当前后端"（成本比换后端低），
    // 拿到正文就省下一次首包延迟；拿不到才继续走原来的换后端逻辑。
    if (failure !== undefined
        && failure.code === 'reasoning_only_empty'
        && budgetBoosted === false
        && typeof baseOptions.maxTokens === 'number'
        && baseOptions.maxTokens > 0) {
      const cap = typeof plan.maxOutput === 'number' ? plan.maxOutput : REASONING_BUDGET_CEILING
      const boosted = Math.min(Math.round(baseOptions.maxTokens * REASONING_BUDGET_BOOST), cap)
      if (boosted > baseOptions.maxTokens) {
        budgetBoosted = true
        const from = baseOptions.maxTokens
        baseOptions = { ...baseOptions, maxTokens: boosted }
        deps.log?.(
          'warn',
          '[lantern] 思考吃光预算（' + plan.binding + '）→ max_tokens ' + from + ' → ' + boosted + ' 后重试',
        )
        attempt.budgetBoosted = true
        attempt.budgetFrom = from
        attempt.budgetTo = boosted
        // #217：给这次 attempt 一个明确的终态，别让它落成 `unknown`。
        //
        // 预算放大用的是 `continue`（重试当前档、不换后端）——
        // 于是这一轮 attempt 既没设 ok、也没设 error/errorCode，
        // 诊断头里就成了 `#1=unknown`。功能上无害（那次尝试确实"没结论，
        // 因为换了预算重来"），但看头的人会以为"这里出了个奇怪的错误"。
        //
        // 实测：重启后所有模型的 #1 都显示 unknown，非常容易误导排障方向。
        attempt.errorCode = 'budget_boosted'
        attempt.error = `思考占满 max_tokens=${from}，已提升到 ${boosted} 重试`
        failure = undefined
        finalFailure = undefined
        continue
      }
    }

    // 工具调用被渲染成文本标记 = 这一档**接不住**结构化工具（第十一轮 #127）。
    //
    // 实测：某档把历史里的 tool-call 块渲染成 `<｜｜DSML｜｜ calls>…` 当正文吐出来。
    // 有文本 → 上面那条 isEmpty 判不出来 → 于是被当成"成功"，**不会换后端**，
    // 客户端拿到一坨标记 + `tool_calls: []`，以为模型在胡说八道。
    //
    // 这里把它降级成一次可重试的失败：有下家就换（下家可能支持结构化工具），
    // 没有下家就如实标 `tool_markup_leaked` 返回（见 protocol.js 的 end()）。
    // 注意：**不记后端冷却** —— 不是它挂了，是它的模板不支持这种内容块。
    //
    // ⚠ `wantsTools` 必须在这里从 baseOptions 现算（第十二轮 #139）。
    //    原来直接引用外层的 `wantsTools`，那是 handleChat 的局部变量，
    //    这个函数根本看不到 → ReferenceError → 整条请求 500。
    //    判据只用 baseOptions.tools（本函数可见的东西），不依赖任何外层作用域。
    const hasToolsHere = Array.isArray(baseOptions?.tools) && baseOptions.tools.length > 0
    if (failure === undefined && hasToolsHere === true
        && typeof aggregator.leakedToolMarkup === 'function') {
      const leaked = aggregator.leakedToolMarkup()
      if (leaked !== undefined) {
        failure = {
          message: `后端把工具调用渲染成了文本标记（${leaked.slice(0, 24)}），不支持结构化工具调用`,
          code: 'tool_markup_leaked',
        }
        attempt.markupLeaked = true
      }
    }
    if (failure === undefined) {
      state.plan = plan
      attempt.ok = true
      // 非流式同理：整段收下 = 这一档可用，清零冷却。
      deps.backendHealth?.recordSuccess(plan)
      return aggregator
    }

    attempt.error = maskSecrets(failure.message ?? '上游调用失败')
    if (failure.code !== undefined) attempt.errorCode = failure.code
    finalFailure = failure

    // 与流式路径同序：先判「我们自己发错了参数」，再判「后端坏了」。
    // 非流式这里天然安全（整段还没发出去），摘字段重来毫无副作用。
    if (baseOptions.signal?.aborted !== true) {
      const stripped = stripUnsupportedOption(baseOptions, failure.message, strippedOptions)
      if (stripped !== undefined) {
        baseOptions = stripped.next
        deps.log?.(
          'warn',
          '[lantern] 后端 ' + (index + 1) + '/' + plans.length + ' 的 adapter 不支持 ' +
            stripped.field + '，已摘掉该参数并在同一后端重试（' + plan.binding + '）',
        )
        attempt.strippedOption = stripped.field
        failure = undefined
        finalFailure = undefined
        continue
      }
    }

    // 健康记忆：与流式路径同一套记账（客户端自己的错不记，见 isBackendBlame）。
    // 客户端主动取消同理不记——取消是调用方的意愿，不是后端不可用。
    const abortByClient = baseOptions.signal?.aborted === true
    // ── #210：不再区分"软/硬"失败，一律按完整冷却处理（与流式路径同一判据）──
    // 完整理由见 `streamWithFailover` 里同位置的长注释（两处必须一致）。
    // #232：空回答类失败加 `noEscalate`（记完整冷却但不翻倍）—— 见流式路径的说明。
    const cooldownMs = abortByClient ? 0 : deps.backendHealth?.recordFailure(plan, failure, {
      noEscalate: failure?.code === 'reasoning_only_empty' || failure?.code === 'empty_completion',
    }) ?? 0
    if (cooldownMs > 0) {
      attempt.cooldownSec = Math.ceil(cooldownMs / 1000)
      deps.log?.(
        'warn',
        '[lantern] 后端冷却 ' + attempt.cooldownSec + ' 秒（' + plan.binding + '）：后续请求把它排到链尾，到期自动归位',
      )
    }

    const canRetry = budget > 0 && isRetryableFailure(failure)
    deps.log?.(
      'warn',
      '[lantern] 后端 ' + (index + 1) + '/' + plans.length + (canRetry ? ' 重试' : ' 失败') + '（' + plan.binding + '）：' + (failure.message ?? '未知错误'),
    )
    if (canRetry) {
      budget -= 1
      attempt.retried = true
      continue
    }
    index += 1
  }

  state.failure = finalFailure ?? { message: '上游调用失败' }
  return lastAggregator
}

/**
 * 模型目录用的「能力摘要」：和执行侧同一套语义，不再报全体交集。
 *
 * 为什么不能用 intersectCapabilityViews 当顶层值：
 *   执行侧已经是「本次请求要什么硬能力，就筛掉没有证据的档，转发给支持的档」。
 *   如果展示侧报全体交集，就会出现两种自相矛盾：
 *     1. 同一个模型，目录说 tools=unknown，带上 tools 却能 200；
 *     2. 更糟的是**客户端根本不会发**：DSH 这类调用方读的是顶层
 *        `capabilities.tools`，看到 unknown 就不启用工具了 —— 于是
 *        "能带工具"这件事永远没机会被验证，接口把自己的能力藏死了。
 *
 * 所以顶层按**执行侧的真实语义**归并：
 *   - 任一档 supported → supported（有档能用，且执行侧会筛链保证只发给它们）
 *   - 全部 unsupported → unsupported（确实没人行）
 *   - 全都没证据 → unknown
 *   - 有 unsupported 也有 unknown 但没有 supported → unknown
 *     （不能报 unsupported：那是在断言"确定不行"，而我们只是没证据）
 *
 * 同时仍然给 `byBackend`：谁支持什么一目了然，运维不需要猜。脱敏时
 * 用 `#1`/`#2` 代替 provider 名（档数不是秘密，链头一直在报；"第几档是哪家"才是拓扑）。
 *
 * @param plans - 执行链（含 provider/model）。
 * @param views - 与 plans 一一对应的 describe() 结果。
 * @param masked - 是否脱敏。
 * @returns `{ merged, byBackend }`。
 */
function summarizeCapabilities(plans, views, masked) {
  const chain = Array.isArray(plans) ? plans : []
  const cells = Array.isArray(views) ? views : []
  const byBackend = []
  for (let i = 0; i < chain.length; i += 1) {
    const view = cells[i]
    if (view === undefined || view === null) continue
    /** @type {Record<string, unknown>} */
    const row = {}
    for (const field of ['text', 'image', 'reasoning', 'tools', 'parallelTools', 'jsonMode', 'temperature', 'stop']) {
      const cell = view[field]
      if (cell !== undefined) row[field] = cell.value
    }
    // ⚠ 逐档的真实词表必须外显：
    // 顶层 efforts 是各档的**并集**，客户端只知道"这四个值里有哪个能用"，
    // 不知道"哪一档能用"（实测 glm-5.3 传 xhigh 时 6 档只剩 1 档）。
    // 不公开这个，调用方只能靠猜，或者在一次失败后才发现。
    const efforts = Array.isArray(view.reasoning?.efforts)
      ? view.reasoning.efforts.filter((e) => typeof e === 'string')
      : []
    if (efforts.length > 0) row.reasoningEfforts = efforts
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      const cell = view[field]
      if (typeof cell?.value === 'number') row[field] = cell.value
    }
    byBackend.push({
      backend: masked ? `#${i + 1}` : `${chain[i].model}@${chain[i].provider}`,
      ...row,
    })
  }

  const merged = intersectCapabilityViews(cells)
  if (merged === undefined) return { merged, byBackend }

  // 三态归并：任一 supported 即 supported（执行侧会筛链），全 unsupported 才 unsupported。
  const FIELD_LIST = ['text', 'image', 'reasoning', 'streaming', 'tools', 'parallelTools', 'jsonMode', 'temperature', 'stop']
  const union = { ...merged }
  for (const field of FIELD_LIST) {
    const values = []
    for (const view of cells) {
      if (view === undefined || view === null) continue
      values.push(view?.[field]?.value ?? 'unknown')
    }
    if (values.length === 0) { union[field] = { value: 'unknown', source: 'union' }; continue }
    const source = cells.find?.((v) => v?.[field]?.value === 'supported')?.[field]?.source ?? 'union'
    if (values.includes('supported')) union[field] = { value: 'supported', source }
    else if (values.every((v) => v === 'unsupported')) union[field] = { value: 'unsupported', source: 'union' }
    else union[field] = { value: 'unknown', source: 'union' }
  }
  // 数值型仍取最小（这是真正的保守下界：说小不说大，客户端按小值规划不会溢出）。
  for (const field of ['contextWindow', 'maxOutputTokens', 'systemPromptUpdate']) {
    union[field] = merged[field]
  }
  // ⚠ 上面的三态循环把每个字段**整个换掉**成 `{ value, source }`，
  // `reasoning.efforts` 就是这么丢的。丢掉的后果不是"少显示一个列表"，
  // 而是 `/v1/models` 的读者（比如 DSH 自己）看不到有哪些档位可用，
  // 只能瞎猜或干脆不发 reasoning_effort——把能力藏起来比报错更糟。
  // 这里补回并集，并保留 `effortsDiffers`（各档词表不一致时调用方要能知道）。
  union.reasoning = mergeReasoningCell(cells, union.reasoning)
  // 四档契约：告诉调用方“只说 minimal/low/medium/high 就行”，
  // 以及每档在这条链上会落到哪个真实词（面板与 SDK 都要靠这个自描述）。
  // 不脱敏时给 backend 级对照表（排障用）；脱敏时只给契约层（不泄拓扑）。
  union.contractLevels = describeChainLevels(cells.map((v) => ({
    efforts: Array.isArray(v?.reasoning?.efforts) ? v.reasoning.efforts.filter((e) => typeof e === 'string') : [],
  })))
  return { merged: union, byBackend }
}

/**
 * 一句话说清「顶层写着支持，但不是每一档都支持」这件事。
 *
 * 顶层现在按并集归并（任一档 supported 即 supported），这是**执行侧的真实语义**：
 * 请求进来会先筛掉没证据的档。但只看顶层的人容易以为「全链都支持」，
 * 于是在某档挂掉、切到不支持的那档时，突然收到能力拒绝 —— 觉得莫名其妙。
 *
 * 所以这里由接口主动说清："支持，但不是所有后端都支持；不可用的档会被跳过"。
 * 无歧义时（全支持 / 全不支持 / 无证据）不返回，避免噪音。
 *
 * @param merged - 归并后的能力视图。
 * @param byBackend - 各档摘要。
 * @returns 说明字符串（无歧义时不返回）。
 */
function capabilityNoteOf(merged, byBackend) {
  if (merged === undefined || byBackend.length === 0) return undefined
  const hard = ['tools', 'jsonMode', 'image', 'reasoning']
  // 顶层说支持、但只有部分档支持 → 值得说明（用户要知道"这不是全链能力"）。
  const partial = hard.filter((field) => {
    if (merged[field]?.value !== 'supported') return false
    const supporters = byBackend.filter((row) => row[field] === 'supported').length
    return supporters > 0 && supporters < byBackend.length
  })
  if (partial.length > 0) {
    // 措辞必须与执行侧一致：「没证据」的档**不跳过**，只排到链尾当候补；
    // 只有「确认不支持」的档才会被真正排除。早先这里写「跳过没有证据的档」，
    // 与三组语义相反——照着这句话排查的人会以为 unknown 档永不参与。
    return `${partial.join(' / ')} 只有部分后端确认支持（顶层按并集报告）；`
      + '带这些能力请求时，确认支持的档排在前面，没有证据的档排在链尾作候补，详见 capabilitiesByBackend'
  }
  return undefined
}

/**
 * 多个能力视图取「交集」（保守合并）。
 *
 * 自定义模型绑定了多个后端时必须保守：只有当**所有**后端都支持某能力时才算支持。
 * 否则请求带 tools 时放行了，一旦切到不支持 tools 的后端就必然失败——
 * 那正是设计文档最反对的"策略不一致"。
 *
 * ⚠ 执行侧已不再用它做放行判断（改为逐能力筛链，见 enforceCapabilityGate）；
 * 它现在只用于**展示**时的保守下界。两者的分工必须说清楚，否则很容易
 * 一边改了执行侧、另一边还在用交集报"不支持"，接口自己跟自己打架。
 *
 * 合并规则按三态偏序：unsupported < unknown < supported，取最小值。
 * 数值型字段（上下文窗口等）同样取最小值。
 *
 * @param views - 各后端 describe() 的结果数组。
 * @returns 合并后的能力视图。
 */
function intersectCapabilityViews(views) {
  // 容错兜底：调用方偶尔会传 undefined（describe 抛错后拼出来的数组缺项、
  // 或测试直接调），直接 .filter 会抛 TypeError 把整个 /v1/models 打成 500。
  // 全集为空 → 返回 undefined，表示"什么都不知道"，由上层走最保守分支。
  const usable = (Array.isArray(views) ? views : []).filter((v) => v !== undefined && v !== null)
  if (usable.length === 0) return undefined
  if (usable.length === 1) return usable[0]

  const rank = { unsupported: 0, unknown: 1, supported: 2 }
  const pick = (field) => {
    let worst
    for (const view of usable) {
      const current = view?.[field]
      const value = current?.value ?? 'unknown'
      const score = rank[value] ?? 1
      if (worst === undefined || score < worst.score) {
        worst = { value, score, source: current?.source ?? 'intersection' }
      }
    }
    return { value: worst.value, source: worst.source }
  }
  const pickNumber = (field) => {
    // ⚠ 取 **max**，不取 min（第十三轮 #147）。
    //
    // 原实现取全链最小值。后果：`deepseek-v4.1-flash` 本地配置是
    // `contextWindow: 1000000`，但它有 3 个绑定，只要其中一个报 960000，
    // 对外就变成 **960000** —— 用户拿到的能力比本地直连还低。
    // 更极端的：某个绑定报 128000，整条链对外就只剩 128K。
    //
    // 这是把"多绑定"的成本转嫁给调用方，方向反了：
    // 绑定的意义是"多一条路"，不是"取最差的那条"。
    //
    // 现在取最大值（= 该模型的真实上限），执行时的超标由**上游自己**拒绝，
    // 那一次失败会进负能力学习，把对应的绑定标成不支持大上下文 ——
    // 用真实调用换真实结论，比在这里猜一个保守值准确得多。
    //
    // 注意 `systemPromptUpdate` 不是容量，保持取 min 的语义（见下）。
    let max
    for (const view of usable) {
      const value = view?.[field]?.value
      if (typeof value !== 'number') continue
      if (max === undefined || value > max) max = value
    }
    return max === undefined ? { value: 'unknown', source: 'intersection' } : { value: max, source: 'intersection' }
  }

  const merged = { ...usable[0] }
  for (const key of ['text', 'image', 'reasoning', 'streaming', 'tools', 'parallelTools', 'jsonMode', 'temperature', 'stop']) {
    merged[key] = pick(key)
  }
  // ⚠ 三态合并会把 `reasoning` 上的 **额外字段一起丢掉**。
  //
  // `pick('reasoning')` 只返回 `{ value, source }`，而 `efforts` / `defaultEffort`
  // 是挂在同一个 cell 上的附加信息。丢掉之后的连锁反应非常隐蔽：
  //   1. `resolveReasoningEffort(caps, x)` 见到 `efforts` 为空 → 走"列表为空就不校验"
  //      那条（为人工 override 留的口子）→ **任意字符串原样下发上游**；
  //   2. 于是多绑定模型传 `reasoning_effort: "TOTALLY-BOGUS"` 也能 200，
  //      而同一个模型只绑一档时同样的请求会被 400 拦住 —— 同一份配置因为
  //      "绑了几档"而行为不同，是最难排查的那类不一致。
  //
  // 这里改为保留**并集**（任一一档能接受的值都列出来），再由闸门按值筛链把
  // "不接受这个值的档"排除掉。用并集而不是交集是刻意的：交集会让用户原本
  // 能用的档位凭空消失（六档里只有一档支持 xhigh 时，交集是空的），
  // 而并集 + 筛链表达的是真实语义——"这个值能用，但只会发给支持它的那几档"。
  merged.reasoning = mergeReasoningCell(usable, merged.reasoning)
  // 容量类取 max（真实上限）；`systemPromptUpdate` 不是容量而是"是否支持某更新"，
  // 取 min 更保守，单独走 pick() 的三态合并。
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    merged[key] = pickNumber(key)
  }
  merged.systemPromptUpdate = pick('systemPromptUpdate')
  return merged
}

/**
 * 合并多档的推理档位列表（保留并集，用于"这个值合不合法"的判定与报错文案）。
 *
 * @param views - 各后端 describe() 结果（已过滤空项）。
 * @param picked - 三态合并后的 reasoning cell（`{ value, source }`）。
 * @returns 带 `efforts` / `defaultEffort` 的 cell（无声明时原样返回 picked）。
 */
function mergeReasoningCell(views, picked) {
  const lists = []
  let defaultEffort
  for (const view of views) {
    const cell = view?.reasoning
    const efforts = Array.isArray(cell?.efforts) ? cell.efforts.filter((e) => typeof e === 'string') : []
    if (efforts.length > 0) lists.push(efforts)
    if (defaultEffort === undefined && typeof cell?.defaultEffort === 'string') defaultEffort = cell.defaultEffort
  }
  if (lists.length === 0) return picked
  // 并集（保持首次出现的顺序，便于稳定展示）
  const union = []
  for (const list of lists) {
    for (const item of list) if (!union.includes(item)) union.push(item)
  }
  return {
    ...picked,
    efforts: union,
    // 默认档位只有在某档真的声明过时才给，且必须在并集里（否则等于自造了一个非法值）
    ...(defaultEffort !== undefined && union.includes(defaultEffort) ? { defaultEffort } : {}),
    // 各档不一致时显式标出来：调用方据此知道"某个值可能只有部分档接受"
    effortsDiffers: lists.some((list) => list.length !== union.length),
  }
}

/**
 * 有并发上限的 map：按序返回结果，顺序与输入一致。
 * 用途：`/v1/models` 要逐模型查能力元数据，150+ 个模型不能同时打上游。
 * @param items - 输入数组。
 * @param limit - 并发上限（至少 1）。
 * @param fn - 异步映射函数。
 * @returns 与输入等长的结果数组。
 */
async function mapWithConcurrency(items, limit, fn) {
  const size = Math.max(1, Math.min(limit, items.length))
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 组一个 OpenAI 兼容的模型对象（§5.4）。
 * 标准字段严格合规，插件信息放 `x-lantern.*` 扩展字段
 * （含 `capabilities`：能力的**三态 + 来源**，客户端忽略即不影响兼容）。
 * @param entry - 目录条目。
 * @param caps - 可选的能力视图（`CapabilityResolver.describe()` 的结果）。
 * @returns OpenAI `/v1/models` 条目。
 */
function toOpenAiModel(entry, caps, cfg) {
  // 实现下沉到 exposure.js：面板、测试与两条协议必须用同一份判据，
  // 否则会出现"面板看着藏了、网关却在裸奔"的分叉。
  return publicModelRow(entry, caps, cfg)
}

/**
 * 插件入口。
 * @param ctx - Host 插件上下文。
 * @param config - 组合层传入的配置（本插件以 data/config.json 为准）。
 */
export function apply(ctx, config) {
  // --- 配置与存储：全部落在插件自己的 data/ ---
  let current = withDefaults(config)
  const cfg = () => current

  const directory = new ModelDirectory(ctx, cfg)
  const keyStore = new KeyStore(cfg)
  const capabilities = new CapabilityResolver(ctx, cfg)

  // 能力测试的探针也是真实上游调用 → 让它走同一条并发闸门。
  // 不注入的话 capabilities 里默认是"直通"，面板点一次「测试」就能在上游满载时
  // 再挤进 1~6 个请求，而 /v1/lantern/health 上的并发数看不出任何异常。
  capabilities.withSlot = async (fn) => {
    const handle = acquireSlot()
    if (handle === undefined) {
      // 池满时不能静默降级：探针本来就该等，等不到就如实告诉用户发生了什么。
      throw new Error('并发已达上限，能力测试暂时无法执行，请稍后重试')
    }
    try {
      return await fn()
    } finally {
      releaseSlot(handle)
    }
  }
  const ledger = new AttachmentLedger(ctx, cfg)

  // #194：媒体网关（生图/生视频）已下线。
  // 功能测试会真实调用模型 → 其消耗也要进账本（kind='test'，UI 上单列一项）。
  // 目标由探测方在回调里给出，避免依赖任何"临时字段"。
  capabilities.onUsage = (usage, item, where, status) => {
    void recordCall(
      {
        current: () => current,
        log: (level, message) => (level === 'error' ? ctx.logger.error(message) : ctx.logger.info(message)),
      },
      { provider: where?.provider ?? 'unknown', model: where?.model ?? 'unknown', publicName: where?.publicName ?? 'unknown' },
      {
        usage,
        kind: 'test',
        // status 由探针如实给出（此前写死 'ok'，于是探针失败也被当成功，
        // 熔断器 streak 被清零——管理员点一次「测试」就能把"上游在限流"抹掉）。
        status: status === 'error' ? 'error' : 'ok',
        ...(status === 'error'
          ? { errorCode: 'capability_probe_failed', errorMessage: '能力测试探针请求失败' }
          : {}),
        protocol: 'internal',
        testItem: item,
      },
    )
  }
  /**
   * 并发与速率闸门（§7.3）。
   *
   * ⚠ 并发闸门是**动态重建**的：`limits.maxConcurrent` 与 `reserveForLocal`
   * 可在设置面板随时改，所以每次 acquire 时按当前配置取。见 `currentGate()`。
   */
  let slotGate = createReservedGate(current.limits?.maxConcurrent ?? 2, current.limits?.reserveForLocal ?? 0)
  let slotGateKey = `${current.limits?.maxConcurrent ?? 2}:${current.limits?.reserveForLocal ?? 0}`

  /**
   * 取当前生效的并发闸门；配置变了就重建。
   *
   * 重建时必须把**在飞计数带过去**（原来只写在注释里，代码直接 new 了一个
   * inflight=0 的闸门）。否则改一次 `maxConcurrent` 就等于把当前正在跑的请求
   * 从账上抹掉：设上限 2、已有 2 个在飞 → 改配置 → 新闸门从 0 起，于是还能再进 2 个，
   * 实际并发 4；而那两个旧请求结束时又会把新闸门的计数减到 0，再放进来 2 个。
   * 面板上的 `inflight` 也会跟着报出与实际不符的数字，排查并发问题时被误导。
   *
   * @returns 保留槽闸门。
   */
  function currentGate() {
    const max = current.limits?.maxConcurrent ?? 2
    const reserve = current.limits?.reserveForLocal ?? 0
    const key = `${max}:${reserve}`
    if (key !== slotGateKey) {
      const next = createReservedGate(max, reserve)
      // 把手上的请求数搬到新闸门（受新上限约束，不会凭空超出）。
      const carried = Math.min(slotGate?.inflight ?? 0, next.lanMax)
      for (let i = 0; i < carried; i += 1) next.acquire()
      slotGateKey = key
      slotGate = next
    }
    return slotGate
  }

  /** 熔断器（P12）：上游连续限流 → 暂停 LAN 通道，保护本机。 */
  const breaker = new Breaker(() => current)

  /**
   * 后端健康记忆（故障转移的「记性」）。
   *
   * 与熔断器是**两个层次**，不要混：
   *   · 熔断器看的是「整条 LAN 通道该不该暂停」（保护本机，不区分后端）；
   *   · 这里看的是「链上哪一档刚挂过、该让它排到后面」（只影响顺序，不影响可用性）。
   */
  const backendHealth = new BackendHealth(() => current)

  /** 速率窗口（RPM 与 token 计量）。 */
  const gate = {
    /** @type {Map<string, number[]>} keyId -> 最近请求时间戳 */
    rps: new Map(),
  }

  /** 推理处理器（由 webServer 注入回调赋值，供 standalone 服务复用）。 */
  let inferenceHandler

  /**
   * 探测 DSH 自身 HTTP 服务**实际**监听的地址。
   *
   * 为什么需要它（用户实测发现）：`reuse` 模式复用 DSH 已监听的 socket，
   * 其绑定 IP 由 **DSH 启动参数 `--host`** 决定，**与插件的 bind 配置无关**。
   * 若插件照自己的配置汇报 `0.0.0.0`，就会出现"设置页说局域网可访问、
   * 实际只有 127.0.0.1 能连"的**谎报**——违反"如实公开"原则。
   *
   * 探测顺序（都拿不到就返回 undefined，由 `status()` 退化为配置值并标 inherited）：
   *   1. `webServer` 暴露的 server/socket 的 `address()`（最权威）；
   *   2. `webServer.host` / `webServer.address`（若 DSH 直接暴露字符串）。
   *
   * @returns 实际地址字符串（如 `127.0.0.1` / `0.0.0.0`），或 undefined。
   */
  function detectActualBind() {
    try {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) return undefined
      // 1) 从活的 socket 取（最可靠）
      const server = webServer.server ?? webServer.httpServer ?? webServer._server
      const addr = typeof server?.address === 'function' ? server.address() : undefined
      if (addr !== null && addr !== undefined && typeof addr === 'object' && typeof addr.address === 'string') {
        return addr.address
      }
      // 2) DSH 若直接暴露 host 字段
      for (const key of ['host', 'hostname', 'address', 'bind']) {
        const v = webServer[key]
        if (typeof v === 'string' && v.length > 0) return v
      }
    } catch (error) {
      ctx.logger.warn(`[lantern] 探测 DSH 实际绑定地址失败（不影响功能）：${error?.message}`)
    }
    return undefined
  }

  /** 监听管理器（P14：端口增删改）。 */
  const listenManager = new ListenManager({
    ctx,
    handler: (req, res) => {
      if (inferenceHandler === undefined) {
        sendJson(res, 503, errorBody('LANtern 尚未就绪', 'service_disabled', 'lantern_not_ready'))
        return
      }
      return inferenceHandler(req, res)
    },
    getOwnPort: () => ctx.get('webServer')?.port,
    log: (level, message) => {
      if (level === 'error') ctx.logger.error(message)
      else ctx.logger.info(message)
    },
  })

/**
 * 把用户填的数值钳进合法区间；不是有限数就用兜底值。
 *
 * 存在的理由：这些字段以前直接 "看到什么存什么"，而其中好几个一旦取到
 * 边界外就会让功能静默失效——perKeyRpm=0 让每个请求都 429、maxTokensCap=0
 * 让三条协议给出三种不同语义、requestTimeoutMs=0 等于没有超时。
 *
 * @param value 原始输入（可能来自 JSON，类型不可信）。
 * @param min 下界（含）。
 * @param max 上界（含）。
 * @param fallback 非法时采用的值。
 * @returns 钳好的整数。
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * limits 各项的**唯一区间定义**（第十二轮 #130）。
 *
 * 格式：`{ 字段: [下界, 上界] }`。
 *
 * 为什么必须收敛到一处：原来有两套 —— `clampInt`（patch 时）与
 * `normalizeLimits`（withDefaults 时）各写一份，且区间不同：
 *
 *   | 字段               | patch 路径 | normalize 路径 |
 *   |--------------------|-----------|---------------|
 *   | maxConcurrent      | 512       | 1024          |
 *   | perKeyRpm          | 1e5       | 1e7           |
 *   | perKeyTpm          | 1e7       | 1e8           |
 *   | maxConcurrentTools | 64        | 1024          |
 *   | reserveForLocal    | 63        | 1023          |
 *
 * 而 `withDefaults` 在 `patchConfig` **之后**跑，所以后者的区间说了算。
 * 用户把面板上的 700 原样再存一次，落盘变 512，而提示是"已保存" ——
 * 这正是本项目最忌讳的"设置自己变回去"。
 *
 * 现在两条路径都从这里派生，不可能再出现两种说法。
 */
  /**
   * 把配置补丁写回磁盘并立即生效（浅合并，只覆盖给定键）。
   *
   * ⚠ **整个"读 current → 合并 → 落盘 → 赋值 current"必须串行**（第十轮 #115）。
   *
   * 原来这段是裸跑的，于是两个并发 `config/set` 会这样交错：
   *
   *   A: 读 current（{rpm:11}）      B: 读 current（{rpm:11}）
   *   A: 合并 {rpm:22} → 落盘         B: 合并 {tpm:22222} → 落盘
   *   A: current = {rpm:22}          B: current = {rpm:11, tpm:22222}   ← A 的改动被静默回滚
   *
   * 实测 20/20 必现丢失（串行对照 0/10）；8 并发时还有一个直接报 `EPERM: rename`
   * —— Windows 上两个 rename 撞同一个目标时整条请求失败，用户看到红色报错
   * 却不知道该重试。
   *
   * 修复：一个 module 级的 promise 链，把每次 patch 排进队列串行执行。
   * 只在这里排队（配置写是低频操作），不影响请求转发路径的任何并发。
   *
   * @param patch - 要改的配置键。
   */
  async function patchConfig(patch) {
    // 排到上一次之后；用 .catch 兜住，保证前一次失败不会卡死整条队列。
    const run = patchConfigChain.catch(() => {}).then(() => patchConfigOnce(patch))
    patchConfigChain = run.catch(() => {})
    return run
  }

  /**
   * `patchConfig` 的串行队列尾（第十轮 #115）。
   *
   * 为什么用 module 级闭包变量而不是函数属性：普通函数不能挂私有字段，
   * 而挂一个普通属性 `patchConfig._chain` 会让"每次 patch 都换一个新函数引用"
   * 这类重构悄悄失效。闭包变量只有一个，语义明确。
   */
  let patchConfigChain = Promise.resolve()

  /**
   * `patchConfig` 的实体（**只在串行队列里被调用**，不要直接调）。
   *
   * @param patch - 要改的配置键。
   */
  async function patchConfigOnce(patch) {
    // 数值型 limits 必须在这里钳一遍：前端已经改成"失焦才提交、空值不提交"，
    // 但 config/set 是公开 RPC，脚本直接发 { limits: { perKeyRpm: 0 } } 照样进得来。
    // 而 allowRate() 的判定是 `hits.length >= limit`——limit 为 0 时恒真，
    // 等于给这个 Key 上了永久 429。
    const patchLimits = patch.limits ?? {}
    const clampedLimits = {
      // 上界取 512 而不是 64：面板自己的输入框上限是 64，但**已经存下来的配置**
      // 可以更大（本机现值就是 100 —— 从旧版本写进去的，那会儿还没有钳制）。
      // 上限比现存合法值还小，等于"用户把 100 改成 100 就会被静默改成 64"：
      // 面板说已保存、读回来是另一个数，而且没有任何提示。钳制的职责是挡住
      // 明显荒谬的值（0 / 负数 / 天文数字），不是替用户改小他认为合理的并发。
      // ⚠ 区间必须与 normalizeLimits **完全一致**（第十二轮 #130）。
      //
      // 原来这里是第二套独立区间：maxConcurrent 512（normalize 是 1024）、
      // perKeyRpm 1e5（1e7）、perKeyTpm 1e7（1e8）、maxConcurrentTools 64（1024）、
      // reserveForLocal 63（1023）。
      // 而 `withDefaults` 在 patchConfig 之后跑，**后者的区间说了算** ——
      // 于是"面板存 700 再存一次变成 512"，用户看到"已保存"但值是另一个。
      //
      // 现在两边都从 LIMIT_SPEC 派生，不存在第二种说法。
      ...(patchLimits.maxConcurrent === undefined ? {} : { maxConcurrent: clampInt(patchLimits.maxConcurrent, LIMIT_SPEC.maxConcurrent[0], LIMIT_SPEC.maxConcurrent[1], 8) }),
      ...(patchLimits.perKeyRpm === undefined ? {} : { perKeyRpm: clampInt(patchLimits.perKeyRpm, LIMIT_SPEC.perKeyRpm[0], LIMIT_SPEC.perKeyRpm[1], 100) }),
      ...(patchLimits.perKeyTpm === undefined ? {} : { perKeyTpm: clampInt(patchLimits.perKeyTpm, LIMIT_SPEC.perKeyTpm[0], LIMIT_SPEC.perKeyTpm[1], 80000) }),
      ...(patchLimits.maxTokensCap === undefined ? {} : { maxTokensCap: clampInt(patchLimits.maxTokensCap, LIMIT_SPEC.maxTokensCap[0], LIMIT_SPEC.maxTokensCap[1], 0) }),
      ...(patchLimits.reserveForLocal === undefined ? {} : { reserveForLocal: clampInt(patchLimits.reserveForLocal, LIMIT_SPEC.reserveForLocal[0], LIMIT_SPEC.reserveForLocal[1], 1) }),
      ...(patchLimits.maxBodyBytes === undefined ? {} : { maxBodyBytes: clampInt(patchLimits.maxBodyBytes, LIMIT_SPEC.maxBodyBytes[0], LIMIT_SPEC.maxBodyBytes[1], 4194304) }),
      ...(patchLimits.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: clampInt(patchLimits.requestTimeoutMs, LIMIT_SPEC.requestTimeoutMs[0], LIMIT_SPEC.requestTimeoutMs[1], 600000) }),
      ...(patchLimits.maxConcurrentTools === undefined ? {} : { maxConcurrentTools: clampInt(patchLimits.maxConcurrentTools, LIMIT_SPEC.maxConcurrentTools[0], LIMIT_SPEC.maxConcurrentTools[1], 8) }),
    }
    // media 里的数值同样要钳（理由与 limits 完全一样：config/set 是公开 RPC）。
    // 实测过的三种坏值：
    //   maxFiles=0   → 第一张图进来就被 trimFiles 删掉，产物 URL 立刻 404；
    //   maxJobs=-3   → trimJobs 每轮把所有已完成任务清空，客户端拿不到结果；
    //   fileTtlSec=0 → 产物 0 秒过期，`/v1/media/files/*` 必定 404。
    // 注意这里**只钳出现的键**，没出现的不动（深合并时由 ...current.media 保留）。
    // 面板已经改成"失焦才提交、空值不提交"，但脚本直接发 config/set 照样能绕过来，
    // 所以闸门必须在服务端，而不是在前端。
    const patchMedia = patch.media ?? {}
    const clampedMedia = {
      ...(patchMedia.maxConcurrent === undefined ? {} : { maxConcurrent: clampInt(patchMedia.maxConcurrent, 1, 32, 2) }),
      ...(patchMedia.maxConcurrentTools === undefined ? {} : { maxConcurrentTools: clampInt(patchMedia.maxConcurrentTools, 1, 64, 8) }),
      ...(patchMedia.imageTimeoutMs === undefined ? {} : { imageTimeoutMs: clampInt(patchMedia.imageTimeoutMs, 1000, 3600000, 240000) }),
      ...(patchMedia.videoTimeoutMs === undefined ? {} : { videoTimeoutMs: clampInt(patchMedia.videoTimeoutMs, 1000, 3600000, 660000) }),
      ...(patchMedia.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: clampInt(patchMedia.toolTimeoutMs, 1000, 3600000, 240000) }),
      ...(patchMedia.fileTtlSec === undefined ? {} : { fileTtlSec: clampInt(patchMedia.fileTtlSec, 60, 604800, 21600) }),
      ...(patchMedia.maxFiles === undefined ? {} : { maxFiles: clampInt(patchMedia.maxFiles, 1, 100000, 512) }),
      ...(patchMedia.maxFileBytesTotal === undefined ? {} : { maxFileBytesTotal: clampInt(patchMedia.maxFileBytesTotal, 1048576, 68719476736, 2147483648) }),
      ...(patchMedia.maxJobs === undefined ? {} : { maxJobs: clampInt(patchMedia.maxJobs, 1, 100000, 256) }),
      ...(patchMedia.maxBodyBytes === undefined ? {} : { maxBodyBytes: clampInt(patchMedia.maxBodyBytes, 1024, 268435456, 33554432) }),
    }
    const nextConfig = withDefaults({
      ...current,
      ...patch,
      // ⚠ filters 是**安全边界**，必须逐项校验类型（第十二轮 #128）。
      //
      // 原来这里是无条件浅合并：`config/set { filters: { providers: "a_b" } }`
      // 会原样落盘。而 `directory.js` 里 `new Set(cfg.filters.providers ?? [])`
      // 拿到字符串 "a_b" 时，得到的是**字符集** {'a','_','b'} ——
      // 任何 provider id 都不匹配 → **一条都不过滤，全部 provider 全量公开**。
      // 更糟的是诊断接口的 `hiddenCount` 仍然是 0，看起来"过滤生效了、只是没有要过滤的"。
      //
      // 所以：非数组一律拒收（保留旧值），只接受字符串数组。
      filters: (() => {
        const merged = { ...current.filters }
        const incoming = patch.filters ?? {}
        for (const key of ['providers', 'models', 'allowedModels']) {
          if (incoming[key] === undefined) continue
          if (!Array.isArray(incoming[key])) continue // 类型错：拒收，保留旧值
          merged[key] = incoming[key].filter((x) => typeof x === 'string' && x.length > 0)
        }
        return merged
      })(),
      protocol: { ...current.protocol, ...(patch.protocol ?? {}) },
      // #227：`auth.rotateGraceHours` 的钳制已删 —— 该字段随「轮换」一起下线
      // （Key 现在生成即永久、明文可随时查看，不再有"过渡期"这个概念）。
      // 这里仍走一遍归一化，顺带把旧配置里残留的该字段剔掉，
      // 避免它一路带着跑、让人误以为还在起作用。
      auth: (() => {
        const merged = { ...current.auth, ...(patch.auth ?? {}) }
        delete merged.rotateGraceHours
        return merged
      })(),
      limits: {
        ...current.limits,
        ...(patch.limits ?? {}),
        ...clampedLimits,
        // breaker / backendHealth 深合并（只改 cooldownSec 时不该丢掉 enabled 等）
        ...(patch.limits?.breaker === undefined
          ? {}
          : { breaker: { ...current.limits.breaker, ...patch.limits.breaker } }),
        ...(patch.limits?.backendHealth === undefined
          ? {}
          : { backendHealth: { ...current.limits.backendHealth, ...patch.limits.backendHealth } }),
      },
      usage: { ...current.usage, ...(patch.usage ?? {}) },
      // media 深合并：只改 defaultImageModel 时不该把 maxConcurrent / 各种超时冲回默认。
      // （withDefaults 是「默认值 + raw」，raw 里只有一半字段就等于把另一半重置了。）
      media: {
      ...current.media,
      ...(patch.media ?? {}),
      ...clampedMedia,
      providers: Array.isArray(patch.media?.providers)
        ? patch.media.providers.map((p) => (p !== null && typeof p === 'object' ? { ...p } : p))
        : (current.media.providers ?? []).map((p) => ({ ...p })),
    },
      // exposure 同理：两个开关必须能单独改。
      exposure: { ...current.exposure, ...(patch.exposure ?? {}) },
      // cors 深合并：只改 enabled 时不该把已配好的 allowOrigins 冲掉
      // （withDefaults 里 allowOrigins 为非数组时会回落到**默认值**而不是当前值，
      //  所以这里必须先合出完整对象）。
      cors: {
        ...current.cors,
        ...(patch.cors ?? {}),
        allowOrigins: Array.isArray(patch.cors?.allowOrigins)
          ? patch.cors.allowOrigins
          : Array.isArray(current.cors?.allowOrigins)
            ? [...current.cors.allowOrigins]
            : [],
      },
    })
    // ⚠ 顺序不能反：**先落盘再改内存**。
    // 反过来（改内存 → 写盘）时，磁盘满 / 权限错会让写盘抛错，可内存已经变了，
    // 于是本次调用报失败（或面板以为成功）、进程内配置生效、重启后又回退——
    // "设置自己变回去"这种最难排查的现象就是这么来的。
    const previousConfig = current
    await writeJson(PATHS.config, nextConfig)
    current = nextConfig

    // 监听条目变化 → reconcile 实际服务
    if (patch.listenEntries !== undefined) {
      const ownPort = ctx.get('webServer')?.port
      const normalized = normalizeEntries(current.listenEntries, ownPort, detectActualBind())
      if (!normalized.ok) return { ok: false, message: normalized.message }
      const applied = await listenManager.apply(normalized.entries)
      if (!applied.ok) {
        // ⚠ 磁盘上的配置必须一起回滚。
        // 早先只 warn 一句就 return，于是"配置写着新端口、实际一条服务都没起来"：
        // 面板报错但重启后照样起不来，用户只能手改 config.json。
        ctx.logger.warn(`[lantern] 监听变更未生效：${applied.message}`)
        try {
          await writeJson(PATHS.config, previousConfig)
          current = previousConfig
          // 光回滚配置还不够：apply 已经把旧服务关掉、新的没起来，
          // 这时候磁盘和内存都写着旧端口，但那个端口上没人听。按旧配置重新 apply 一次把它拉回来。
          const back = normalizeEntries(previousConfig.listenEntries, ownPort, detectActualBind())
          if (back.ok) {
            const restored = await listenManager.apply(back.entries)
            if (!restored.ok) ctx.logger.error(`[lantern] 旧监听恢复失败：${restored.message}`)
          }
        } catch (error) {
          ctx.logger.error(`[lantern] 监听回滚失败：${error?.message}`)
        }
        return applied
      }
    }
    return { ok: true }
  }

  /** RPC 依赖集合（管理通道用）。 */
  const rpcDeps = {
    current: () => current,
    keyStore,
    directory,
    capabilities,
    ledger,
    patchConfig,
    /**
     * 恢复出厂默认设置（P16 危险操作）。
     * **不碰** `data/keys.json` 与 `data/usage.jsonl`——用户数据不该被"复位设置"带走。
     * @param keepKeys - 传 false 表示连 Key 一并清空（当前 UI 不暴露该入口，保留能力）。
     * @returns `{ ok }`。
     */
    resetConfig: async (keepKeys = true) => {
      // ⚠ 复位必须**同时**把运行时拉回与磁盘一致（第十二轮 #131）。
      //
      // 原来只 writeJson + directory.refresh，**不调 listenManager.apply()**。
      // 后果：磁盘写着 enabled:false / reuse，而 status 仍报旧端口在 listening。
      // 用户点"恢复出厂设置"，界面说"已恢复"，网关却还在原端口对外服务；
      // 重启后行为突变（端口全变、0.0.0.0 全开）—— 这是"配置与运行时分裂"，
      // 比单纯没生效更危险：用户以为已经关掉了。
      try {
        const previous = current
        current = withDefaults({})
        await writeJson(PATHS.config, current)
        if (keepKeys === false) {
          keyStore.records = []
          // #213：密钥写盘失败必须留痕。
        // 静默吞掉的后果是"用户配好的 key 重启后不见了"，
        // 而他完全不知道自己刚才那次保存是失败的。
        await keyStore.persist().catch((error) => {
          ctx.logger.warn('[lantern] 密钥写盘失败（本次修改重启后会丢失）：' + (error?.message ?? error))
        })
        }
        // 监听条目跟着复位：按新配置重建实际服务（失败要回滚，见下）
        const ownPort = ctx.get('webServer')?.port
        const normalized = normalizeEntries(current.listenEntries, ownPort, detectActualBind())
        if (normalized.ok === true) {
          const applied = await listenManager.apply(normalized.entries)
          if (applied.ok === false) {
            // 磁盘与内存都回滚，别留一个"看起来复位了、其实服务没了"的状态
            current = previous
            // #213：回滚失败要留痕 —— 那意味着配置可能停在"改了一半"的状态，
        // 用户看到的界面与实际生效的配置可能不一致，排障时必须知道这件事。
        await writeJson(PATHS.config, previous).catch((error) => {
          ctx.logger.error('[lantern] 配置回滚写盘失败（当前配置可能不一致）：' + (error?.message ?? error))
        })
            return { ok: false, message: applied.message ?? '监听重建失败，已回滚' }
          }
        }
        // 配置变了 → 让目录按新配置重建，面板能立刻看到结果
        // #213：刷新失败本身不致命（下一轮会自动重试），
        // 但要留痕 —— 否则"改完配置列表没变"会被当成 UI bug 排查半天。
        await directory.refresh().catch((error) => {
          ctx.logger.warn('[lantern] 模型目录刷新失败（列表可能仍是旧的，稍后会自动重试）：' + (error?.message ?? error))
        })
        return { ok: true }
      } catch (error) {
        ctx.logger.error(`[lantern] 配置复位失败：${error?.message}`)
        return { ok: false, message: error?.message ?? '复位失败' }
      }
    },
    listenList: () => listenManager.list(),
    listenStatus: () => listenManager.status(),
    inflight: () => currentGate().inflight,
    // #193：供 status 报告"插件自己持有的条目数"，与 process.memoryUsage()
    // 的分段数字并列，便于判断"内存高到底是数据多还是 Buffer 多"。
    attachmentCount: () => (ledger.status?.().total ?? 0),
    capabilityCount: () => (capabilities.counts?.().learned ?? 0),
    breaker,
    // 后端健康记忆：面板「恢复」按钮 / 改完上游配置后清账全靠这几个入口。
    backendHealth: {
      status: () => backendHealth.status(),
      reset: () => {
        backendHealth.reset()
        return backendHealth.status()
      },
    },
    concurrencyStatus: () => currentGate().status(),
    /**
     * 性能测试（§6.5.10-b）：一次最短调用，返回延迟 / 首字 / token 速度。
     *
     * 三态呈现（用户要求）：
     * - 正常 → 绿字（latencyMs / ttftMs / tokPerSec）
     * - 超时 → `kind: 'timeout'`（前端红字 `time out`）
     * - 其它错误 → **原样**返回上游消息（**先脱敏**，红线见 §6.5.10-b）
     *
     * @param options - `{ provider, model, timeoutMs }`。
     * @returns 结果对象。
     */
    perfTest: async ({ provider, model, timeoutMs }) => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const started = Date.now()
      let ttftMs
      let outputTokens = 0
      let failure
      try {
        const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
        // ── #230：修复「性能测试」报 `content.some is not a function` ──
        //
        // 排查过程（留档，避免以后又走一遍）：
        //   · DSH 内核自己全是 `createSystemMessage(text)` **单参数**调用
        //     （见 app.asar @deepseek-ai/dsh-agent-loop 的 systemPromptProjection）；
        //   · 所以 content 就该是 string —— 我一度以为是"必须传内容块数组"，错了；
        //   · 但这里原来传了第二个参数 `'dsh-lantern-perftest'`，那是一个
        //     **不存在的 provider id**。内核按 message.provider 归属归组时
        //     找不到对应 provider，content 可能被置空 → 后续 `.some()` TypeError。
        //
        // 另外对照：「功能测试」(`bindingTest`) 一直正常，是因为它**根本没有
        // system message**，只有 createUserMessage。这是最直接的差分证据。
        //
        // 修法：只传 content，第二参数不传（与内核自身用法一致）。
        const messages = [
          createSystemMessage('只回复一个字。'),
          createUserMessage({ content: [{ type: 'text', text: 'ping' }] }),
        ]
        for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens: 8, signal: ac.signal })) {
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            if (ttftMs === undefined) ttftMs = Date.now() - started
          } else if (chunk.type === 'usage') {
            outputTokens = chunk.usage?.outputTokens ?? 0
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
          }
        }
      } catch (error) {
        failure = { message: error?.message ?? String(error), code: error?.code ?? 'transport' }
      } finally {
        clearTimeout(timer)
      }

      const latencyMs = Date.now() - started
      if (ac.signal.aborted) return { ok: false, kind: 'timeout', timeoutMs, latencyMs }
      if (failure !== undefined) {
        return {
          ok: false,
          kind: 'upstream',
          latencyMs,
          // 原样返回上游消息，但**先脱敏**（可能含 key / 邮箱 / 端点）
          raw: maskSecrets(failure.message),
          code: failure.code,
          ...(failure.status === undefined ? {} : { status: failure.status }),
        }
      }
      const seconds = Math.max((latencyMs - (ttftMs ?? 0)) / 1000, 0.001)
      return {
        ok: true,
        latencyMs,
        ttftMs: ttftMs ?? null,
        outputTokens,
        tokPerSec: outputTokens > 0 ? Number((outputTokens / seconds).toFixed(1)) : null,
      }
    },
    /**
     * 探一下某个宿主工具是否已注册（自定义工具页面用）。
     *
     * 只读工具定义，**不执行**：执行一次生图要真扣积分，
     * 面板上点一下「检测」就花掉 5.71 积分是不可接受的。
     *
     * @param name - 宿主工具名。
     * @returns `{ available, reason?, description? }`。
     */
    customToolProbe: (name) => {
      const service = toolsRef.value
      if (service === undefined || typeof service.get !== 'function') {
        return { available: false, reason: '宿主 tools 服务未就绪（DSH 可能仍在启动）' }
      }
      try {
        const definition = service.get(name)
        if (definition === undefined) {
          return {
            available: false,
            reason:
              '工具 ' + name + ' 未注册：本机可能没开启对应开关（设置 → WorkBuddy → 允许模型自主生图 / 生视频），或提供该工具的插件未安装',
          }
        }
        return { available: true, ...(definition.description === undefined ? {} : { description: definition.description }) }
      } catch (error) {
        return { available: false, reason: '读取工具失败：' + (error?.message ?? String(error)) }
      }
    },
    /**
     * 列出宿主里已注册的工具名（自定义工具页面的候选列表）。
     *
     * 用 `schemas()` 而不是遍历内部表：那是宿主公开的读取面，
     * 拿到的就是"当前 agent 真能调到的工具"，不会把已停用的也算进来。
     *
     * @returns `[{ name, description }]`。
     */
    hostToolsList: () => {
      const service = toolsRef.value
      if (service === undefined || typeof service.schemas !== 'function') return []
      try {
        return service.schemas().map((schema) => ({
          name: schema?.name ?? '',
          description: typeof schema?.description === 'string' ? schema.description.slice(0, 200) : '',
        })).filter((t) => t.name.length > 0)
      } catch {
        return []
      }
    },
    /**
     * 现场重探媒体后端（生图 / 生视频）。
     *
     * 面板上「重新检测」按钮走这里：health 里的媒体状态是**启动时缓存的快照**，
     * 用户在 DSH 里刚登录完 WorkBuddy，快照还停在 unavailable —— 点一下就该看到新结果，
     * 不该逼他重启整个网关。
     *
     * @param providerId 只看这一家（面板的「测试」按钮传它，留空 = 全景探测）。
     * @returns `{ image, video, catalog }`。
     */
    // #194：媒体探测已下线。
    mediaProbe: () => undefined,
    /**
     * 供应商配置刚被改过 → 丢掉媒体侧的全部探测/目录缓存。
     *
     * 不清的话用户点「测试」看到的还是改之前那次探测的结论（60 秒探测缓存 +
     * 5 分钟目录缓存），明明改对了也显示上一个地址的结果。RPC 的
     * providers/create|update|remove|move 写完配置后都会走这里。
     */
    // #194：媒体缓存已下线。
    mediaInvalidate: () => {},
    /**
     * 解析一条绑定（`<model>@<provider>` 或裸模型名）到真实后端。
     *
     * 面板要用它把"绑定"渲染成"是否可用 + 落在哪个 provider 上"，
     * 与请求期的解析走**同一个函数**，避免面板显示可用、请求时却打不到。
     *
     * @param binding - 绑定字符串。
     * @returns 解析结果，或 `{ error, binding, reason }`。
     */
    resolveBinding: (binding) => resolveBinding(directory, binding, current),
    /**
     * 实测一条绑定是否真能出字（自定义模型面板的"测试"按钮）。
     *
     * 只让它回一个字，成本极低；失败时原样返回上游消息但**先脱敏**。
     *
     * @param binding - 绑定字符串。
     * @returns `{ ok, latencyMs, ttftMs?, outputTokens?, raw?, code?, status? }`。
     */
    /**
     * 把 `systemMerge` 探针的结论写回模型配置（第十七轮 #182）。
     *
     * 为什么单独一条路径：`mergeSystemIntoUser` 是**模型配置项**，
     * 不是 `capabilities` 里的能力覆盖（那是三态值，存在 capabilities.json）。
     * 两者存储位置和语义都不同，不能共用 `setOverride`。
     *
     * @param provider - provider id（用于定位模型；本实现按公开名匹配）。
     * @param model - 模型 id。
     * @param want - 探针建议的布尔值。
     * @returns 是否真的写入了。
     */
    applySystemMerge: async (provider, model, want) => {
      try {
        if (typeof patchConfigOnce !== 'function') return false
        const list = normalizeCustomModels(current.customModels)
        // 探针是按 (provider, model) 打的，但配置按自定义模型条目存。
        // 找到「绑定里包含 model@provider」的那一条。
        const bindingKey = `${model}@${provider}`
        const hit = list.find((m) => (m.bindings ?? []).some(
          (b) => typeof b === 'string' && b.toLowerCase() === bindingKey.toLowerCase(),
        ))
        if (hit === undefined) return false
        if (hit.mergeSystemIntoUser === want) return false   // 已经是这个值，不必写
        // 用现成的 patchConfigOnce 走统一写入路径（含持久化 + 重载）。
        // 它接收**完整的新值**（不是 updater 函数），所以先把整张表算好再写。
        const next = list.map((m) => (m.id === hit.id ? { ...m, mergeSystemIntoUser: want } : m))
        await patchConfigOnce({ customModels: next })
        ctx.logger.info(`[lantern] ${hit.name} 的 mergeSystemIntoUser 已按实测自动设为 ${want}`)
        return true
      } catch (error) {
        ctx.logger.warn(`[lantern] 自动写入 mergeSystemIntoUser 失败：${error?.message}`)
        return false
      }
    },
    bindingTest: async (binding) => {
      const resolved = resolveBinding(directory, binding, current)
      if (resolved.error !== undefined) {
        return { ok: false, kind: 'unresolved', code: resolved.error, reason: resolved.reason }
      }
      if (!directory.isProviderLive(resolved.provider)) {
        return { ok: false, kind: 'offline', code: 'binding_offline', reason: 'provider 当前不可用' }
      }
      const ac = new AbortController()
      const timeoutMs = current.perfTest?.timeoutMs ?? 20_000
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const started = Date.now()
      let ttftMs
      let outputTokens = 0
      let failure
      try {
        const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
        // ── 绑定探针不要发独立 system 消息（第十六轮 #180）──
        //
        // 原实现发 `createSystemMessage('只回复一个字。') + createUserMessage(...)`，
        // 实测后果（面板「逐个实测」那一列红字）：
        //   glm-5.3@xdpool      → content.some is not a function   ❌
        //   glm-5.3@trae        → content.some is not a function   ❌
        //   sn-glm-5-3-flash@raccoon → 6305ms ✅
        //   glm-5.3-flashx@trae → 7041ms ✅
        //
        // **同一模型、不同绑定，有的报错有的正常** —— 说明不是模型不支持，
        // 而是那条链路上游接到独立 system 消息时的处理方式不同：
        // 有的把它当普通消息（正常），有的在内核里走到 `content.some(...)`
        // 而该字段形状不符就抛错。
        //
        // 网关主路径早就因为同样的原因改用 `mergeSystemIntoUser`
        // （见 messages.js 的 #155/#174）。探针这里漏了，现在对齐：
        // **把提示词直接写进 user 文本，不发 system 消息。**
        const messages = [
          createUserMessage({ content: [{ type: 'text', text: '只回复一个字：ping' }] }),
        ]
        for await (const chunk of ctx.llm.stream({
          provider: resolved.provider,
          model: resolved.model,
          messages,
          maxTokens: 8,
          signal: ac.signal,
        })) {
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            if (ttftMs === undefined) ttftMs = Date.now() - started
          } else if (chunk.type === 'usage') {
            outputTokens = chunk.usage?.outputTokens ?? 0
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
          }
        }
      } catch (error) {
        failure = { message: error?.message ?? String(error), code: error?.code ?? 'transport' }
      } finally {
        clearTimeout(timer)
      }
      const latencyMs = Date.now() - started
      if (ac.signal.aborted) return { ok: false, kind: 'timeout', timeoutMs, latencyMs }
      if (failure !== undefined) {
        return {
          ok: false,
          kind: 'upstream',
          latencyMs,
          raw: maskSecrets(failure.message),
          code: failure.code,
          ...(failure.status === undefined ? {} : { status: failure.status }),
        }
      }
      // ── 严严谨性：不只看"有没有响应"，还要看**响应对不对**（第十六轮 #180）──
      //
      // 原来只要流跑完、没 failure 就判 ok —— 但"跑完了但一个字都没输出"
      // 也算 ok，那等于说"这个绑定可用"，实际上它什么都没答。
      // 现在要求：
      //   · 至少收到一个 text 或 reasoning 增量（ttftMs 有值）
      //   · 没有 error/aborted 收尾
      // 不满足就如实报 `empty`，而不是给个绿灯骗人。
      if (ttftMs === undefined) {
        return { ok: false, kind: 'empty', latencyMs, reason: '上游结束但没有任何输出' }
      }
      return {
        ok: true,
        latencyMs,
        ttftMs,
        outputTokens,
        provider: resolved.provider,
        model: resolved.model,
      }
    },
    /**
     * 端口的增 / 删 / 改（P14）。
     * @param payload - `{ action, entry, id }`。
     * @returns `{ ok, value?, code?, message? }`。
     */
    listenUpdate: async (payload) => {
      const action = String(payload.action ?? '')
      const list = listenManager.list()
      const ownPort = ctx.get('webServer')?.port

      if (action === 'add') {
        const candidate = { id: newListenId(), enabled: true, ...payload.entry }
        const next = [...list, candidate]
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        // 试听（standalone 才需要）
        //
        // ⚠ **必须用条目自己的 bind 去探**，不能硬编码 127.0.0.1：
        // 实测（DSH 已占着回环地址的某端口时）`probe(127.0.0.1, port)` 报 EADDRINUSE，
        // 而 `probe(0.0.0.0, port)` 是**可用的**。若这里探回环、UI「试听」按 bind 探，
        // 就会出现"试听说通过、确认却失败"的自相矛盾（实测反馈）。
        const target = normalized.entries.find((e) => e.id === candidate.id)
        if (target?.mode === 'standalone') {
          const probe = await probePort(target.port, target.bind ?? '127.0.0.1')
          if (!probe.available) {
            return { ok: false, code: 'port_unavailable', message: `端口 ${target.port} 不可用：${probe.reason}` }
          }
        }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      if (action === 'update') {
        const id = String(payload.id ?? '')
        if (list.every((e) => e.id !== id)) return { ok: false, code: 'not_found', message: '条目不存在' }
        const next = list.map((e) => (e.id === id ? { ...e, ...payload.entry, id } : e))
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        const target = normalized.entries.find((e) => e.id === id)
        if (target?.mode === 'standalone' && target.enabled !== false) {
          // 同 add：必须按条目自己的 bind 探测（硬编码 127.0.0.1 会与 UI 试听判定不一致）
          const probe = await probePort(target.port, target.bind ?? '127.0.0.1')
          if (!probe.available) {
            return { ok: false, code: 'port_unavailable', message: `端口 ${target.port} 不可用：${probe.reason}` }
          }
        }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      if (action === 'remove') {
        const id = String(payload.id ?? '')
        const next = list.filter((e) => e.id !== id)
        if (next.length === list.length) return { ok: false, code: 'not_found', message: '条目不存在' }
        if (next.length === 0) {
          return { ok: false, code: 'last_entry', message: '不能删除最后一条监听条目（否则等于把自己关停）' }
        }
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      return { ok: false, code: 'unknown_action', message: `未知操作：${action}` }
    },
  }

  /** 卸载时释放监听服务。 */
  ctx.effect(() => () => {
    void listenManager.dispose()
  })

  /**
   * 尝试占用一个并发槽。
   *
   * 成功时返回**闸门句柄**（而不是 true）。理由见 releaseSlot：
   * 占槽与释放必须落在同一个闸门实例上。
   *
   * @returns 成功的闸门实例；池满返回 undefined。
   */
  function acquireSlot() {
    const gate = currentGate()
    return gate.acquire() ? gate : undefined
  }

  /**
   * 释放并发槽。
   *
   * 必须把句柄传回来：`releaseSlot()` 无参时释放的是**当前**闸门，
   * 而占槽时用的可能是改配置之前那个实例——旧请求的归还落到新闸门，
   * 会把新闸门的计数提前减掉（等于凭空多出并发额度）。
   *
   * @param gate - acquireSlot() 返回的句柄；占槽失败时是 undefined。
   */
  function releaseSlot(gate) {
    gate?.release()
  }

  /**
   * 每 Key 每分钟请求数限流（滑动窗口）。
   * @param keyId - key 标识（匿名请求用 `__anon__`）。
   * @param limit - 该 key 的每分钟上限。
   * @returns 是否放行。
   */
  function allowRate(keyId, limit) {
    const now = Date.now()
    const windowStart = now - 60_000
    const hits = (gate.rps.get(keyId) ?? []).filter((t) => t > windowStart)
    if (hits.length >= limit) {
      gate.rps.set(keyId, hits)
      return false
    }
    hits.push(now)
    gate.rps.set(keyId, hits)
    return true
  }

  // 启动：建目录、清临时文件、载入配置与 key、开始枚举。
  // 全部包在 try/catch 内 —— 插件自身出问题**不得**拖垮 DSH 启动（§7.2）。
  //
  // ⚠ 这里有一个**必须处理的竞态**（用户实测踩到）：
  // `ctx.inject(['webServer'], …)` 是**同步**触发的，而它的回调里会
  // `normalizeEntries(current.listenEntries, …)` 并开始监听。
  // 若读盘（异步）尚未完成，`current` 还是 `apply(config)` 拿到的**初值**，
  // 于是监听按"默认配置"启动、**磁盘上的真实配置被完全忽略**——
  // 表现为"用户改成 standalone 某端口，重启后仍是 reuse 的 DSH 端口，新端口从未监听"。
  //
  // 解法：`configReady` 在配置载入后 resolve；监听启动前 **await 它**，
  // 保证一定按磁盘配置启动。
  let markConfigReady
  const configReady = new Promise((resolve) => {
    markConfigReady = resolve
  })

  void (async () => {
    try {
      await ensureDirs()
      const swept = await sweepTmp()
      if (swept > 0) ctx.logger.info(`[lantern] 清理了 ${swept} 个残留临时文件`)
      const disk = await readJson(PATHS.config, undefined)
      if (disk === undefined) {
        await writeJson(PATHS.config, current)
        ctx.logger.info(`[lantern] 已生成初始配置 data/config.json（enabled=${current.enabled}）`)
      } else {
        current = withDefaults(disk)
      }
      // ★ 配置已就位：放行"监听启动"（它在 inject 回调里 await 这个 Promise）
      markConfigReady()
      const keys = await keyStore.load()
      const capInfo = await capabilities.load()
      const ledgerCount = await ledger.load()
      const entries = await directory.start()
      // #228：启动自检 —— 一行结构化汇总，把"起来之后到底什么状态"讲清楚。
      //
      // 原来的日志是一长串括号里堆的参数（provider/模型/keys/覆盖/学习/附件），
      // 要找某一个数字得在括号里翻。改成 `键=值` 顺序排列后，扫一眼就能定位。
      // 同时补上三条以前没报过的关键信息：
      //   · 监听地址（用户最关心"局域网能不能访问"）
      //   · 启用中的 Key 数（总 Key 数不等于可用 Key 数）
      //   · 自定义模型数（和"公开模型"是两回事）
      //
      // ⚠ `listenManager.status()` 返回的是**数组**（每个监听条目一条），
      //    不是 `{ active }` —— 我第一版按对象写，导致这里永远报"未监听"。
      const listenRows = listenManager.status()
      const activeRow = listenRows.find((x) => x.listening === true && x.enabled !== false)
      const listenText = activeRow === undefined
        ? '未监听'
        : `${activeRow.bind ?? '?'}:${activeRow.port ?? '?'}${activeRow.bindInherited === true ? '（继承 DSH）' : ''}`
      const enabledKeys = keys.filter((k) => k.enabled !== false).length
      const customCount = entries.filter((e) => e.custom === true).length
      ctx.logger.info(
        `[lantern] 启动自检 · 服务=${current.enabled ? '已启用' : '未启用'}` +
          ` · 监听=${listenText}` +
          ` · 模型=${entries.length}（自定义 ${customCount}）` +
          ` · Key=${enabledKeys}/${keys.length} 启用` +
          ` · 能力=${capInfo.overrides} 覆盖/${capInfo.learned} 学习` +
          ` · 附件=${ledgerCount}`,
      )
      // 明确的"看起来能跑但实际不能跑"的三种组合，各自给出下一步动作。
      // 这三种如果只靠上面的汇总数字，用户未必能意识到是问题。
      if (current.enabled && entries.length === 0) {
        ctx.logger.warn('[lantern] ⚠ 已启用但目录里 0 个可公开模型 —— 局域网请求会 404。请检查「模型与来源过滤」是否把所有模型都过滤掉了。')
      }
      if (current.enabled && keyStore.isEmpty) {
        ctx.logger.warn(
          '[lantern] ⚠ 已启用但尚无任何可用 API Key —— 局域网请求将一律被拒。' +
            '请在 设置 → LANtern → 状态与安全 中生成一个 Key。',
        )
      }
      if (current.enabled && listenText === '未监听') {
        ctx.logger.warn('[lantern] ⚠ 已启用但没有在监听 —— 见「监听与端口」里的条目状态。')
      }
      // 拓扑变化时使权威能力缓存失效（§6.5.7：adapter 代次可能改变同一 provider 的能力）
      ctx.on('llm/adapters-updated', () => capabilities.invalidate())
      // reuse 模式的绑定地址由 DSH 的 `--host` 决定，**插件无权决定**。
      // 这里如实探测，供 status/health/UI 汇报真实值（避免"设置说 0.0.0.0、实际只有回环"的谎报）。
      const actualBind = detectActualBind()
      listenManager.setReuseActualBind(actualBind)
      if (actualBind !== undefined && actualBind !== '0.0.0.0' && actualBind !== '::') {
        const reuseEntry = current.listenEntries?.find((e) => e.mode === 'reuse' && e.enabled !== false)
        if (reuseEntry !== undefined && reuseEntry.bind === '0.0.0.0') {
          ctx.logger.warn(
            `[lantern] ⚠ reuse 条目配置为 0.0.0.0，但 DSH 自身只监听 ${actualBind}（由 DSH 启动参数 --host 决定）。` +
              '局域网当前无法访问。要真正暴露到局域网，请重启 DSH 时加 --host 0.0.0.0，' +
              '或改用 standalone 模式（插件自开端口，只暴露 /v1/*）。',
          )
        }
      }
      // P8：启动附件账本定时回收（默认 dry-run，只记日志不真删）
      ledger.start()
      if (current.attachments?.dryRun !== false) {
        ctx.logger.warn(
          '[lantern] 附件回收处于 dry-run（只记日志、不真删）。' +
            '观察一段时间确认无误后，可在 设置 → LANtern 中关闭 dry-run。',
        )
      }
    } catch (error) {
      ctx.logger.error('[lantern] 初始化失败（插件保持静默，不影响 DSH）')
      ctx.logger.error(error)
    } finally {
      // ★ 无论成功失败都必须放行：否则监听启动会**永久等待**这个 Promise。
      // （初始化失败时 current 保持 apply 的初值，监听按初值启动，属可接受的降级。）
      markConfigReady()
    }
  })()

  // 卸载时释放定时器（隐藏的兜底轮询与去抖定时器 + 附件回收）。
  ctx.effect(() => () => directory.dispose())
  ctx.effect(() => () => ledger.dispose())

  // --- HTTP 路由：只有 enabled 时才注册（默认关闭）---
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')
    if (webServer === undefined) {
      ctx.logger.warn('[lantern] webServer 服务缺席')
      ctx.logger.warn('[lantern] 未找到 webServer 服务，/v1/* 路由未注册')
      return
    }
    ctx.logger.info(`[lantern] webServer 就绪（port=${webServer.port}）`)

    /**
     * `/v1` 前缀路由：OpenAI 兼容端点。
     * 只读目录、不发起任何模型调用。
     */
    const route = {
      kind: 'prefix',
      path: '/v1',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname.replace(/\/+$/, '') || '/'

          // HEAD 按 GET 处理：Node 会在 res.end() 时自动丢弃 body 只留头，
          // 所以「回 200 + 空 body」是免费的。不归一化的话，所有只做 HEAD 探活的
          // 客户端（负载均衡健康检查、链路监控、Nextcloud/Joplin 这类同步工具）
          // 都会拿到 404「未知端点」—— 明明同一个 URL 用 GET 是好的，看起来像网关坏了。
          // 注意必须**在路由判定之前**改：下面全是 req.method === 'GET' 的严格比较。
          // lantern-head-as-get
          if (req.method === 'HEAD') {
            req.method = 'GET'
            res.setHeader('X-Lantern-Head', 'as-get')
          }

          // 自检端点：始终可用（不依赖 enabled），便于管理员确认插件已加载。
          if (req.method === 'GET' && pathname === '/v1/lantern/health') {
            // 这条端点**免鉴权**：任何人都能打，因此它是最容易漏掉的一处拓扑泄露面。
            // 原始实现会吐出 provider 列表与 slug、每个 provider 的模型数、
            // 媒体后端实现与上游真实模型名（hunyuan-image-alpha / kling-video-v3）、
            // 甚至本机 data/media 的绝对路径 —— 服务方把网关卖给客户时，
            // 这些等于把"我在转卖谁的模型、装在哪台机器的哪个目录"直接公开。
            //
            // 全量诊断**必须有第二道闸**：只看 exposure 开关是不够的。
            // 开关的语义是"我作为管理员愿不愿意看拓扑"，它表达不了"谁能看到"。
            // 只关 maskTopology（例如为了排查某条链路）就会让这条免鉴权端点
            // 向公网吐 mediaDir 绝对路径、hiddenReason 里的上游错误原文、
            // 真实绑定地址与 key 数量 —— 开关的本意从来不是"对全世界开放"。
            //
            // 所以这里改成：全量诊断要同时满足「脱敏关了」**且**「请求来自本机」。
            // 远程访问者永远只拿到探活三项；管理员要看全量要么在本机打这个端点，
            // 要么走设置面板（RPC，需本机会话，不经公网）。
            const remote = String(req.socket?.remoteAddress ?? '')
            const fromLoopback = remote === '127.0.0.1'
              || remote === '::1'
              || remote === '::ffff:127.0.0.1'
              || remote.startsWith('::ffff:127.')
            // ── #193：本机访问时**总是**带上内存分段 ──
            //
            // 内存分段（rss/heapUsed/external…）**不是拓扑信息**：
            // 它不含 provider 名、不含模型名、不含路径、不含 key 数量语义，
            // 只是一个运行时数字。对客户毫无泄露价值，但对接线排查是必需的。
            //
            // 因此它不跟 `maskTopology` 一起被藏。只有**非本机**访问才完全不给
            // （远程调用者本来也不该关心服务方的内存）。
            const memReport = fromLoopback
              ? (() => {
                  try {
                    const u = process.memoryUsage()
                    const toMB = (b) => Math.round((b / 1024 / 1024) * 10) / 10
                    return {
                      rss: toMB(u.rss),
                      heapUsed: toMB(u.heapUsed),
                      heapTotal: toMB(u.heapTotal),
                      external: toMB(u.external),
                      arrayBuffers: toMB(u.arrayBuffers),
                      counts: {
                        attachmentLedger: ledger.status?.().total ?? null,
                        capabilityLearned: capabilities.counts?.().learned ?? null,
                        capabilityOverrides: capabilities.counts?.().overrides ?? null,
                        models: Array.isArray(current.customModels) ? current.customModels.length : 0,
                        keys: keyStore.records.length,
                      },
                    }
                  } catch {
                    return undefined
                  }
                })()
              : undefined

            if (isMasked(current) || !fromLoopback) {
              sendJson(res, 200, {
                ok: true,
                plugin: name,
                enabled: current.enabled,
                ...(memReport === undefined ? {} : { memory: memReport }),
              })
              return
            }
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              enabled: current.enabled,
              listen: listenManager.status(),
              auth: {
                keyCount: keyStore.records.length,
                usable: keyStore.records.filter((r) => r.enabled !== false).length,
                allowAnonymous: current.auth?.allowAnonymous === true,
                format: current.auth?.format ?? 'sk',
              },
              inflight: currentGate().inflight,
              // P12：熔断与并发/保留槽状态，便于管理员判断"是不是被限流保护了"
              breaker: breaker.status(),
              // 后端健康记忆：哪几档在冷却、被排到链尾、连续失败几次。
              // 只给管理员看（health 在脱敏时整块不出），调用方拿不到拓扑。
              backendHealth: backendHealth.status(),
              concurrency: currentGate().status(),
              directory: directory.diagnostics(),
              // 生图 / 生视频：可用性与本机 WorkBuddy 开关、登录状态联动
              // #194：媒体功能已下线，不再报告其状态。
              // #193 内存分段（本机可见；见上方 memReport 的说明）
              ...(memReport === undefined ? {} : { memory: memReport }),
            })
            return
          }

          // --- 协议判定（决定"入口级错误"用哪种形状） ---
          // `/v1/messages` 是 Anthropic 专属路径，据此决定错误体形状：
          // Anthropic 官方 SDK 只认 `{type:'error', error:{type,message}}`，
          // 回 OpenAI 形状会让它抛一个笼统异常、看不出真实原因（已实测踩到）。
          const isAnthropicPath = pathname === '/v1/messages'
          /**
           * 入口级错误（未启用 / 鉴权失败）：形状与请求协议一致。
           *
           * @param status - HTTP 状态码。
           * @param message - 面向使用者的说明。
           * @param openAiType - OpenAI 形状的 `error.type`。
           * @param code - OpenAI 形状的 `error.code`。
           * @param anthropicType - Anthropic 形状的 `error.type`。
           */
          const entryError = (status, message, openAiType, code, anthropicType = 'invalid_request_error', publicText) => {
            // 入口错误（未启用 / 鉴权失败）的原文里带「请在 设置 → LANtern → …」这类
            // 面板路径，那是给网关管理员看的。出口统一过一遍 publicMessage：
            // 一处兜住，免得以后新增入口错误时又漏一条。
            //
            // publicText 是「藏指引时」替换用的整句：publicMessage 只会删掉指引片段，
            // 剩下的半句（「LANtern 未启用：」）对终端用户仍然莫名其妙，
            // 所以这类文案干脆给一份面向客户的完整版本。
            const safe = isHintMasked(current) && typeof publicText === 'string' ? publicText : publicMessage(message, current)
            if (isAnthropicPath) sendJson(res, status, anthropicError(safe, anthropicType))
            else sendJson(res, status, errorBody(safe, openAiType, code))
          }

          // --- 跨域（CORS）---
          // 必须放在**鉴权与启用判定之前**：浏览器预检（OPTIONS）根本不会带
          // Authorization，若先鉴权，预检永远 401，前端只会看到 "Failed to fetch"。
          //
          // 但默认 **关闭**（cors.enabled=false）：这是一道开门器，默认开启等于
          // 默认允许任意网页拿用户浏览器里的身份打本机网关。
          const corsCfg = current.cors
          const requestOrigin = req.headers.origin
          if (corsCfg?.enabled === true && typeof requestOrigin === 'string' && requestOrigin.length > 0) {
            const origins = Array.isArray(corsCfg.allowOrigins) ? corsCfg.allowOrigins : []
            const wildcard = origins.includes('*')
            const allowed = wildcard || origins.includes(requestOrigin)
            if (allowed) {
              // 只回**请求里真实的 Origin**，绝不回 `*`：通配符与凭证共存时
              // 浏览器会直接拒绝这条响应，表现为"配了却还是不行"。
              res.setHeader('Access-Control-Allow-Origin', requestOrigin)
              res.setHeader('Vary', 'Origin')
              if (corsCfg.allowCredentials === true && !wildcard) {
                res.setHeader('Access-Control-Allow-Credentials', 'true')
              }
              // 不暴露的话，前端读不到 x-lantern-* 这些**如实披露**的头，
              // 等于让"降级可见"只在 curl 里成立。
              res.setHeader(
                'Access-Control-Expose-Headers',
                [
                  'X-Lantern-Ignored-Params',
                  'X-Lantern-Dropped-Params',
                  'X-Lantern-Failover-Chain',
                  'X-Lantern-Failover-Skipped',
                  'X-Lantern-Max-Tokens-Source',
                  'X-Lantern-Max-Tokens',
                  'X-Lantern-Thinking-Note',
                  // 这两个是后来加的，加进暴露表之前浏览器客户端读不到：
                  //   · Backends-Ineligible —— 「能力筛掉了几个后端」，前端据此解释为什么慢；
                  //   · Head —— HEAD 被当成 GET 的证据，探活脚本用它确认走对了分支。
                  'X-Lantern-Backends-Ineligible',
                  'X-Lantern-Head',
                  // 第十轮：推测档位契约的三件套 + 本次实际落到哪一档。
                  // 不加进暴露表的话，浏览器端永远读不到"你要的四档被降成了哪一档"，
                  // 而这个功能的意义就是让调用方知道真相。
                  'X-Lantern-Effort-Contract',
                  'X-Lantern-Effort-Served',
                  'X-Lantern-Effort-Note',
                  'X-Lantern-Served',
                  'X-Lantern-Attempts',
                  // 第十轮：消息构建期的降级（条数截断 / 单条超长 / 忽略 role / 图片格式）
                  // 与 stop 被截断，也必须能被浏览器端读到。
                  'X-Lantern-Warnings',
                  'X-Lantern-Warning-Texts',
                  'X-Lantern-Stop-Truncated',
                  // #221：诊断头是后加的，必须同步进暴露表 ——
                  // 否则浏览器端（面板、前端调用方）读不到它，
                  // 而这几个头恰恰是"为什么慢 / 哪一档失败了"的全部信息。
                  // 服务端发了、客户端读不到，等于没发。
                  'X-Lantern-Attempt-Codes',
                  'X-Lantern-Concurrency',
                  'X-Lantern-Queue-MS',
                  'Retry-After',
                ].join(', '),
              )
              if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                // 原样回显浏览器请求的头名，避免逐个列举漏掉 x-api-key /
                // anthropic-version 这类客户端私有头。
                const asked = req.headers['access-control-request-headers']
                res.setHeader(
                  'Access-Control-Allow-Headers',
                  typeof asked === 'string' && asked.length > 0
                    ? asked
                    : 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
                )
                res.setHeader('Access-Control-Max-Age', String(corsCfg.maxAgeSec ?? 600))
                res.statusCode = 204
                res.end()
                return
              }
            } else if (req.method === 'OPTIONS') {
              // 来源不在白名单：明确回 403，不要让浏览器干等到超时才发现。
              // 错误体里**不回显**白名单内容（那是拓扑信息）。
              res.statusCode = 403
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.end(JSON.stringify({ error: { message: '该来源不在允许的跨域白名单里', type: 'cors_rejected', code: 'cors_origin_not_allowed' } }))
              return
            }
          }

          if (!current.enabled) {
            entryError(
              503,
              'LANtern 未启用：请在 设置 → LANtern → 状态与安全 中打开开关',
              'service_disabled',
              'lantern_disabled',
              'api_error',
              '服务暂时不可用，请稍后重试',
            )
            return
          }

          // ── #221：CORS 关闭时的 OPTIONS 要给准确答复，而不是落到鉴权 401 ──
          //
          // 实测：`cors.enabled: false` 时，浏览器的预检请求会一路走到鉴权、
          // 拿回 401 "API Key 无效" —— 而真正的原因是"这个网关没开跨域"。
          // 调用方会去查 API Key（那是对的），排查方向被完全带偏。
          //
          // CORS 未启用时的正确语义：**明确告诉对方跨域不支持**，
          // 并且不带 Access-Control-* 头（浏览器会因此拒绝该跨域请求，
          // 这正是我们想要的）。用 403 + 清晰的 code，比 401 诚实得多。
          //
          // 注意：只在 CORS **未启用**时走到这里。已启用但 origin 不在白名单的
          // 情况在上面已经用 403 cors_origin_not_allowed 处理过了。
          if (req.method === 'OPTIONS' && current.cors?.enabled !== true) {
            res.statusCode = 403
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({
              error: {
                message: '本网关未启用跨域（CORS）。浏览器直连请让服务端在 LANtern 设置里开启跨域并配置允许的来源；命令行 / SDK 调用不需要跨域，可忽略此提示。',
                type: 'cors_disabled',
                code: 'cors_not_enabled',
              },
            }))
            return
          }

          // --- 媒体产物下载（鉴权之前）---
          // 产物 token 是 18 字节随机数，本身就是 capability URL：
          // 浏览器 <img src> / <video src> 没法带 Authorization 头，所以这一条
          // 路径必须放行。token 不可枚举、有 TTL，泄露面仅限"拿到链接的人"。
          // #194：媒体功能（生图/生视频）已移除。
    // 保留这行注释是为了让后来者知道这里曾经有一条路由，
    // 而不是怀疑「为什么 /v1/images/generations 返回 404」。

          // --- 鉴权闸门（§8）---
          // 默认拒绝一切未鉴权请求；不提供"无鉴权模式"（除非显式开启 allowAnonymous）。
          const presented = extractCredential(req.headers)
          const record = presented === undefined ? undefined : keyStore.verify(presented)
          if (record === undefined) {
            if (!(presented === undefined && current.auth?.allowAnonymous === true)) {
              const noKeys = keyStore.isEmpty
              entryError(
                401,
                noKeys
                  ? '尚未生成任何 API Key：请到 设置 → LANtern → 状态与安全 生成一个后再连接'
                  : 'API Key 无效或已停用',
                'invalid_request_error',
                'invalid_api_key',
                'authentication_error',
                noKeys ? '服务尚未开放：请联系服务提供方获取访问凭证' : undefined,
              )
              return
            }
          } else {
            void keyStore.touch(record)
          }
          // 把"这次请求是谁发的"挂到 req 上，交给下游（媒体层用它做任务隔离）。
          //
          // 为什么不用参数一路往下传：媒体层的入口是 mediaGateway.handle(req, ...)，
          // 它已经有 4 个参数、内部还有十几个 handler；而身份是**每个请求都有**的
          // 环境信息，挂 req 比改 20 个签名更不容易漏。匿名与"未配 key"场景落到同一个
          // 共享身份，这是刻意的——没有 key 就没有可区分的调用者。
          req.lanternKeyId = record?.id ?? '__anonymous__'

          // --- 媒体端点（鉴权之后）---
          // 内部已做 try/catch 并用 OpenAI 形状回错：外层 catch 只会统一回
          // 500 "内部错误"，会把"没登录 WorkBuddy""本机开关关着"这类
          // 可诊断原因吞掉。
          // #194：同上，媒体路由已移除。

          if (req.method === 'GET' && pathname === '/v1/models') {
            const providerFilter = url.searchParams.get('provider')
            // 能力摘要的总开关（`capabilities.expose`，默认开）此前**写了但没人读**。
            //
            // 它有两种关法，都对应真实需求：
            //   · 配置里 `capabilities.expose = false` —— 网关管理员决定整台机器都不公布；
            //   · 请求带 `?capabilities=0` —— 某个客户端嫌响应体太大，自己不要。
            // 关掉后 `/v1/models` 仍是合法 OpenAI 目录，只是不带 x-lantern.capabilities
            // 这些扩展字段；不会影响转发（转发时的能力校验独立于"是否公布"）。
            const includeCaps = current.capabilities?.expose !== false
              && url.searchParams.get('capabilities') !== '0'
            // 只暴露自定义模型时，真实模型**一条都不列**。
            //
            // 注意这不只是"少给点东西"：它与解析层的拒绝是同一件事的两面
            // （resolveModel 也会拒），否则就会出现"目录里没有、但调用能成功"
            // ——那是最难排查的一类不一致。两处必须同时生效。
            const customOnly = current.customOnly === true
            const selected = customOnly
              ? []
              : directory.list().filter((e) => providerFilter === null || e.provider === providerFilter)
            // 能力是按模型逐个查询的（resolveModelInfo）；并行但有上限，
            // 避免 150+ 个模型同时打向上游元数据查询。
            const models = includeCaps
              ? await mapWithConcurrency(selected, 8, async (entry) => {
                  try {
                    return toOpenAiModel(entry, await capabilities.describe(entry.provider, entry.model), current)
                  } catch {
                    // 能力查询失败不应让目录整体失败：退回不带 capabilities 的条目
                    return toOpenAiModel(entry, undefined, current)
                  }
                })
              : selected.map((entry) => toOpenAiModel(entry, undefined, current))

            // 自定义模型（虚拟名）也必须在目录里可见：
            // 否则客户端「先查目录、再挑一个发请求」的流程永远发现不了它们。
            // provider 过滤时按"绑定里是否含该 provider"来判断。
            const customs = normalizeCustomModels(current.customModels)
              .filter((m) => m.enabled)
              .filter((m) => providerFilter === null || m.bindings.some((b) => {
                // 用 resolveRealModel：绑定项是真实模型，走 resolveModel 会在
                // customOnly 开启时被自己的闸门拦下，导致按 provider 过滤时全部消失。
                const t = resolveRealModel(directory, b)
                return t.provider === providerFilter
              }))
            const customRows = await mapWithConcurrency(customs, 8, async (m) => {
              const virtual = {
                custom: true,
                customId: m.id,
                customName: m.name,
                publicName: m.name,
                display: m.display,
                bindings: m.bindings,
              }
              const { plans, skipped } = buildFailoverPlans(directory, virtual, current)
              let caps
              let capsByBackend
              let capsNote
              if (includeCaps) {
                const views = []
                for (const plan of plans) {
                  try {
                    views.push(await capabilities.describe(plan.provider, plan.model))
                  } catch {
                    views.push(undefined)
                  }
                }
                const summary = summarizeCapabilities(plans, views, isTopologyMasked(current))
                caps = summary.merged
                capsByBackend = summary.byBackend
                capsNote = capabilityNoteOf(summary.merged, summary.byBackend)
              }
              // ── 推理档位的外显（第十四轮 #156，第十八轮 #195 大改）──
              //
              // ⚠ 之前的做法**只报固定的四档契约**（minimal/low/medium/max），
              // 于是所有模型看起来一模一样 —— 客户端（Cherry Studio / LibreChat…）
              // 无法知道自己对接的这个模型到底认哪些档，只能按四档猜。
              // 实测用户反馈："能不能自动识别？" —— 答案是**能**，数据一直都有。
              //
              // DSH 内核的 `resolveModelInfo()` 会回 `reasoning.efforts[{id,name,description}]`
              // 和 `reasoning.defaultEffort`（见 capabilities.js 的 authoritativeOf），
              // 那就是模型**真实声明**的档位 —— 与 DSH 登录官方账号时看到的完全同源。
              //
              // 现在分两层暴露：
              //   · reasoning_efforts           —— **真实词表**（优先），客户端据此渲染选择器
              //   · reasoning_efforts_contract  —— 四档契约（上游词表没有对应概念时兜底）
              //
              // 另加两个说明字段，让客户端能区分"这是我猜的"还是"模型自己声明的"：
              //   · reasoning_efforts_source    —— 'model' | 'contract' | undefined
              //   · reasoning_default_effort    —— 模型声明的默认档（来自 DSH）
              // #195 回滚：对外统一四档（真实词表只在内部用于映射）。
              const contractLevelsArr = Array.isArray(caps?.contractLevels)
                ? caps.contractLevels.map((c) => c?.level).filter((x) => typeof x === 'string')
                : []
              const effortsCompat = contractLevelsArr.length > 0 ? contractLevelsArr : undefined
              const modelDefaultEffort = typeof caps?.reasoning?.defaultEffort === 'string'
                ? caps.reasoning.defaultEffort
                : undefined

              return {
                id: m.name,
                object: 'model',
                created: Math.floor((m.createdAt ?? 0) / 1000),
                owned_by: 'lantern',
                root: m.name,
                ...(effortsCompat === undefined ? {} : {
                  // 顶层兼容名：四档契约（#195 回滚：统一优先）
                  reasoning_efforts: effortsCompat,
                  supported_reasoning_efforts: effortsCompat,
                  capabilities: { reasoning_efforts: effortsCompat },
                  // 模型自己声明的默认档：不影响档位列表，只影响客户端初始选中项
                  ...(modelDefaultEffort === undefined ? {} : { reasoning_default_effort: modelDefaultEffort }),
                }),
                'x-lantern': {
                  provider: null,
                  providerName: 'lantern',
                  model: m.name,
                  display: m.display,
                  custom: true,
                  custom_id: m.id,
                  // 绑定顺序 = 故障转移优先级。顺序本身要暴露（客户端据此理解
                  // 「首选挂了才会轮到后面的」），但**身份**是否暴露由 exposure 开关决定：
                  // 面向客户的网关只回「第几档、可不可用」，不回 trae / xdpool 这种名字。
                  bindings: publicBindingRows(m.bindings, plans, skipped, current),
                  ...(includeCaps ? { capabilities: caps } : {}),
                  ...(includeCaps && capsByBackend !== undefined ? { capabilitiesByBackend: capsByBackend } : {}),
                  ...(includeCaps && capsNote !== undefined ? { capabilityNote: capsNote } : {}),
                },
              }
            })

            sendJson(res, 200, { object: 'list', data: [...customRows, ...models] })
            return
          }

          // 单模型详情（OpenAI 亦有该端点，§6.5.4）
          if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
            let id
            try {
              id = decodeURIComponent(pathname.slice('/v1/models/'.length))
            } catch {
              // 畸形百分号编码（如 `/v1/models/%`）会抛 URIError。
              // 那是客户端填错了，不是网关内部错误——回 400，别让它冒到
              // 外层 catch 变成 lantern_internal 500。
              sendJson(res, 400, errorBody('模型 id 的百分号编码非法', 'invalid_request_error', 'bad_request'))
              return
            }
            // 与 /v1/chat/completions 保持一致的解析口径：先严格命中，再走
            // 裸模型名的宽松反查。否则会出现「能调用但查不到详情」的自相矛盾。
            const resolved = resolveModel(directory, id, current)
            const entry = resolved.error === undefined ? resolved : undefined
            if (entry === undefined) {
              // customOnly 下不要泄露真实模型清单：available 只列自定义模型名，
              // 否则"只暴露自定义模型"的封闭服务会通过错误响应的 available
              // 把内部真实模型名整个倒出来（等于自曝后端拓扑）。
              const availableCustomOnly = normalizeCustomModels(current.customModels)
                .filter((m) => m.enabled)
                .map((m) => m.name)
              // 脱敏时连 hint / available 一起收回：
              // `deepseek-v4.1-flash@trae` 这种公开名会在文案里点名 provider，
              // 而「去 /v1/models 里挑一个」已经足够行动——不需要把拓扑写进错误体。
              const masked = isTopologyMasked(current)
              // 回显用户填的名字是必要的（否则他不知道哪个名字错了），但
              // `xxx@trae` 这种公开名本身就把 provider 写在了脸上——脱敏时
              // 交给 publicMessage 收敛成裸模型名。
              sendJson(res, 404, errorBody(publicMessage(`模型未找到：${id}`, current), 'invalid_request_error', 'model_not_found', {
                ...(masked
                  ? { hint: '请使用 /v1/models 返回的模型名' }
                  : {
                      hint: current.customOnly === true
                        ? '本网关只暴露自定义模型，请在 /v1/models 里挑选可用的模型名'
                        : '可填公开名 <model>@<provider>，也可直接填裸模型名（如 deepseek-v4.1-flash）',
                      available: current.customOnly === true
                        ? availableCustomOnly.slice(0, 50)
                        : directory.list().map((e) => e.publicName).slice(0, 50),
                    }),
              }))
              return
            }
            if (entry.custom === true) {
              const { plans, skipped } = buildFailoverPlans(directory, entry, current)
              const views = []
              for (const plan of plans) {
                try {
                  views.push(await capabilities.describe(plan.provider, plan.model))
                } catch {
                  views.push(undefined)
                }
              }
              // 展示侧：给保守下界 + 逐档真实能力。只报交集会让"能带 tools 的模型"
              // 在目录里显示成 unknown，与执行侧自相矛盾（详见 summarizeCapabilities）。
              const masked = isTopologyMasked(current)
              const summary = summarizeCapabilities(plans, views, masked)
              const note = capabilityNoteOf(summary.merged, summary.byBackend)
              // 与列表端点同一个开关：管理员关掉 capabilities.expose 后，
              // 详情也不该冒出能力字段（否则"关掉了还在报"比一开始就不报更费解）。
              const exposeCaps = current.capabilities?.expose !== false
              // ── #222：单条查询必须与列表端点给出**同一组**顶层字段 ──
              //
              // 实测（用户 5 个模型全是自定义模型）：
              //   GET /v1/models              → reasoning_efforts = [minimal,low,medium,max] ✓
              //   GET /v1/models/{id}         → reasoning_efforts = undefined          ❌
              //
              // 根因：自定义模型在这个分支里**手写**响应体，只填了 x-lantern.*，
              // 漏掉了 `publicModelRow` 会输出的三个顶层字段。于是：
              //   · 客户端遍历列表能拿到四档，单独查同一个模型拿不到；
              //   · 有的 SDK 会先列表、有的会先单查，行为就分成两套。
              //
              // 这里补上同样的字段（取值来源与 publicModelRow 完全一致：
              // summary.merged.contractLevels → level 名列表）。
              // 默认档用 summary.merged.reasoning.defaultEffort 优先，
              // 退回到契约默认（自定义模型没有"单一默认档"的概念，
              // 因为每个绑定可能不同，取链上聚合的那个）。
              const contractLevelsForRow = Array.isArray(summary?.merged?.contractLevels)
                ? summary.merged.contractLevels.map((c) => c?.level).filter((x) => typeof x === 'string')
                : []
              const effortsForRow = contractLevelsForRow.length > 0 ? contractLevelsForRow : undefined
              const defaultEffortForRow = typeof summary?.merged?.reasoning?.defaultEffort === 'string'
                ? summary.merged.reasoning.defaultEffort
                : undefined
              sendJson(res, 200, {
                id: entry.publicName,
                object: 'model',
                created: 0,
                owned_by: 'lantern',
                root: entry.publicName,
                // #222：与 publicModelRow 的 effortFields 保持同一形状
                ...(effortsForRow === undefined ? {} : {
                  reasoning_efforts: effortsForRow,
                  supported_reasoning_efforts: effortsForRow,
                  capabilities: { reasoning_efforts: effortsForRow },
                  ...(defaultEffortForRow === undefined ? {} : { reasoning_default_effort: defaultEffortForRow }),
                }),
                'x-lantern': {
                  provider: null,
                  providerName: 'lantern',
                  model: entry.publicName,
                  display: entry.display,
                  custom: true,
                  custom_id: entry.customId,
                  bindings: publicBindingRows(entry.bindings, plans, skipped, current),
                  ...(exposeCaps ? { capabilities: summary.merged } : {}),
                  ...(exposeCaps ? { capabilitiesByBackend: summary.byBackend } : {}),
                  ...(exposeCaps && note !== undefined ? { capabilityNote: note } : {}),
                },
              })
              return
            }
            let caps
            try {
              caps = await capabilities.describe(entry.provider, entry.model)
            } catch {
              caps = undefined
            }
            sendJson(res, 200, toOpenAiModel(entry, caps, current))
            return
          }

          // --- 对话转发（P2 核心）---
          const forwardDeps = {
            directory,
            keyStore,
            capabilities,
            ledger,
            breaker,
            // 后端健康记忆（只影响故障转移链的**顺序**，不影响可用性）。
            backendHealth,
            // #216：后台自检需要 `ctx.llm` 去真打一次上游。
            // 传一个惰性取值函数而不是直接传 ctx —— 这样 orderByHealth
            // 在纯排序场景（没有全冷却）时完全不会碰到它。
            sweepContext: () => ctx,
            cfg,
            current: () => current,
            acquireSlot,
            releaseSlot,
            allowRate,
            record,
            log: (level, message) => {
              if (level === 'error') ctx.logger.error(message)
              else ctx.logger.info(message)
            },
          }
          if (req.method === 'POST' && pathname === '/v1/chat/completions') {
            await handleChatCompletions(ctx, req, res, forwardDeps)
            return
          }

          // --- OpenAI Responses 兼容通道（/v1/responses，Codex CLI / OpenAI SDK 新协议）---
          if (req.method === 'POST' && pathname === '/v1/responses') {
            if (current.protocol?.responses !== true) {
              // 与 anthropic 开关同一纪律：明确说明这是网关开关而非"模型不支持"
              sendJson(res, 404, errorBody(
                isHintMasked(current)
                  ? '该接口未开放，请改用 /v1/chat/completions'
                  : 'Responses 兼容端点未启用（protocol.responses=false）。' +
                      '这与"模型不支持"是两件事——如需使用，请在 设置 → LANtern → 状态与安全 中开启。',
                'invalid_request_error',
                'responses_disabled',
              ))
              return
            }
            await handleResponses(ctx, req, res, forwardDeps)
            return
          }

          // --- Anthropic 兼容通道（P11，§6.2）---
          if (req.method === 'POST' && pathname === '/v1/messages') {
            if (current.protocol?.anthropic !== true) {
              // 关闭时明确说明"这是网关开关"，与"上游不支持"区分开（铁律 3）
              // 脱敏时整句换成面向客户的话：把内部开关名 protocol.anthropic
              // 和面板路径一起收回去，剩下的对调用方毫无行动价值。
              sendJson(res, 404, anthropicError(
                isHintMasked(current)
                  ? '该接口未开放，请改用 /v1/chat/completions'
                  : 'Anthropic 兼容端点未启用（protocol.anthropic=false）。' +
                      '这与"模型不支持"是两件事——如需使用，请在 设置 → LANtern → 状态与安全 中开启。',
                'invalid_request_error',
              ))
              return
            }
            await handleAnthropicMessages(ctx, req, res, forwardDeps)
            return
          }

          sendJson(res, 404, errorBody(`未知端点：${req.method} ${pathname}`, 'invalid_request_error', 'unknown_endpoint'))
        } catch (error) {
          ctx.logger.error('[lantern] 请求处理异常')
          ctx.logger.error(error)
          if (!res.headersSent) {
            // 不把内部细节回给客户端（可能含路径与栈）；细节只写本机日志。
            //
            // ⚠ 但**脱敏的定位线索**要回：第十一轮排查那个 TDZ 自引用时，
            //    客户端只拿到一句"内部错误"，日志又拿不到，只能靠猜。
            //    这里补两件事，都不泄露路径与业务数据：
            //      · `LANTERN_DEBUG_ERRORS=1` 时把 message 与栈首帧回给客户端；
            //      · 始终回一个 X-Lantern-Internal-Frame 头（仅当显式开启调试）。
            //    默认关闭 —— 生产环境不该把内部结构暴露给局域网调用方。
            // 默认开启详细错误（本机自用网关，不是多租户生产）。
            // 想要屏蔽就设 LANTERN_DEBUG_ERRORS=0。
            //
            // 为什么改默认为开：这一轮排查一个 500 花了太久，因为日志目录是空的
            // （ctx.logger 不落盘），客户端只拿到"内部错误"四个字。
            // 对一个只服务自己人的网关来说，"能不能查"比"藏得深"重要得多。
            const debug = process.env.LANTERN_DEBUG_ERRORS !== '0'
            const frame = typeof error?.stack === 'string'
              ? (error.stack.split('\n').find((l) => l.includes('dsh-lantern')) ?? '').trim()
              : ''
            if (debug && frame.length > 0 && !res.headersSent) {
              res.setHeader('X-Lantern-Internal-Frame', encodeURIComponent(frame.slice(0, 200)))
            }
            // 把 error.name 也带上：TypeError / ReferenceError / RangeError
            // 三类根因完全不同，只给 message 有时看不出是哪类。
            const errName = typeof error?.name === 'string' ? error.name : 'Error'
            sendJson(res, 500, errorBody(
              debug && typeof error?.message === 'string'
                ? `LANtern 内部错误：${errName}: ${error.message}`
                : 'LANtern 内部错误（详情见插件日志）',
              'internal_error',
              'lantern_internal',
            ))
          } else if (!res.writableEnded) {
            // 头已经发出去了（流式请求），这时既不能再发错误响应、也不能什么都不做：
            // 什么都不做会让连接一直挂到客户端自己超时（浏览器/agent 通常等几十秒）。
            // 掐断是唯一诚实的收尾——客户端能看到连接被中断，而不是"还没回完"。
            res.destroy()
          }
        }
      },
    }

    // 保存 handler 供 ListenManager 复用（standalone 服务用同一个处理器）
    inferenceHandler = route.handler

    // reuse 模式的注册控制器：允许运行中动态挂载/卸载，而不必重启插件。
    let reuseRegistered = false
    const reuseDisposer = { current: undefined }
    listenManager.setReuseControl({
      get registered() {
        return reuseRegistered
      },
      register() {
        if (reuseRegistered) return
        reuseDisposer.current = webServer.register(route)
        reuseRegistered = true
        ctx.logger.info('[lantern] 已在 DSH 端口上挂载 /v1/*（reuse 模式）')
      },
      unregister() {
        if (!reuseRegistered) return
        try {
          reuseDisposer.current?.()
        } catch {
          /* ignore */
        }
        reuseDisposer.current = undefined
        reuseRegistered = false
        ctx.logger.info('[lantern] 已从 DSH 端口卸载 /v1/*（reuse 模式停用）')
      },
    })

    // 管理通道（/api/lantern）在**独立的 connection 注入作用域**内注册。
    //
    // ⚠ 两个必须遵守的点（均已实测）：
    // 1. **必须用 `connection.fetch.register`，不能用 `webServer.register`**：
    //    client 的 `ctx.connection.rpc.call` 走 DSH 的 RPC 信封协议
    //    （`{type:'client-request', rpcId, method, payload}`），只有 connection.fetch
    //    认领它；用 webServer 会表现为「面板点不动」。
    // 2. **必须在 `ctx.inject(['connection'], …)` 回调内取 connection**：
    //    直接 `ctx.get('connection')` 会抛
    //    `cannot get property "connection" without inject`（本机实测），
    //    进而中断后面的注册逻辑（曾导致自检端点也一起 404）。
    ctx.inject(['connection'], (cctx) => {
      try {
        const connection = cctx.get('connection')
        if (connection === undefined) {
          ctx.logger.warn('[lantern] connection 为 undefined')
          ctx.logger.warn('[lantern] connection 服务不可用，设置面板将无法读写')
          return
        }
        const managed = installManagementRpc(ctx, { ...rpcDeps, connection }, 'lantern')
        if (managed.installed) {
          ctx.logger.info('[lantern] 已注册管理通道 /api/lantern')
          cctx.effect(() => managed.dispose)
        } else {
          ctx.logger.warn('[lantern] connection.fetch 不可用，管理通道未安装')
        }
      } catch (error) {
        // 管理通道失败**不得**阻断自检端点注册（否则 health 会 404，
        // 让"插件是否加载"变得不可判断）。
        ctx.logger.warn(`[lantern] 管理通道注册失败：${error?.message}`)
      }
    })

    // 卸载时撤销 reuse 路由。
    sctx.effect(() => () => {
      try {
        reuseDisposer.current?.()
      } catch {
        /* ignore */
      }
      reuseDisposer.current = undefined
      reuseRegistered = false
    })

    // 自检端点：**独立注册、始终可用**（不依赖 enabled，也不依赖 reuse 条目是否启用）。
    // 理由（设计方案 §6.5.4）：health 的作用是"让管理员确认插件已加载"，
    // 若它也随 enabled 消失，就失去了自检的意义（本机实测踩到过：未启用时 404，
    // 被误判成"插件加载失败"）。
    const healthRoute = {
      kind: 'exact',
      path: '/v1/lantern/health',
      handler: (req, res) => {
        try {
          // 脱敏时只回最小字段集 —— 与 /v1 前缀里那份保持一致。
          //
          // 这条 exact 路由本就**免鉴权**（它的作用是"让管理员确认插件已加载"），
          // 在默认配置（exposure.maskTopology=true）下若把 listen/directory/media
          // 的明细全盘托出，等于给局域网里任何人一份拓扑清单：
          // directory.diagnostics() 带每个 provider 的 hiddenReason（上游错误原文）、
          // media.describe() 带 mediaDir 绝对路径与每条 provider 的 baseUrl、
          // listen 带真实绑定地址。前缀路由早就有这个判断，exact 路由漏了，
          // 而 exact 才是实际生效的那一个（所以那个判断成了死代码）。
          if (isMasked(current)) {
            sendJson(res, 200, { ok: true, plugin: name, enabled: current.enabled })
            return
          }
          sendJson(res, 200, {
            ok: true,
            plugin: name,
            enabled: current.enabled,
            listen: listenManager.status(),
            auth: {
              keyCount: keyStore.records.length,
              usable: keyStore.records.filter((r) => r.enabled !== false).length,
              allowAnonymous: current.auth?.allowAnonymous === true,
              format: current.auth?.format ?? 'sk',
            },
            inflight: currentGate().inflight,
            // P12：熔断与并发/保留槽状态。
            // ⚠ 这里是 **exact 路由**，按 DSH 的路由规则（exact 优先于最长前缀）
            // 它是实际生效的那一个——所以字段必须加在这里，否则 /v1 前缀里那份是死代码。
            breaker: breaker.status(),
            // 后端健康记忆（同 /v1/lantern/health 那份，两条路由都要有字段）。
            backendHealth: backendHealth.status(),
            concurrency: currentGate().status(),
            directory: directory.diagnostics(),
          })
        } catch (error) {
          ctx.logger.error('[lantern] health 处理异常')
          ctx.logger.error(error)
          sendJson(res, 500, errorBody('health 失败', 'internal_error', 'lantern_internal'))
        }
      },
    }
    sctx.effect(() => webServer.register(healthRoute))
    ctx.logger.info(`[lantern] 已注册自检端点 ${healthRoute.path}（始终可用）`)

    // 按当前配置开始监听（reuse 立即挂载；standalone 依次尝试开启）。
    //
    // ⚠ **必须先 `await configReady`**：本回调是同步触发的，而配置是异步读入的。
    // 不等它就会用"apply 初值"去决定监听模式 —— 磁盘配置被忽略（实测：
    // 改成 standalone 某端口，却始终按 reuse 的 DSH 端口启动，新端口从未监听）。
    void (async () => {
      await configReady
      const normalized = normalizeEntries(current.listenEntries, webServer.port, detectActualBind())
      if (normalized.ok) {
        const applied = await listenManager.apply(normalized.entries)
        if (!applied.ok) ctx.logger.warn(`[lantern] 监听初始化未完全成功：${applied.message}`)
        else {
          const modes = normalized.entries
            .filter((e) => e.enabled !== false)
            .map((e) => (e.mode === 'reuse' ? `reuse:${webServer.port}` : `standalone:${e.port}/${e.bind}`))
            .join('、')
          ctx.logger.info(`[lantern] 监听已按磁盘配置启动：${modes}`)
        }
      } else {
        ctx.logger.warn(`[lantern] 监听配置无效：${normalized.message}`)
      }
    })()
  })
}

export { ModelDirectory, parsePublicName, publicNameOf }

/**
 * 档 C：从上游失败中学习"不支持某能力"。
 *
 * 只在错误**明确指向某能力**时记录（`detectNegativeCapability` 判断），
 * 避免把网络错误/限流误判成"不支持"。记录后 `/v1/models` 会立刻改口。
 *
 * @param deps - 转发依赖（需要 capabilities）。
 * @param target - 目标模型条目。
 * @param failure - DSH 的 LlmFailure。
 */
async function learnFromFailure(deps, target, failure) {
  if (deps.capabilities === undefined) return
  const message = String(failure?.message ?? '')
  const field = detectNegativeCapability(message)
  if (field === undefined) return
  try {
    const learned = await deps.capabilities.learnNegative(target.provider, target.model, field, maskSecrets(message))
    if (learned) {
      deps.log?.(
        'info',
        `[lantern] 负能力学习：${target.publicName} 的 ${field} 记为不支持（上游报错原文已脱敏记录）`,
      )
    }
  } catch (error) {
    deps.log?.('error', `[lantern] 负能力学习写入失败：${error?.message}`)
  }
}

/**
 * 档 D：带图片的请求返回空回答时，把该档的 image 记为不支持（第十五轮 #159）。
 *
 * ## 为什么需要单独一条
 *
 * `learnFromFailure` 只认**报错**里明确点名的能力。但实测 `hy4` 的图片支持
 * 不是「报错」而是「静默空」：
 *
 * ```
 * hy4 A 纯文本        att=1  stop              正文 106 字   ✅
 * hy4 B 纯图片无system att=5  empty_completion  0 字         ❌
 * hy4 C 图片+system   att=5  empty_completion  0 字         ❌
 * hy4 D 图片+大预算    att=5  empty_completion  0 字         ❌
 * ```
 *
 * 它的 DSH 元数据写着 `image=supported`（`source=dsh`），三档全这么写，
 * 但真实能力是不支持。`detectNegativeCapability('')` 对空字符串返回
 * undefined，所以这条证据永远学不到 —— `/v1/models` 会一直撒谎。
 *
 * ## 判据（宁可少记，不可错记）—— 第十五轮收紧
 *
 * 实测教训：`hy4` 第一次带图返回空，我记成 `image=unsupported`，
 * **但清掉记录后重测，它连续两次成功（152 字 / 249 字）**。
 * 那次空回答是并发槽紧张 + 首包超时叠加造成的偶发 `empty_completion`，
 * 与"支不支持图片"毫无关系。误记的代价很重：闸门会永久拒绝该档的带图请求，
 * 而真正的图片能力被埋掉。
 *
 * 所以现在要求**全部**满足才记：
 *
 * 1. 请求确实带了图片（`hasImages === true`）
 * 2. `finish_reason === 'empty_completion'`（彻底空；`reasoning_only` 是预算问题）
 * 3. **`attempts` 里没有任何一次是超时**（`backend_timeout`）
 *    —— 超时说明"来不及"，不代表"不愿意"
 * 4. **`attempts` 里没有任何一次是并发/限流类错误**
 *    —— 槽满、429、503 都是"稍后就好"，不是能力问题
 * 5. 这一次是**第一次尝试就空**（`attempts.length === 1`）
 *    —— 如果重试过，空可能是重试序列的副作用
 *
 * 宁可不学（继续按 `unknown` 放行并标 `X-Lantern-Capability-Unverified`），
 * 也不要错学（永久埋掉一个其实可用的能力）。
 *
 * @param deps - 转发依赖（需要 capabilities）。
 * @param target - 目标模型条目。
 * @param failure - 这一次的失败。
 * @param hasImages - 本次请求是否带了图片。
 * @param attempts - 本次请求的所有尝试记录（用于排除超时/限流）。
 */
async function learnImageUnsupported(deps, target, failure, hasImages, attempts) {
  if (hasImages !== true) return
  if (deps.capabilities === undefined) return
  if (failure?.code !== 'empty_completion') return

  // 证据判据（第十六轮 #179 放宽）
  //
  // 原判据要求 `attempts.length === 1` —— 即"一次干净尝试、结果全空"才算数。
  // 想法是谨慎：多次尝试可能夹杂临时故障。
  //
  // 但实测 `hy4` 带图请求：**三个绑定全试过、全部 empty_completion**（att=3），
  // 于是永远进不了学习分支 —— 每次请求都白跑 3 次上游、每次都返回空正文，
  // 却永远学不到"这个模型不支持图片"。用户看到的是"传图没反应"。
  //
  // 现在改成：**所有尝试都是同一类失败（empty_completion）且没有超时/限流/取消**
  // 才认定是能力问题。多绑定全空比单次空更有说服力，不是更少。
  const list = Array.isArray(attempts) ? attempts : []
  if (list.length === 0) return
  // 每一条尝试都必须是 empty_completion（任一不是就说明有别的干扰）
  for (const attempt of list) {
    const code = String(attempt?.failure?.code ?? '')
    const status = Number(attempt?.failure?.status ?? 0)
    // 空产出没被记为 failure 的（正常结束）也算空
    const isEmpty = code === 'empty_completion' || code === ''
    if (!isEmpty && code !== 'reasoning_only_empty') return
    // 超时：说明来不及，不代表不支持
    if (code === 'backend_timeout') return
    // 并发/限流/熔断：稍后就好，不是能力问题
    if (status === 429 || status === 503 || code === 'rate_limited' || code === 'busy') return
    // 取消：客户端自己断的
    if (code === 'aborted' || code === 'canceled') return
  }
  try {
    const learned = await deps.capabilities.learnNegative(
      target.provider,
      target.model,
      'image',
      '带图片的请求返回空回答（上游静默拒绝图片输入）',
    )
    if (learned) {
      deps.log?.(
        'info',
        `[lantern] 负能力学习：${target.publicName} 的 image 记为不支持（带图请求返回空回答）`,
      )
    }
  } catch (error) {
    deps.log?.('error', `[lantern] 图片负能力写入失败：${error?.message}`)
  }
}

/**
 * 记一次调用到用量账本（P9）。
 *
 * 只在 `usage.enabled` 打开时写；任何异常都**不能影响转发**（记账失败只是少一条统计）。
 * `auth` 提供 key 标识（用于按 Key 区分用量）。
 *
 * @param deps - 转发依赖。
 * @param target - 目标模型条目。
 * @param options - `{ usage, status, ms, protocol, kind, errorCode, auth }`。
 */
async function recordCall(deps, target, options = {}) {
  // 熔断与 token 计量（P12）：放在**唯一的收口处**，两条协议与所有路径都覆盖。
  // 注意这里先于 `usage.enabled` 判断——即使账本关闭，保护本机的熔断也要工作。
  try {
    const keyId = (options.key ?? deps.record)?.id ?? '__anonymous__'
    if (options.status === 'ok') {
      deps.breaker?.recordSuccess(keyId, options.usage?.outputTokens ?? 0)
    } else {
      deps.breaker?.recordFailure({
        code: options.errorCode,
        status: options.errorStatus,
        message: options.errorMessage,
      })
    }
  } catch (error) {
    deps.log?.('error', `[lantern][breaker] 状态记录失败（不影响转发）：${error?.message}`)
  }

  try {
    const cfg = deps.current()
    if (cfg?.usage?.enabled === false) return
    // key 记录由鉴权闸门给出（deps.record），匿名访问时为 undefined。
    // 注意：指纹不是 record 的字段，要用 fingerprintOf() 由 head/tail 算出。
    const key = options.key ?? deps.record
    await recordUsage({
      ts: Date.now(),
      provider: target.provider,
      model: target.model,
      publicName: target.publicName,
      // #234：用户请求的模型名（自定义模型名 / 公开名）。
      // publicName 是上游真实坐标，这个是"用户点的那个模型"。
      // 老记录没有这一列 → 聚合时回退用 publicName，保证新旧都能统计。
      ...(target.requestedModel === undefined ? {} : { requestedModel: target.requestedModel }),
      keyId: key?.id ?? 'anonymous',
      keyLabel: key?.label ?? null,
      keyPrint: key === undefined ? null : fingerprintOf(key),
      kind: options.kind ?? 'inference',
      status: options.status ?? 'ok',
      ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      protocol: options.protocol ?? 'openai',
      ms: options.ms,
      ...(options.imageCount === undefined ? {} : { imageCount: options.imageCount }),
      usage: toLedgerUsage(options.usage),
    })
  } catch (error) {
    deps.log?.('error', `[lantern][usage] 记账失败（不影响转发）：${error?.message}`)
  }
}

/**
 * 共用能力闸门（P4 策略，**两条协议必须走同一份**）。
 *
 * 之所以抽出来：OpenAI 与 Anthropic 两条通道若各写一份闸门，
 * 迟早分叉成"一条严、一条松"——那正是设计文档 §6.5 最反对的静默降级。
 *
 * @param deps - 转发依赖（需要 capabilities）。
 * @param target - 目标模型条目。
 * @param request - `{ hasTools, hasImage, hasJsonMode, hasReasoningEffort, hasTemperature, hasStop }`。
 * @param plans - 本次请求的候选后端链（`buildFailoverPlans()` 的结果）。
 * @returns `{ reject, ignored, headers, capsView, plans }`（查询失败时全放行并记日志）。
 */
async function enforceCapabilityGate(deps, target, request, plans) {
  let capsView
  let enforceResult = { ignored: [], headers: {} }
  if (deps.capabilities === undefined) return { enforceResult, capsView, plans }
  try {
    if (target.custom === true) {
      // 自定义模型绑定了多个后端 → 按【本次请求真正要用的硬能力】筛链。
      //
      // 历史与取舍：这里原先取全体后端的**交集**，理由是"任一后端不支持就该如实拒绝"。
      // 听起来保守，实际很难用：用户给一个本来能带工具的模型补一档闪速后端
      //（它没声明 tools），整条链的 tools 立刻从 supported 退化成 unknown，
      // 于是"以前能带工具，加了一档后端之后全被拒"——能力凭空消失比少一档后端严重得多。
      // 所以改成筛链：
      //   - 请求要 tools → 只有【确认支持 tools】的后端留在链上，其余本请求不用；
      //   - 一档都不剩 → 用全体交集走 enforce 如实拒绝（与旧行为一致，绝不静默降级）；
      //   - 绝不做"放行但把 tools 悄悄丢掉"那种假成功。
      // 非首选档数进响应头（只给数量，不给身份）：运维可查，调用方推不出拓扑。
      // 头名沿用 X-Lantern-Backends-Ineligible（已公开，改名会断掉现有监控），
      // 但含义已从"被剔除"放宽为"没排进首选"——包含未知档（候补）与确认不支持的档。

      // **逐能力收敛 + 无证据档保留为候补**。
      //
      // 为什么不能一次求交集：请求同时要 tools + reasoning 时，若每档都只确认了其中
      // 一个能力，一次求交集会把整条链判成 unknown ——用户看到的是「工具调用能力未知」，
      // 可真正缺证据的是推理档位。报错指错能力比拒绝本身更难排查。
      //
      // 为什么"无证据"的档不能直接砍掉（这一步很关键）：
      //   `unknown` 的意思是**我们没有它的能力数据**，不是"它不支持"。
      //   把它当作不可用，等价于"没有档案就等于不能干"——
      //   于是当所有已确认支持的档同时挂掉时，本来可能能用的档一次都没被试过，
      //   请求直接 503。这跟"健康记忆不能禁用后端"是同一条道理：
      //   缺证据只能降级为**顺序上的劣势**，不能升级为**候选资格的剥夺**。
      //
      // 所以分三组（关键是 unknown 与 unsupported 不能同等对待）：
      //   preferred = 每个硬能力都确认支持 → 先试
      //   fallback  = 没有"确认不支持"、但也没全确认 → 排链尾候补（未知信息优先补齐）
      //   excluded  = 至少一个硬能力**确认不支持** → 本请求彻底不发
      //
      // 为什么 excluded 必须真删：把它留在链尾，等前面全挂时它就会收到一个
      // 带 tools 的请求，而它很可能**默默忽略 tools 返回纯文本** ——
      // 客户端以为自己拿到了工具调用结果，实际是被降级了。静默降级比失败更坏，
      // 所以"确认不支持"必须排除，而"没有数据"只降级为顺序劣势。
      // 组内保持用户配置的顺序。
      const chain = Array.isArray(plans) ? plans : []
      const rows = []
      for (const plan of chain) {
        try {
          rows.push({ plan, view: await deps.capabilities.describe(plan.provider, plan.model) })
        } catch {
          // 单个后端查询失败不拉黑整体：以 undefined 参与分组（等价于 unknown）
          rows.push({ plan, view: undefined })
        }
      }
      const valueIn = (row, field) => row.view?.[field]?.value ?? VALUE.unknown
      const supportedIn = (row, field) => valueIn(row, field) === VALUE.supported
      const unsupportedIn = (row, field) => valueIn(row, field) === VALUE.unsupported

      const hardNeed = []
      if (request.hasTools === true) hardNeed.push('tools')
      if (request.hasJsonMode === true) hardNeed.push('jsonMode')
      if (request.hasImage === true) hardNeed.push('image')
      if (request.hasReasoningEffort === true) hardNeed.push('reasoning')

      // ── 推理档位（reasoning_effort / thinking）也要按值筛链 ──
      //
      // 各家的档位词表并不相同：有的叫 `minimal/low/medium/high/max`，有的叫
      // `none/low/medium/high/xhigh`，还有的只分两档。用户在一个多绑定模型上
      // 传 `xhigh`，只有声明了 xhigh 的那几档能真正用上，其余档要么忽略这个参数
      // （静默降级）要么报错（把整条链拖挂）。所以这里按值筛，而不是只看
      // "有没有声明 reasoning 能力"。
      //
      // 三态口径与硬能力一致：
      //   声明了且包含    → 首选（一定能用上）
      //   没声明列表      → 候补（不知道，但不剥夺资格）
      //   声明了但不包含  → 排除（确定用不上；留着它等于让这个请求在它身上
      //                    静默降级成默认档位，用户以为调高了实际没变）
      // ── 推理档位按值筛链 ──
      //
      // ⚠ 第十轮改动：调用方现在可以只传**四档契约词**（minimal/low/medium/high）。
      // 旧逻辑是“词表里没有这个字符串就排除”，这对契约词是灾难 ——
      // 实际后端几乎不叫 `medium`，于是传 `medium` 会把整条链排空。
      //
      // 新口径：先尝试**契约映射**（mapLevelToBackend）。只要这个后端能从自己的
      // 词表里推出一档，就算它能兑现（因为执行侧会把它映射成真实词再下发）。
      // 契约词认不出时（比如调用方直接写了某家私有词）才回到严格匹配。
      // ── 推理档位按值筛链（第十轮重写） ──
      //
      // 两套规则，**不能混**：
      //
      // A. 调用方传的是**四档契约词**（minimal/low/medium/high）
      //    → 这是对外公开的抽象层。各家几乎不叫 `medium`，按字符串严格匹配
      //      会把整条链排空（实测：传 medium 时 glm-5.3 的 6 档全被排除）。
      //      改走**契约映射**：只要这个后端能从自己的词表里推出一档，就算能兑现。
      //      “推不出” 分两种情况：
      //        · 词表是空的（无档案）→ unknown，排链尾当候补
      //        · 词表认不出强弱（全陌生动词）→ unknown，同样不剥夺资格
      //
      // B. 调用方传的是**某家的具体词**（xhigh / extra_high / off / light …）
      //    → 这是他在明确指定一个具体档位，**必须严格匹配**。
      //      旧的“明确不认就排除”保护必须原样保留：把 `xhigh` 静默降成 `high`
      //      发给一个只认 high 的后端，就是“调高了实际没变”的静默失真。
      //
      // 两套规则的边界是 `isContractLevel()`，而不是“能不能映射”——
      // 后者会把 B 类偷偷变成 A 类，上面的保护会静默失效。
      const wantEffort = typeof request.reasoningEffort === 'string' && request.reasoningEffort.length > 0
        ? request.reasoningEffort
        : undefined
      const wantsContract = wantEffort !== undefined && isContractLevel(wantEffort)
      const effortsOf = (row) => {
        const list = row.view?.reasoning?.efforts
        return Array.isArray(list) ? list.filter((e) => typeof e === 'string') : []
      }
      const effortState = (row) => {
        if (wantEffort === undefined) return 'supported'
        const list = effortsOf(row)
        if (list.length === 0) return 'unknown'
        if (wantsContract) {
          // A 类：四档契约 → 能映射就放行；认不出就降为候补（不剥夺资格）
          const mapped = mapLevelToBackend(list, wantEffort)
          if (mapped.ok !== true) return 'unknown'
          // ── 单档词表不能算"支持"（第十六轮 #169）──
          //
          // `mapLevelToBackend(['high'], 'minimal')` 会返回 `ok:true`（落到 high），
          // 但它**并没有表达 minimal** —— 该家只有一档，选什么都只能是 high，
          // 而且没有任何降级提示。原来这里只看 `ok`，于是这种绑定被算成
          // `supported` 并留在 `preferred` 里、排在链首。
          //
          // 实测后果：`hy4` 的 #1/#2 各只有 `["high"]`，#3 有 5 档。
          // 三条都是 `supported`，#1 原序在前 → 由它接住请求 →
          // 实际下发 `high`、响应头 `Position: 1/1`，
          // **四档看起来全落 high**，而 #3 明明能区分四档。
          //
          // 现在：单档词表降为 `unknown`（候补，排链尾但不剥夺资格）。
          // 能真正区分该档位的绑定会排到前面，它的词表档数越多越优先。
          if ((Number(mapped.total) || 1) <= 1) return 'unknown'
          return 'supported'
        }
        // B 类：具体私有词 → **按强度等级相等**判定，不是按字面相等。
        //
        // ⚠ 这里踩过一次坑（第十轮 #104）：早先写的是字面严格匹配，
        // 于是 `reasoning_effort: 'off'`（客户端要"关思考"）在 glm-5.3 上
        // **一条后端都匹配不上** —— 因为 glm 的六档词表里用的是 `none`，没人叫 `off`。
        // 结果：六档全被 exclude → 回退到未筛链 → 把 `none` 发给所有人 →
        // 前四条后端被 DSH 以 UNSUPPORTED_REASONING_EFFORT 拒绝，第 5 次才成功
        // （实测 attempts=5），而用户要的"关掉思考"最终是碰巧达成的。
        //
        // 正确语义：`off` 和 `none` 是**同一档的两种叫法**（rank 都是 0），
        // 换名字不算降级。而 `xhigh`(rank 7) 与 `high`(rank 5) **不是**同一档 ——
        // 把 xhigh 发给只认 high 的后端就是"调高了实际没变"，必须继续排除。
        //
        // 所以判据从"字符串相等"改成"rank 相等"：既修好了 off/none 的别名问题，
        // 又原样保住了 xhigh→high 那道保护。
        const targetRank = rankOf(wantEffort)
        if (targetRank !== undefined) {
          const hit = list.some((e) => rankOf(e) === targetRank)
          return hit ? 'supported' : 'unsupported'
        }
        // 完全无法分级的词（某家自造的私有档）：只能退回字面匹配。
        const hit = list.some((e) => e === wantEffort) || list.some((e) => e.toLowerCase() === wantEffort.toLowerCase())
        return hit ? 'supported' : 'unsupported'
      }

      const preferred = rows.filter(
        (row) => hardNeed.every((field) => supportedIn(row, field)) && effortState(row) === 'supported',
      )
      const excluded = rows.filter(
        (row) =>
          hardNeed.some((field) => unsupportedIn(row, field))
          || (effortState(row) === 'unsupported' && !preferred.includes(row)),
      )
      const fallback = rows.filter((row) => !preferred.includes(row) && !excluded.includes(row))
      const ineligibleByHardCap = fallback.length + excluded.length

      // ⚠ 软参数（temperature / stop）**不参与筛链**（§6.5.5）。
      // 它们只影响风格不影响正确性，为它们砍掉故障转移档位是拿可用性换装饰：
      // 一旦只剩一档，原本能切换的 429 就变成硬失败。软参数的未知/不支持
      // 由 enforce 记进 X-Lantern-Ignored-Params，该露的痕迹一点没少。
      //
      // 组装：确认支持 → 未知 → （确认不支持的排除）。顺序即优先级。
      const assembled = [...preferred, ...fallback]
      const effectivePlans = assembled.length > 0 ? assembled.map((row) => row.plan) : plans
      // 闸门的判断口径：**逐能力独立判定**，不做整体合并。
      //
      // 为什么必须逐能力：请求同时要 tools + reasoning 时，链上可能
      // 「2 档确认支持 tools、0 档对 reasoning 有档案」。若把全体合成一个视图再判，
      // reasoning 的 unknown 会把 tools 一起拉成 unknown，于是报错说「工具调用能力未知」
      // ——可 tools 明明是确认支持的，真正缺证据的是推理档位。**报错指错能力**
      // 比拒绝本身更难排查（这一条在历史修复里踩过一次，不能再踩）。
      //
      // 所以：每个硬能力各问一次「链上有没有任何一档确认支持它」。
      //   有一档以上  → 该能力放行（这些档就在 preferred 里，请求会只发给它们）
      //   一档都没有  → 该能力拒绝，错误就指向它自己
      // 若多个能力同时无人支持，按 hardNeed 的顺序报第一个（与 enforce 的优先级一致）。
      const capsOf = (view) => (view === undefined || view === null ? {} : view)
      /** 哪些能力在链上一档支持都没有（含"全都没档案"） */
      const unsupportedNeed = hardNeed.filter((field) => !rows.some((row) => supportedIn(row, field)))
      if (preferred.length === 0) {
        // 一档首选都没有：至少有一个硬能力无人支持（可能同时多个）。
        // 逐能力拼出一份"合成视图"，只用于让 enforce 把话说清楚——
        // 确定有人支持的能力填 supported，其余填它在链上的最差值。
        const synthetic = {}
        for (const field of hardNeed) {
          const value = unsupportedNeed.includes(field)
            ? (rows.some((row) => unsupportedIn(row, field)) ? VALUE.unsupported : VALUE.unknown)
            : VALUE.supported
          // ⚠ 必须带上原 cell 的附字段：`reasoning` 的 `efforts` 就挂在这里，
          // 只写 `{ value, source }` 会把它抹掉，于是下方的档位校验看到空列表，
          // 走"不校验"那条口子——非法档位又会被原样下发（这正是修 ineligible 之前的老问题）。
          synthetic[field] = { ...(capsOf(rows[0]?.view)[field] ?? {}), value, source: 'chain' }
        }
        // 其余字段（软参数、数值、streaming 等）取链上最差值，保证 enforce 的软参数
        // 忽略逻辑与 reasoning 档位解析仍能拿到合理输入。
        const merged = intersectCapabilityViews(rows.map((row) => capsOf(row.view)))
        capsView = merged === undefined ? synthetic : { ...merged, ...synthetic }
        // ⚠ 上面 `{ ...merged, ...synthetic }` 会让 synthetic 整块盖掉 merged.reasoning，
        // 而 merged 里带着各档 efforts 的**并集**（synthetic 只抄了第一档的）。
        // 这里按全体行重算一次，保证"哪些档位值合法"这条判定看到的是并集。
        // 少了这一步：非法档位会因为列表被缩成第一档的而误报"不在可选值里"，
        // 反过来列表为空时又会走"不校验"的口子把非法值直接下发。
        capsView.reasoning = mergeReasoningCell(rows.map((row) => capsOf(row.view)), capsView.reasoning)
        enforceResult = deps.capabilities.enforce(capsView, request)
        if (ineligibleByHardCap > 0) {
          enforceResult.headers = {
            ...(enforceResult.headers ?? {}),
            'X-Lantern-Backends-Ineligible': String(ineligibleByHardCap),
          }
        }
        return { enforceResult, capsView, plans: effectivePlans }
      }
      // 有首选档：按它们合并。preferred 里每档都确认支持全部 hardNeed，
      // 所以这层合并在这些能力上必然还是 supported，不会自相矛盾。
      capsView = intersectCapabilityViews(preferred.map((row) => capsOf(row.view)))
      if (capsView === undefined) {
        return { enforceResult: { ignored: [], headers: {} }, capsView: undefined, plans: effectivePlans }
      }
      // ⚠ 软参数（temperature / stop）必须按**并集**判，不能跟着交集走（第十轮 #111）。
      //
      // 为什么不参与筛链的软参数也不能用交集：
      //   `stop` 在 glm-5.3 的 6 档里只有 1 档 `supported`、5 档 `unknown`。
      //   `intersectCapabilityViews` 取最小值 → `unknown` → `enforce()` 判"不是 supported"
      //   → stop 被整块丢弃，写 `X-Lantern-Ignored-Params: stop`。
      //   而 `/v1/models` 的展示侧用的是**并集**，对客户端说 `stop: supported`。
      //   于是"目录说能用、实际永远被丢" —— 客户端完全无从判断。
      //
      // 软参数的正确口径：**链上有任何一档确认支持，就该下发**。原因有二：
      //   1. 它不参与筛链，所以"某一档不认"不会导致请求失败（最坏是那档忽略它）；
      //   2. 交集在这里表达的不是"安全"，而是"只要有不确定就全都别用" ——
      //      这等于让 5 条 `unknown` 否决 1 条 `supported`，与能力三态的整体语义相反。
      // 实装：把这些字段用并集覆盖回 capsView，交集的结论只保留在硬能力上。
      for (const softField of ['temperature', 'stop']) {
        const values = preferred.map((row) => capsOf(row.view)?.[softField]?.value ?? VALUE.unknown)
        if (values.includes(VALUE.supported)) {
          const srcRow = preferred.find((row) => capsOf(row.view)?.[softField]?.value === VALUE.supported)
          capsView[softField] = {
            value: VALUE.supported,
            source: capsOf(srcRow?.view)?.[softField]?.source ?? 'union',
          }
        }
      }
      enforceResult = deps.capabilities.enforce(capsView, request)
      if (ineligibleByHardCap > 0) {
        enforceResult.headers = {
          ...(enforceResult.headers ?? {}),
          'X-Lantern-Backends-Ineligible': String(ineligibleByHardCap),
        }
      }
      return { enforceResult, capsView, plans: effectivePlans }
    } else {
      capsView = await deps.capabilities.describe(target.provider, target.model)
      enforceResult = deps.capabilities.enforce(capsView, request)
    }
  } catch (error) {
    deps.log?.('error', `[lantern] 能力查询失败，跳过能力闸门：${error?.message}`)
  }
  return { enforceResult, capsView, plans }
}

/**
 * 网关级图片开关（与"模型是否支持图片"是两件事，文案必须区分——§6.5.1 铁律 3）。
 *
 * 判据用 `parsed.images.length`（协议无关），不依赖某一种 content 形状。
 *
 * @param cfg - 当前配置。
 * @param wantsImage - 本次请求是否包含图片。
 * @returns 错误说明，或 undefined（放行）。
 */
function imageGateMessage(cfg, wantsImage) {
  if (!wantsImage || cfg.allowImageInput === true) return undefined
  // 脱敏时只说「现在不行」，不报内部开关名、不指向面板——
  // 调用方没有那个面板，看到 allowImageInput=false 只会困惑。
  if (isHintMasked(cfg)) return '本次请求包含图片，但当前服务不接受图片输入，请改用纯文本'
  return (
    '网关未开启图片输入（allowImageInput=false）。' +
    '这与"该模型不支持图片"是两件事——如需使用图片，请在 设置 → LANtern → 状态与安全 中开启。'
  )
}

/**
 * 处理 `POST /v1/chat/completions`。
 *
 * 关键纪律（设计文档 §6.1、§7.3）：
 * - **客户端断连必须 abort** 上游调用，否则泄漏并白烧额度；
 * - 只做一次独立的 `ctx.llm.stream()`，**不建会话、不进 agent loop**；
 * - 上游错误**脱敏后**原样呈现，不美化、不吞错。
 *
 * @param sctx - 已注入 webServer 的作用域上下文。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param deps - 依赖集合（目录、key 仓库、闸门、配置读取器）。
 */
async function handleChatCompletions(sctx, req, res, deps) {
  const cfg = deps.current()
  const limits = cfg.limits ?? {}

  /**
   * OpenAI 形状的错误出口（统一脱敏）。
   *
   * 这个函数存在的唯一理由是「不给下一次新增文案留漏网的机会」：
   * 上游/闸门的 message 里混着 provider 名、绑定名与「设置 → LANtern」路径，
   * 逐条记得清理迟早会漏一条，所以出口收成一个口子。
   *
   * @param status - HTTP 状态码。
   * @param message - 原始说明（会被 publicMessage 清洗）。
   * @param type - OpenAI 错误类型。
   * @param code - 机器码。
   * @param extra - 附加字段。
   */
  const failJson = (status, message, type, code, extra) => {
    sendJson(res, status, errorBody(publicMessage(message, cfg), type, code, extra))
  }

  // --- 限流：每 Key 每分钟请求数（专属限额可覆盖全局） ---
  const perKeyRpm = deps.record?.limits?.perKeyRpm ?? limits.perKeyRpm ?? 30
  const keyId = deps.record?.id ?? '__anonymous__'
  if (!deps.allowRate(keyId, perKeyRpm)) {
    res.setHeader('Retry-After', '60')
    failJson(429,
      `超出速率上限（每 Key 每分钟 ${perKeyRpm} 次请求）`,
      'rate_limit_error',
      'rate_limit_exceeded')
    return
  }

  // --- 读体（有上限） ---
  const maxBodyBytes = limits.maxBodyBytes ?? 4 * 1024 * 1024
  const read = await readBody(req, maxBodyBytes)
  if (!read.ok) {
    if (read.reason === 'too_large') {
      failJson(413,
        `请求体超过上限（${Math.round(maxBodyBytes / 1024 / 1024)} MB）。` +
          '带图的长会话因每次重发全部历史图片而容易超限，建议开新会话继续。',
        'invalid_request_error',
        'payload_too_large')
      return
    }
    failJson(400, '请求体不是合法 JSON 对象', 'invalid_request_error', 'bad_request')
    return
  }
  const body = read.body

  // --- 缺字段先判 400，别让"没填"变成一个"找不到" ---
  //
  // 三通道统一走 protocol.js 里的校验器（`validateChatRequest` /
  // `validateResponsesRequest`），Anthropic 用自己的 `validateAnthropicRequest`。
  // 分开写三个版本时它们是**不一致**的：chat 缺 model 会掉进 resolveModel 拿 404，
  // 而 messages 根本没人校验——`messages: []` 一路变成空消息列表，上游回
  // `200 { content: null }`，客户端把它当成正常回复。
  const invalid = validateChatRequest(body)
  if (invalid !== undefined) {
    failJson(400, invalid, 'invalid_request_error', 'bad_request', {
      ...(invalid.startsWith('缺少 model') ? { hint: '请在请求体里带上 model（取值见 GET /v1/models）' } : {}),
    })
    return
  }

  // max_tokens 必须先判正负再谈封顶。
  // 实测漏洞：`Math.min(-1, 8192)` 还是 -1，负数会原样流到上游；
  // 上游有的钳掉有的忽略，于是**同一个畸形请求在不同后端上表现不同**
  // （这里返回 200、那里返回 400），排查时会被当成"上游不稳定"。
  // Anthropic 通道早就用 `max_tokens 必须是正数` 挡住了，这里对齐。
  //
  // 另外要挡**非整数**（`8.7`）与**非有限数**（`1e999` 解析成 Infinity）：
  // 两者都会被上游判 `integer required`，但错误落在网关头上。整数是 token
  // 计数的自然单位，小数没有意义——与其替用户四舍五入（暗箱改动），
  // 不如在入口说清楚。
  // OpenAI 新客户端（o 系列起）改用 `max_completion_tokens`，老名字 `max_tokens`
  // 仍被广泛使用。原来这里只认后者，前者既不生效也不进 X-Lantern-Dropped-Params，
  // 于是"设了输出上限却没生效"变成一个**完全静默**的行为——调用方会以为
  // 模型没听话，而不是发现参数名没被识别。两个名字都认，同时在都给了的情况下
  // 以 max_tokens 为准（兼容既有配置）。
  const limitField =
    body.max_tokens !== undefined ? 'max_tokens' : body.max_completion_tokens !== undefined ? 'max_completion_tokens' : undefined
  if (limitField !== undefined) {
    const limitValue = body[limitField]
    if (typeof limitValue !== 'number' || !Number.isSafeInteger(limitValue) || limitValue <= 0) {
      failJson(400, limitField + ' 必须是正整数', 'invalid_request_error', 'bad_request')
      return
    }
    // 归一化到同一个字段，下游只见 max_tokens。
    body.max_tokens = limitValue
  }

  // --- 解析模型 ---
  const target = resolveModel(deps.directory, body.model, cfg)
  // 自定义模型**没有** provider 字段（真实后端在 bindings 里），
  // 所以这里必须把 custom 排除在判定之外，否则用户建好的虚拟名会得到 404。
  if (target.error !== undefined || (target.custom !== true && target.provider === undefined)) {
    // 脱敏时不给 available：那是一份完整拓扑（每条都是 xxx@provider）。
    // 「用 /v1/models 里的名字」这个指引本身已经足够行动。
    const maskedList = isTopologyMasked(cfg)
    sendJson(res, 404, errorBody(
      // 同上：回显原串但过一遍脱敏，否则用户填了 `xxx@trae` 就等于
      // 让错误响应把 provider 名字再复述一遍。
      publicMessage(`模型未找到：${String(body.model ?? '(空)')}`, cfg),
      'invalid_request_error',
      'model_not_found',
      maskedList
        ? { hint: '请使用 /v1/models 返回的模型名' }
        : {
            // customOnly 下 available 只给自定义模型名（不泄露真实模型拓扑），
            // hint 也要跟着换——否则会引导用户去填一个必然 404 的公开名。
            hint: cfg.customOnly === true
              ? '本网关只暴露自定义模型，请在 /v1/models 里挑选可用的模型名'
              : '可填公开名 <model>@<provider>，也可直接填裸模型名（如 deepseek-v4.1-flash）',
            available: cfg.customOnly === true
              ? normalizeCustomModels(cfg.customModels).filter((m) => m.enabled).map((m) => m.name).slice(0, 50)
              : deps.directory.list().map((e) => e.publicName).slice(0, 50),
          },
    ))
    return
  }
  // 硬校验：provider 仍注册着（"删除 Provider 后不能再使用"的保证）
  // 自定义模型没有自己的 provider（真实后端在 bindings 里），跳过这项校验，
  // 改由 buildFailoverPlans 逐个绑定校验。
  if (target.custom !== true && !deps.directory.isProviderLive(target.provider)) {
    // provider 名本身是内部拓扑：脱敏时 publicMessage 会把它替换成中性说法，
    // 未脱敏时管理员照旧能一眼看出是哪个 provider 掉了。
    const maskedProvider = isTopologyMasked(deps.current())
    failJson(404,
      maskedProvider
        ? publicMessage(`模型「${target.publicName ?? String(body.model ?? '')}」当前不可用，请稍后重试`, cfg)
        : `provider「${target.provider}」当前未注册（可能已被移除）`,
      'invalid_request_error',
      'model_not_found',
      maskedProvider
        ? {}
        : { available: deps.directory.list().map((e) => e.publicName).slice(0, 50) })
    return
  }

  // --- 后端计划（自定义模型 → 有序故障转移链；普通模型 → 单元素）---
  // 先按配置展开，再按后端健康记忆**只改顺序**：刚挂过的那几档排到链尾，
  // 免得每个请求都为同一个已知故障再等满一次首包超时（m04349）。
  // 链上的档数一点没少——别人也全挂时它们照样会被试到。
  const { plans: rawPlans, skipped } = buildFailoverPlans(deps.directory, target, deps.current())
  const allPlans = orderByHealth(deps, rawPlans)
  if (allPlans.length === 0) {
    // 一个字都没发出去就失败了 —— 这条最该脱敏：
    // skipped 里每条都写着「模型 X 不在 provider「trae」的模型列表中」，
    // 那是运维视角的排障信息，终端用户既改不了也无从理解。
    const noBackend = publicNoBackendError({ target, skipped, cfg: deps.current() })
    sendJson(res, 503, errorBody(
      noBackend.message,
      'invalid_request_error',
      // code 也是暴露面：`no_available_backend` 在告诉对方"这名字后面挂着
      // 一堆后端"，而终端用户理解的语义只是"这个模型现在不能用"。
      // 管理员侧保留原码——他要靠它区分"配错了"和"上游挂了"。
      isTopologyMasked(deps.current()) ? 'model_unavailable' : 'no_available_backend',
      {
        // 面板指引只对管理员有意义，脱敏时连它一起收回。
        ...(isTopologyMasked(deps.current())
          ? {}
          : { hint: '请在 设置 → LANtern → 自定义模型 中检查绑定项，确保对应 provider 已注册并可用' }),
        ...noBackend.details,
      },
    ))
    return
  }
  // 故障转移必须**如实可见**：脱敏时只发档数（几个上游），不发各自叫什么。
  if (target.custom === true) applyFailoverHeaders(res, allPlans, skipped, deps.current())

  // --- 能力闸门（§6.5.5：硬能力拒绝、软参数标注）---
  // 铁律 3：绝不静默忽略参数然后返回一个看起来正常的回答。
  // 与 Anthropic 通道**共用同一份实现**，避免两条协议分叉（这是刻意的）。
  const wantsImage = Array.isArray(body.messages)
    ? body.messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'))
    : false
  // 闸门会按本次请求要用的硬能力筛链（见 enforceCapabilityGate 的注释），
  // 之后所有转发都用筛过的 plans——否则"判定的能力"与"真去调的档"会不一致。
  //
  // ⚠ tools 的判定不能只看本轮 `body.tools`（第十一轮 #126）。
  //
  // 绝大多数 agent 框架**只在第一轮发 tools**，续轮靠历史里的 tool_calls。
  // 只看 body.tools 会导致续轮被当成"不需要工具的普通请求"，于是链没有被
  // 按 tools 能力筛，可能落到一家不支持结构化 tool-call 的后端上。
  // 那家会把历史里的 tool-call 块渲染成**它自己的模板标记**（实测
  // glm 某档输出 `<｜｜DSML｜｜ calls>`），模型看到后跟着模仿，
  // 结果就是「content 里一坨标记 + tool_calls: [] 空」—— 用户看到的正是
  // "工具完全没生效、变成纯文本模型"。
  //
  // 所以：本轮有 tools **或历史里出现过 tool_calls / role:'tool'**，都算要工具。
  const hasToolHistory = Array.isArray(body.messages) && body.messages.some(
    (m) => (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) || m?.role === 'tool',
  )
  const wantsTools = (Array.isArray(body.tools) && body.tools.length > 0) || hasToolHistory
  const { enforceResult, capsView, plans } = await enforceCapabilityGate(deps, target, {
    hasTools: wantsTools,
    hasImage: wantsImage,
    hasJsonMode: body.response_format !== undefined,
    hasReasoningEffort: body.reasoning_effort !== undefined,
    // 档位**值**也要给闸门：各家的词表不同，只判"有没有 reasoning 能力"
    // 会让 `xhigh` 被发到只认 `high` 的档上，要么报错要么静默降级成默认档。
    reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
    hasTemperature: body.temperature !== undefined,
    hasStop: body.stop !== undefined,
  }, allPlans)
  // 闸门会用「本次请求要的硬能力」筛链，筛完的顺序是它自己算的；健康度重排
  // 必须**在筛之后再走一遍**，否则刚被闸门重建的 plans 会把冷却的档又摆回前面
  // ——等于在带 tools 的请求上，健康记忆完全失效。
  const plansSorted = orderByHealth(deps, plans)
  // 上面那次 applyFailoverHeaders 发生在闸门之前，显示的还不是最终链（筛链会
  // 改变档位）。已经出去的头没法收回，所以这里按最终链再写一遍；同名 setHeader
  // 是覆盖语义，调用方看到的始终是真实会走的顺序。
  if (target.custom === true) applyFailoverHeaders(res, plansSorted, skipped, deps.current())

  // 网关级图片开关（与"模型是否支持图片"是两件事，错误文案必须区分开）
  const imageGate = imageGateMessage(deps.current(), wantsImage)
  if (imageGate !== undefined) {
    failJson(400, imageGate, 'invalid_request_error', 'image_not_allowed')
    return
  }

  if (enforceResult.reject !== undefined) {
    const r = enforceResult.reject
    // 脱敏时换成一句面向调用方的话：原文里的「来源：declared / unknown」和
    // 「到该 provider 页点测试」都是网关内部视角，调用方既看不懂也做不了。
    const capsMasked = isHintMasked(deps.current())
    const capsMessage = !capsMasked
      ? r.message
      : r.value === 'unsupported'
        ? `当前模型不支持${r.label}，请去掉该参数或换一个模型`
        : `暂时无法确认当前模型是否支持${r.label}，为避免返回错误结果已拒绝本次请求`
    failJson(400, capsMessage, 'invalid_request_error', 'capability_unsupported', {
      capability: r.capability,
      capability_value: r.value,
      ...(capsMasked ? {} : { capability_source: r.source, all_unsupported: r.all }),
    })
    return
  }

  // --- reasoning_effort 落地（曾经只判定不下发，是静默失真） ---
  // 必须在闸门放行之后判：档位是否合法依赖 capsView.reasoning.efforts，
  // 而 capsView 正是闸门算出来的那份（自定义模型是全体后端的交集）。
  // --- reasoning_effort 落地：走统一四档契约（第十轮） ---
  // 旧实现是 `resolveReasoningEffort(capsView, body.reasoning_effort)`：拿"全链并集"
  // 校验合法性，然后把原词直接下发。两个问题：
  //   1. 合法不代表能兑现 —— 并在集里，但链上没人声明它；
  //   2. 调用方无法只知道四档，也不知道自己写的词在各家叫什么。
  // 现在改为：客户端只说四档 → 按链上每档的真实词表算出一个公共可达的词。
  // 契约档位也会回写进响应头，降级/退化都写 X-Lantern-Effort-Note。
  const effort = await resolveEffortForChain(deps, plans, body.reasoning_effort, effortOptsOf(target))
  if (effort.error !== undefined) {
    failJson(400, effort.error.message, 'invalid_request_error', 'invalid_reasoning_effort', {
      capability: 'reasoning',
      allowed: effort.error.allowed,
    })
    return
  }
  const reasoning = { value: effort.word }
  // 逐档注解各自的档位词（第十一轮 #121）。
  //
  // `reasoning.value` 是"全链投票选出来的那个词"，只适合**外显**（告诉用户
  // 这次大概是什么强度）。真正发给上游的必须是**每档自己的最强**，
  // 否则 3 档/5 档/8 档混编时会被拉平（实测 glm-5.3 max 被降成 extra_high）。
  // ⚠ 这里必须用 plansSorted（闸门筛过 + 健康度重排后的链），**不能**写
  //    `const plansWithEffort = ... ? plansWithEffort : ...` —— 那是对自己的引用，
  //    会抛 TDZ 的 ReferenceError，表现为整条请求 500 lantern_internal。
  //    （本轮做全局改名时误伤过，真机实测 4 个模型全 500 就是这个。）
  const plansWithEffort = effort.contract === undefined
    ? plansSorted
    : await annotatePlanEfforts(deps, plansSorted, effort.contract)
  // 逐档挂上各自的**输出上限**（第十三轮 #150）：
  // 让"用户要 200K、但链上某档只支持 128K"时自动降到 128K，而不是被拒或截断。
  // 这一步与档位注解独立：即使客户端没传 reasoning_effort（contract 为 undefined），
  // max_tokens 的按档适配也必须生效。
  const plansReady = await annotatePlanMaxOutput(deps, plansWithEffort)
  // 链首那档的实际档位写进**独立头**（第十六轮 #168）
  //
  // 这里原来用 setHeader 覆盖 `X-Lantern-Effort-Served`，把全链投票结果
  // 换成"第一个有词表的绑定"的逐档词。实测 `hy4`：`#1` 只有 `["high"]`、
  // `#3` 有 5 档 → 覆盖成 `high` + `1/1`，而投票明明算出 `low@1/5`。
  // 用户看到四档全落 `high`，其实计算一直是对的，只是被这行覆盖掉了。
  {
    const head = plansWithEffort.find((p) => p.effortWord !== undefined)
    if (head !== undefined && res.headersSent !== true) {
      res.setHeader('X-Lantern-Effort-Head', head.effortWord +
        (head.effortTotal === undefined ? '' : `@${head.effortPosition}/${head.effortTotal}`))
    }
  }

  // --- 熔断闸门（P12）：上游连续限流时暂停 LAN 通道，保护本机 ---
  // 放在并发闸门**之前**：冷却期内连槽都不该占，更不能打向上游。
  const admit = deps.breaker?.admit(deps.record?.id ?? '__anonymous__') ?? { ok: true }
  if (!admit.ok) {
    res.setHeader('Retry-After', String(admit.retryAfterSec ?? 60))
    // 状态码要**匹配语义**，否则客户端会误判：
    //   token 超限 = 限流 → 429（客户端据此退避重试）
    //   熔断中    = 服务暂不可用 → 503
    const status = admit.code === 'circuit_open' ? 503 : 429
    failJson(status, admit.message, 'rate_limit_error', admit.code)
    return
  }

  // --- 并发闸门（§7.3：不与本机抢并发） ---
  const slot = deps.acquireSlot()
  if (slot === undefined) {
    res.setHeader('Retry-After', '5')
    failJson(429,
      `网关并发已满（上限 ${limits.maxConcurrent ?? 2}），请稍后重试`,
      'rate_limit_error',
      'concurrency_limit_exceeded')
    return
  }

  const abort = new AbortController()
  let finished = false
  /** 请求开始时间（记账算耗时）。 */
  const callStarted = Date.now()
  /** 本次请求写入的图片引用（供 finally 释放引用计数，P8）。 */
  let builtRefs = []
  const onClose = () => {
    if (!finished) abort.abort()
  }
  // 断连信号必须挂 **res**，不能挂 req：
  // req 的 'close' 在请求体读完时就已经派发过了（readBody 在上面 await 完），
  // 那时再注册等于挂了个永远不会触发的监听器——客户端断开后上游照跑、
  // token 照烧，而注释里承诺的「客户端断连必须 abort」实际是空实现。
  res.on('close', onClose)
  // 注册之前就可能已经断开（快客户端 / 反向代理超时），补一次状态兜底。
  // 只能看 res：`req.destroyed` 在 body 读完的那一刻就是 true（IncomingMessage
  // 读到 EOF 后会自动 destroy），用它判断「客户端已断开」等于每个请求开局就 abort ——
  // 实测后果是上游一次都没被调用，客户端拿到 200 + content:null + finish_reason:stop，
  // 账本记 status:'ok'、ms 个位数。res 的 destroyed 才代表这次连接真的没了。
  if (res.destroyed) abort.abort()
  /**
   * 请求**总时长**上限（`limits.requestTimeoutMs`，默认 10 分钟）。
   *
   * 之前这个配置项只在 DEFAULT_CONFIG 里存在，**代码从不读它** —— 请求一旦发出
   * 就没有天花板：上游如果肯慢慢吐字（隔几十秒一个 token），连接会一直挂着、
   * 并发槽位被占死，表现是"网关越用越慢，最后并发满"。
   *
   * 它和自定义模型的 `timeoutMs` 是**两个层次**，不能互相替代：
   *   · `target.timeoutMs` 是**单档首包**超时，决定"这家不回话就换下家"；
   *   · 这里管的是**整个请求**（含全部故障转移重试）最多花多久，超了就 504。
   */
  const requestTimeoutMs = Number.isFinite(limits.requestTimeoutMs) && limits.requestTimeoutMs > 0
    ? Math.round(limits.requestTimeoutMs)
    : 600_000
  const totalTimer = setTimeout(() => {
    if (finished) return
    abort.abort()
  }, requestTimeoutMs)
  totalTimer.unref?.()

  try {
    // --- 构造消息（图片需要 attachments 服务） ---
    const parsed = parseChatRequest(body)
    const attachments = sctx.get('attachments')
    let built
    try {
      built = await buildMessages(parsed, attachments, {
        allowImage: cfg.allowImageInput === true,
        // P8：图片经附件账本写入（区分新建/复用，只回收自己新建的）
        ledger: deps.ledger,
        // 该模型是否要把 system 合并进 user 消息（#155）。
        // 有些上游（实测 hy4）见到独立 system role 就返回全空，
        // 这类模型在面板里打开开关即可，不必改客户端。
        mergeSystemIntoUser: target.mergeSystemIntoUser === true,
        toolResultAsText: target.toolResultAsText === true,
      })
    } catch (error) {
      const code = error?.lanternCode ?? 'invalid_request'
      // 附件服务不可用是**服务端**问题（宿主没提供 attachments），
        // 报 400 会让调用方以为是自己请求体有问题、不会重试；503 才对。
        const status = code === 'attachments_unavailable' ? 503 : 400
      sendJson(res, status, errorBody(maskSecrets(error?.message ?? '请求无法处理'), 'invalid_request_error', code))
      return
    }
    builtRefs = built.imageRefs ?? []
    // 消息构建期的降级必须可见（第十轮 #108）。
    // `buildMessages` 一直返回 `{ warnings }`，但三个调用点一个都没接 ——
    // 于是"505 条被砍到 500 条""600KB 单条被截到 512KB""不认识的 role 被忽略"
    // "不支持的图片来源被丢弃" 这些事件**一条都到不了客户端**。
    // 这是本插件铁律"降级永远可见"最隐蔽的反例：模型看到的内容比用户以为的少，
    // 回答自然对不上，而用户会去怪模型。
    applyMessageWarnings(res, built, deps.current())

    // 封顶值 0 / 非有限 = **不封顶**（与 anthropic 通道的 resolveAnthropicMaxTokens 一致）。
    // 曾经这里直接 Math.min(requestedMax, 0)，于是把上限设成 0 的用户会看到
    // 每一次请求的 max_tokens 都变成 0——三条协议给出三种不同语义是纯粹的坑。
    const rawCap = limits.maxTokensCap
    const maxTokensCap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined
    const requestedMax = typeof body.max_tokens === 'number' ? body.max_tokens : undefined
    const maxTokens = requestedMax === undefined
      ? undefined
      : maxTokensCap === undefined ? requestedMax : Math.min(requestedMax, maxTokensCap)

    // stop 序列：截断到上游普遍接受的条数，丢掉的如实报告（见 call-contract.js）
    const stopClip = clipStopSequences(body.stop)
    if (stopClip.dropped.length > 0) {
      // 与 ignored / dropped 两套头分开：这不是“模型不支持”，也不是“网关没通道”，
      // 而是“值太多/太长上游收不下”。单独一个头，避免排障时归错因。
      res.setHeader('X-Lantern-Stop-Truncated', String(stopClip.dropped.length))
    }

    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: built.messages,
      // 工具定义：历史重建 + 本轮声明合并（见 mergeToolSchemas 的说明，#117）
      ...toolsOptionOf(built, parsed),
      // 被判定为"不支持/未知"的软参数：**不传**（并在上面的响应头里标注已忽略）
      ...(typeof body.temperature === 'number' && !enforceResult.ignored.includes('temperature')
        ? { temperature: clampScalar('temperature', body.temperature).value ?? body.temperature }
        : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      // stop 只能截断不能“钳”：多数上游只收 4 条。多出的部分必须可被调用方知道，
      // 否则他以为 6 条都在生效，实际只有前 4 条——又一种静默失真。
      ...(stopClip.value !== undefined && !enforceResult.ignored.includes('stop') ? { stop: stopClip.value } : {}),
      // 推理档位：闸门放行 + 档位合法才下发（resolveReasoningEffort 已判过）
      ...(reasoning.value === undefined ? {} : { reasoningEffort: reasoning.value }),
      signal: abort.signal,
    }

    // **结构诊断头**（第十三轮 #143）：`tools` 出现"模型说工具返回空结果"这类现象时，
    // 光看响应分不清是"网关没把 tool 消息传给上游"还是"上游没读它"。
    // 这里把实际下发的 message 角色序列 + 工具消息条数如实暴露出来，
    // 让人一眼判断问题在哪一侧。只回角色名与计数，**不含任何正文内容**。
    if (!res.headersSent) {
      try {
        const roles = (built.messages ?? []).map((m) => m?.role ?? '?')
        res.setHeader('X-Lantern-Message-Roles', roles.join(','))
        const toolMsgCount = roles.filter((r) => r === 'tool').length
        if (toolMsgCount > 0) res.setHeader('X-Lantern-Tool-Messages', String(toolMsgCount))
        const toolsSent = Array.isArray(options.tools) ? options.tools.length : 0
        if (toolsSent > 0) res.setHeader('X-Lantern-Tools-Sent', String(toolsSent))
      } catch {
        /* 诊断头失败不影响主流程 */
      }
    }
    const completionId = newCompletionId()
    const isStream = body.stream === true

    // 软参数被忽略时**必须显式标注**（§6.5.5：降级永远可见，不可静默）
    for (const [name, valueOf] of Object.entries(enforceResult.headers ?? {})) {
      res.setHeader(name, valueOf)
    }
    // 推理档位的契约外显（契约档 / 实发词 / 偏差说明）
    for (const [name, valueOf] of Object.entries(effort.headers ?? {})) {
      res.setHeader(name, valueOf)
    }
    // ── 链首逐档值：放**独立头**，不再覆盖投票值（第十六轮 #168）──
    //
    // 历史 bug（实测浪费了六轮排查）：这里原本用 `setHeader` 把投票出来的
    // `X-Lantern-Effort-Served` **覆盖**成链首那档的逐档词：
    //
    //     const head = plansWithEffort.find((p) => p.effortWord !== undefined)
    //     res.setHeader('X-Lantern-Effort-Served', head.effortWord)
    //
    // 假设是"链首那档会先接住请求，所以报告它的档位更贴近实际"。
    // 这个假设在两个地方都不成立：
    //
    //   1. **实际服务的档不一定在链首** —— 故障转移会切档，
    //      而流式响应头在发送前就写死了，根本不知道最后落到谁；
    //   2. **`find()` 取的是"第一个有词表的"**，不是"第一个能兑现的"。
    //      实测 `hy4`：`#1` 只有 `["high"]`、`#3` 有 5 档，
    //      `find()` 拿到 `#1` → `Served` 被覆盖成 `high`、`Position` 变 `1/1`，
    //      **而投票明明算出 `low@1/5`**。四档看起来全落 `high`，
    //      其实计算全对，只是被这行覆盖掉了。
    //
    // 现在：投票值保留在 `X-Lantern-Effort-Served`（它是全链协商的可兑现档），
    //       链首逐档值改叫 `X-Lantern-Effort-Head`，两者语义分开、都可见。
    {
      const head = plansWithEffort.find((p) => p.effortWord !== undefined)
      if (head !== undefined) {
        res.setHeader('X-Lantern-Effort-Head', head.effortWord +
          (head.effortTotal === undefined ? '' : `@${head.effortPosition}/${head.effortTotal}`))
      }
    }
    // 网关根本没有通道的参数（top_p / seed / n …）：与"模型不支持"是两件事，
    // 必须用**另一个头**分开报告，否则排障方向会完全反掉（换模型也没用）。
    const droppedParams = describeDroppedParams(body)
    if (droppedParams.length > 0) {
      res.setHeader('X-Lantern-Dropped-Params', droppedParams.join(','))
    }
    // `tool_choice` 的特殊说明（第十一轮 #120）：
    // 它仍在 Dropped-Params 里（因为确实没有协议级通道），但**已经被 system 指令
    // 近似实现了**。不标这一句，客户端看到 dropped 会以为完全没生效，
    // 于是自己去做多余的重试 —— 那反而更糟。
    if (body.tool_choice !== undefined) {
      res.setHeader('X-Lantern-Tool-Choice', 'soft')
    }

    if (isStream) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      // ⚠ 故障转移头必须在 flushHeaders **之前**写（第十二轮 #141）。
      //
      // 上一轮（#136）我把 applyServedHeaders 提到了"第一次 res.write 之前"，
      // 但这里还有一行 `res.flushHeaders?.()` 更早 —— 它直接把头发出去了。
      // 于是 applyServedHeaders 里的 `if (res.headersSent) return` 立刻命中，
      // 两个头**一个都没写**。实测流式响应 X-Lantern-Served / Attempts 都是 null。
      //
      // 正确位置：紧跟 header 设置、在 flushHeaders 之前。
      // 此时 fo.plan 还是链首（尚未尝试），语义是"打算先用这一档"；
      // 实际切档后无法再改头（HTTP 限制），这一点如实体现在设计里。
      {
        const fo0 = { plan: plansReady[0], attempts: [] }
        try { applyServedHeaders(res, fo0, plansReady, deps.current()) } catch { /* 头已发则跳过 */ }
      }
      res.flushHeaders?.()
      // ── 关掉 TCP Nagle（第十六轮 #165）──
      //
      // 实测：短回答（< ~12KB）走网关时被攒成 **1 个 chunk** 一次性到达，
      // 客户端看到的是"转圈十几秒 → 突然全文出现"，完全没有打字机效果。
      // 而长回答（>100KB）反而正常流式（10 个 chunk、跨度 12 秒）。
      //
      // 这是 Nagle 算法的典型症状：小段数据先压在发送缓冲里，等 ACK
      // 或攒够一个 MSS 才发。SSE 每帧只有几十到几百字节，
      // 正好落在这个区间 —— 于是"越短的回答越不像流式"。
      //
      // `setNoDelay(true)` 让每个 write 立刻成包。
      try { res.socket?.setNoDelay?.(true) } catch { /* 连接已断则忽略 */ }
      // 心跳：防中间设备掐连接
      // 心跳（第十六轮 #171 / #175）
      //
      // 两级：
      //   · 还没出过任何内容 → 发**合法空 content 帧**（translator.keepalive()），
      //     客户端会据此刷新"正在输入"，而不是当注释丢掉；
      //   · 已经在输出     → 发 `: ping` 注释，避免打断打字机动画。
      //
      // 为什么必须有：实测 `Seed-2.1-Pro` 在 `trae` 上游会先空白 **116 秒**，
      // 再在 43ms 内吐完全部 2,890 字。那段空白里若只有注释帧，界面完全静止。
      let streamTranslatorForBeat
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        try {
          if (streamTranslatorForBeat !== undefined) {
            const ka = streamTranslatorForBeat.keepalive()
            if (Array.isArray(ka) && ka.length > 0) {
              for (const f of ka) writeFrame(res, f)
              return
            }
          }
        } catch { /* 保活失败不影响主流程 */ }
        res.write(': ping\n\n')
      }, 5_000)
      heartbeat.unref?.()

      const translator = new OpenAiStreamTranslator({
        id: completionId,
        model: target.publicName,
        // 流式帧改不了 HTTP 状态码，所以脱敏要在这里再做一遍——
        // 否则"非流式藏好了、流式把上游原文吐出来"就成了一条静默泄露路径。
        sanitize: (failure) => publicFailurePatch(failure, deps.current()),
      })
      streamTranslatorForBeat = translator
      let streamFailure
      // 记账要的是 **DSH 原口径**（inputTokens/cacheReadTokens…），
      // 而 protocol 层保存的是已转换的 OpenAI 口径（prompt_tokens…），
      // 所以这里直接捕获原始 usage chunk，不依赖协议层内部字段。
      let rawUsage
      // 故障转移：普通模型是单元素链，语义与改造前**完全一致**；
      // 自定义模型按绑定顺序逐级尝试，只在"尚未向客户端写出任何字节"时才切换。
      // tune 只对自定义模型生效（tuneOf 对普通模型返回 0/0）：
      // 普通模型套首包超时会把「慢但正常」的回答砍断，那是回归不是功能。
      const fo = { plan: plansReady[0], attempts: [] }
      // ⚠ 故障转移头必须在**第一次 res.write 之前**写（第十二轮 #136）。
      //
      // `res.write()` 会隐式 flush 响应头。原来 `applyServedHeaders` 放在
      // `res.end()` 之后（第 4763 行），那时头早已发出，`setHeader` 抛
      // ERR_HTTP_HEADERS_SENT，而那个异常被吞掉 —— 于是流式响应**从来没有**
      // X-Lantern-Served / X-Lantern-Attempts，客户端无法知道实际用了哪一档。
      // 实测（远端）：流式响应里这两个头都是 null。
      //
      // 现在提前写：此时 fo.plan 是链首（还没试过），语义是"将要先用这一档"。
      // 真正切换后 fo.plan 会变，但那已经无法再改头了 —— 所以另外在
      // 出现切换时用 `X-Lantern-Served-Switched` 帧内注释告知（见下）。
      try {
        applyServedHeaders(res, fo, plansReady, deps.current())
      } catch {
        // 万一头已发（例如上游极快、translator 抢跑），不阻断主流程
      }
      try {
        for await (const chunk of streamWithFailover(sctx, deps, plansReady, options, fo, tuneOf(target))) {
          if (abort.signal.aborted) break
          if (chunk.type === 'usage') rawUsage = chunk.usage
          for (const frame of translator.push(chunk)) writeFrame(res, frame)
        }
        if (rawUsage === undefined) rawUsage = fo.usage
        if (fo.failure !== undefined && fo.plan === undefined) {
          streamFailure = fo.failure
        }
        // 续写次数**不能**用 res.setHeader 通告：上面已经 flushHeaders()，
        // 头一旦发出再 setHeader 必抛 ERR_HTTP_HEADERS_SENT，而这个异常会被
        // 下面的 catch 记成「上游失败」——一次**成功**的断点续写反而把该后端
        // 记进负能力学习，并让客户端在完整正文之后收到一个 error 帧。
        // 改用 SSE 注释帧（规范要求解析器忽略以 ':' 开头的行），信息照样
        // 可观测，协议不受影响。
        if (fo.resumed !== undefined && fo.resumed > 0 && !res.writableEnded) {
          res.write(': lantern-resume=' + String(fo.resumed) + '\n\n')
        }
      } catch (error) {
        deps.log?.('error', `[lantern] 流式转发异常：${error?.message}`)
        streamFailure = { message: error?.message, code: error?.code }
      } finally {
        clearInterval(heartbeat)
        if (streamFailure === undefined && translator.error !== undefined) {
          streamFailure = translator.error.error ?? {}
        }
        // 兜住"错误不是以 finish chunk 形式到达"的情形（如 for await 抛出）：
        // 必须显式标记，否则 end() 会走正常收尾，客户端只看到
        // "200 + finish_reason:stop + 空内容"，即把上游故障伪装成正常空回答。
        if (streamFailure !== undefined && translator.error === undefined) {
          translator.markFailed(streamFailure)
        }
        for (const frame of translator.end()) writeFrame(res, frame)
        if (!res.writableEnded) res.end()
      }
      // 记账/负能力学习要记到**最终真正生效的后端**（state.plan），
      // 不能记到虚拟名上——否则会把故障转移到的主模型的画像污染掉。
      const used = fo.plan ?? plansReady[0]
      // 本次“到底用了哪一档” —— 链上档数不等于实际用的那一档，
      // 链上某档挂了、静默切到另一档时，调用方需要这个头才知道。
      //
      // 流式路径上这行是**尽力而为**：头通常在首帧就已发出（见上面的提前写入），
      // 所以这里多数情况下会抛 ERR_HTTP_HEADERS_SENT —— 必须吞掉，
      // 否则一次成功的流式请求会被下面的 catch 记成"上游失败"，
      // 反而把健康的后端写进负能力学习。真正的切换信息靠结束帧后的注释。
      try {
        applyServedHeaders(res, fo, plansReady, deps.current())
      } catch {
        // 头已发出：切换信息已在提前写入时告知链首，无法再更新，接受这个限制
      }
      // 流式路径的失败同样参与负能力学习（流已开始，无法再改状态码）
      if (streamFailure !== undefined) await learnFromFailure(deps, used, streamFailure)
      await recordCall(deps, used, {
        usage: rawUsage,
        status: streamFailure === undefined ? 'ok' : 'error',
        ...(streamFailure === undefined ? {} : { errorCode: streamFailure.code ?? 'upstream_error', errorStatus: streamFailure.status, errorMessage: streamFailure.message }),
        ms: Date.now() - callStarted,
        protocol: 'openai',
        imageCount: builtRefs.length,
      })
      return
    }

    // 非流式（故障转移：整段回答在聚合完成后才发出，天然安全）
    const fo2 = { plan: plansReady[0], attempts: [] }
    const aggregator = await collectWithFailover(
      sctx,
      deps,
      plansReady,
      options,
      fo2,
      // 响应 model 必须回显**请求里的名字**（自定义模型就是虚拟名），
      // 真实后端由 X-Lantern-Failover-Chain 头与 x-lantern 字段如实披露。
      (plan) => new OpenAiAggregator({ id: completionId, model: target.publicName }),
      tuneOf(target),
    )
    const aggUsage = fo2.usage
    const used2 = fo2.plan ?? plansReady[0]
    if (fo2.plan === undefined) {
      // 所有后端都失败：如实报最后一次的失败原因（不伪装成正常空回答）
      const failure = fo2.failure ?? { message: '上游调用失败' }
      await learnFromFailure(deps, used2, failure)
      await recordCall(deps, used2, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'openai',
        errorCode: failure.code ?? 'upstream_error', errorStatus: failure.status, errorMessage: failure.message,
      })
      // 502 同样分两种看法：管理员要完整的 attempts（含每个后端名），
      // 终端用户只该看到「第几个上游、成没成、花了多久」。
      const masked = maskedFailureBody({
        target,
        failure,
        attempts: fo2.attempts,
        cfg: deps.current(),
        custom: target.custom === true,
      })
      // failure.code 是**上游**的错误码（RATE_LIMIT / NO_IMAGE_MODEL / quota …）：
      // 对管理员它是排障主线，对终端客户它就是"你背后是哪个平台"的指纹。
      // 所以对外一律归一成 upstream_error，原文只进本机日志与 usage 记录。
      failJson(
        502,
        masked.message,
        'upstream_error',
        isTopologyMasked(deps.current()) ? 'upstream_error' : (failure.code ?? 'upstream_error'),
        masked.details,
      )
      return
    }
    // 本次“到底用了哪一档”：必须在 sendJson 之前写（sendJson 一旦 flush，
    // setHeader 会抛 ERR_HTTP_HEADERS_SENT）。这是成功路径上唯一能看到
    // “用了链上第几档”的地方——`Failover-Chain` 只报链长。
    applyServedHeaders(res, fo2, plansReady, deps.current())
    // 后端把工具调用吐成了它自己的文本标记（#125）：如实标出来。
    // 不说的话，客户端会拿到「content 里一坨标记 + tool_calls 空」，
    // 以为模型在胡说八道 —— 而真正的原因是这家后端不支持结构化工具调用。
    {
      const leaked = typeof aggregator.leakedToolMarkup === 'function' ? aggregator.leakedToolMarkup() : undefined
      if (leaked !== undefined && !res.headersSent) {
        res.setHeader('X-Lantern-Tool-Markup-Leaked', encodeURIComponent(leaked.slice(0, 40)))
      }
    }
    // end() 只能调一次（它会改动内部状态），先取出来复用。
    const finalBody = aggregator.end()
    // 带图片的请求返回彻底空 → 把这一档的 image 记为不支持（#159）。
    // 时序必须在 sendJson 之前，否则头已发、学习结果赶不上下一次闸门判定。
    // ⚠ 判据在 learnImageUnsupported 内部：只有「一次干净尝试、无超时无限流」
    //   的彻底空才算证据（第十五轮收紧，避免像 hy4 那样把偶发超时误记成不支持）。
    if (builtRefs.length > 0 && finalBody?.choices?.[0]?.finish_reason === 'empty_completion') {
      await learnImageUnsupported(deps, used2, { code: 'empty_completion' }, true, fo2.attempts)
    }

    // ── #188：耗尽全部尝试仍空产出 → 必须报错，不能 200 ──
    //
    // 实测 `GPT-6.1-Sol`：上游彻底不可用时，网关返回
    //   HTTP 200 + { content: null, finish_reason: "empty_completion" }
    // 这有两个问题：
    //   1. `empty_completion` **不是 OpenAI 的 finish_reason 合法值**
    //      （合法只有 stop / length / tool_calls / content_filter / function_call / null）。
    //      严格的客户端遇到未知值可能崩溃，宽松的客户端会当成"模型没话说"。
    //   2. 返回 200 等于告诉客户端"成功"，而实际上一个字都没拿到 ——
    //      违反本插件铁律「空产出 ≠ 成功」（见 §10 开头的七条）。
    //
    // 正确行为：报告一个**真实的服务端错误**，让客户端能重试/换模型/提示用户。
    // 用 503（Service Unavailable）而不是 500：这是上游暂时不可用，不是我们崩了。
    const finishReason0 = finalBody?.choices?.[0]?.finish_reason
    const textLen0 = (finalBody?.choices?.[0]?.message?.content ?? '').length
    const hasToolCalls0 = (finalBody?.choices?.[0]?.message?.tool_calls ?? []).length > 0
    // #218：与 anthropic / responses 两个通道同一判据。
    // 只认 `empty_completion` 会漏掉上游的 refusal / failed / content_filter 等
    // "明确拒绝"的收尾原因 —— 那些同样是"0 字回答"，不能当 200 交付。
    const isEmptyLike0 = finishReason0 !== undefined && finishReason0 !== 'stop'
      && textLen0 === 0 && !hasToolCalls0
    if (isEmptyLike0) {
      // ⚠ 这里必须用 `deps.current()`，不能写 `current` ——
      // handleChatCompletions 的作用域里没有 `current` 这个名字。
      // 上一版写成 `cfg: current` 直接抛 ReferenceError，
      // 被外层 catch 包成 500 + 空响应体，比原来的 #188 还糟。
      // 教训：新增代码里的每个标识符，都要确认它在本作用域可见。
      const allFailed = publicAllFailedError({ target: used2, attempts: fo2.attempts, cfg: deps.current() })
      // 明说"空产出"而不是笼统的"调用失败"—— 便于排障
      sendJson(res, 503, {
        error: {
          message: allFailed.message + '（上游返回了空内容：0 字、无工具调用）',
          type: 'server_error',
          code: 'upstream_empty_completion',
          ...(allFailed.details === undefined ? {} : { details: allFailed.details }),
        },
      })
      await recordCall(deps, used2, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'openai',
        imageCount: builtRefs.length,
      })
      return
    }

    sendJson(res, 200, finalBody)
    await recordCall(deps, used2, {
      usage: aggUsage,
      status: 'ok',
      ms: Date.now() - callStarted,
      protocol: 'openai',
      imageCount: builtRefs.length,
    })
  } finally {
    finished = true
    clearTimeout(totalTimer)
    res.off?.('close', onClose)
    deps.releaseSlot(slot)
    // P8：请求结束 → 引用计数递减；归零后由账本按延迟窗口回收。
    if (deps.ledger !== undefined && builtRefs.length > 0) {
      await deps.ledger.release(builtRefs).catch((error) => {
        deps.log?.('error', `[lantern][attachment] release 失败：${error?.message}`)
      })
    }
  }
}

/**
 * 处理 `POST /v1/messages`（Anthropic 兼容，P11 / §6.2）。
 *
 * 与 OpenAI 通道**共用**：限流、读体、模型解析、能力闸门、图片闸门、
 * 并发闸门、附件账本、用量记账、负能力学习。
 * 本函数只负责协议差异：请求解析、响应翻译、错误体形状。
 *
 * 错误体形状必须**符合 Anthropic 规范**（`{type:'error', error:{type,message}}`），
 * 否则官方 SDK 无法解析错误、只会抛一个笼统的异常。
 *
 * @param sctx - 已注入 webServer 的作用域上下文。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param deps - 依赖集合。
 */
async function handleAnthropicMessages(sctx, req, res, deps) {
  const cfg = deps.current()
  const limits = cfg.limits ?? {}

  /**
   * Anthropic 形状的错误响应。
   *
   * 所有 Anthropic 出口都走这里，所以脱敏也收在这一处：
   * maskSecrets 处理密钥泄漏，publicMessage 处理内部拓扑与面板路径。
   */
  const fail = (status, message, type = 'invalid_request_error') => {
    sendJson(res, status, anthropicError(publicMessage(maskSecrets(message), cfg), type))
  }

  // --- 限流（与 OpenAI 通道同一套计数） ---
  const perKeyRpm = deps.record?.limits?.perKeyRpm ?? limits.perKeyRpm ?? 30
  const keyId = deps.record?.id ?? '__anonymous__'
  if (!deps.allowRate(keyId, perKeyRpm)) {
    res.setHeader('Retry-After', '60')
    fail(429, `超出速率上限（每 Key 每分钟 ${perKeyRpm} 次请求）`, 'rate_limit_error')
    return
  }

  // --- 读体 ---
  const maxBodyBytes = limits.maxBodyBytes ?? 4 * 1024 * 1024
  const read = await readBody(req, maxBodyBytes)
  if (!read.ok) {
    if (read.reason === 'too_large') {
      fail(413, `请求体超过上限（${Math.round(maxBodyBytes / 1024 / 1024)} MB）。带图的长会话易超限，建议开新会话。`)
      return
    }
    fail(400, '请求体不是合法 JSON 对象')
    return
  }
  const body = read.body

  const invalid = validateAnthropicRequest(body)
  if (invalid !== undefined) {
    fail(400, invalid)
    return
  }

  // --- 解析模型（全名制，与 OpenAI 通道同语义） ---
  const target = resolveModel(deps.directory, body.model, cfg)
  // 同 OpenAI 通道：自定义模型无 provider 字段，不能被"未注册 provider"误伤。
  if (target.error !== undefined || (target.custom !== true && target.provider === undefined)) {
    fail(
      404,
      // 脱敏时统一成一句：暴露名（<model>@<provider>）与「只暴露自定义模型」
      // 都是网关配置信息，调用方只需要知道「这个名字不能用」。
      isTopologyMasked(cfg)
        ? `模型未找到：${String(body.model ?? '(空)')}。请使用 /v1/models 返回的模型名。`
        : cfg.customOnly === true
          ? `模型未找到：${String(body.model ?? '(空)')}。本网关只暴露自定义模型，请先查 /v1/models 选择一个。`
          : `模型未找到：${String(body.model ?? '(空)')}。可填公开名 <model>@<provider>，也可直接填裸模型名。`,
    )
    return
  }
  if (target.custom !== true && !deps.directory.isProviderLive(target.provider)) {
    // 与 OpenAI 通道同一判据：provider 名是内部拓扑，脱敏时只报模型名。
    const maskedProvider = isTopologyMasked(cfg)
    fail(
      404,
      maskedProvider
        ? `模型「${target.publicName ?? String(body.model ?? '')}」当前不可用，请稍后重试`
        : `provider「${target.provider}」当前未注册（可能已被移除）`,
    )
    return
  }

  // --- 后端计划（与 OpenAI 通道同一份实现）---
  // 同样先展开、再按健康记忆重排（只改顺序，不删档）。
  const { plans: rawPlans, skipped } = buildFailoverPlans(deps.directory, target, deps.current())
  const allPlans = orderByHealth(deps, rawPlans)
  if (allPlans.length === 0) {
    const noBackend = publicNoBackendError({ target, skipped, cfg: deps.current() })
    fail(503, noBackend.message, 'overloaded_error')
    return
  }
  // 与 OpenAI 通道共用同一份头逻辑，避免两条协议在脱敏上分叉。
  if (target.custom === true) applyFailoverHeaders(res, allPlans, skipped, deps.current())

  // --- 解析请求（Anthropic 形状 → 内部同构产物） ---
  const parsed = parseAnthropicRequest(body)
  const wantsImage = parsed.images.length > 0

  // --- 能力闸门（与 OpenAI 通道同一份实现） ---
  const { enforceResult, capsView, plans } = await enforceCapabilityGate(deps, target, {
    // 历史里有工具调用也算"要工具"（第十一轮 #126）：
    // agent 框架续轮常常不再发 tools，只看 toolSchemas 会让链不被按 tools 筛，
    // 落到不支持结构化 tool-call 的后端上 → 它把历史 tool-call 渲染成自己的文本标记 → 模型模仿。
    hasTools: (Array.isArray(parsed.toolSchemas) && parsed.toolSchemas.length > 0)
      || (Array.isArray(parsed.turns) && parsed.turns.some((t) => (Array.isArray(t?.toolCalls) && t.toolCalls.length > 0) || t?.role === 'tool')),
    hasImage: wantsImage,
    // Anthropic 没有 response_format；但其 tools 是硬能力，已在上一行覆盖。
    hasJsonMode: false,
    hasReasoningEffort: body.thinking !== undefined,
    // Anthropic 的 `thinking` 只有开/关 + 预算，没有档位词：
    // `disabled` 明确要求「关掉推理」，只有声明了 `off` 档的后端做得到，
    // 其余档收到它只能静默按默认档跑（用户以为关了，实际还在思考）——
    // 所以这里把 `off` 当档位值参与筛链。
    // `enabled` 不加约束：具体选哪一档由各后端自己的 defaultEffort/最高档决定。
    reasoningEffort: body.thinking !== null && typeof body.thinking === 'object' && body.thinking.type === 'disabled'
      ? 'off'
      : undefined,
    hasTemperature: body.temperature !== undefined,
    hasStop: Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0,
  }, allPlans)
  // 同 chat：闸门筛完再重排，否则冷却在后端被筛链时丢失。
  const plansWithEffort = orderByHealth(deps, plans)
  // 上面那次 applyFailoverHeaders 发生在闸门之前，显示的还不是最终链（筛链会
  // 改变档位）。已经出去的头没法收回，所以这里按最终链再写一遍；同名 setHeader
  // 是覆盖语义，调用方看到的始终是真实会走的顺序。
  if (target.custom === true) applyFailoverHeaders(res, plansWithEffort, skipped, deps.current())

  const imageGate = imageGateMessage(cfg, wantsImage)
  if (imageGate !== undefined) {
    fail(400, imageGate)
    return
  }
  if (enforceResult.reject !== undefined) {
    const r = enforceResult.reject
    // 与 OpenAI 通道同一套脱敏：能力来源、provider 名、面板指引都不该给调用方看。
    const capsMasked = isHintMasked(cfg)
    const capsMessage = !capsMasked
      ? r.message
      : r.value === 'unsupported'
        ? `当前模型不支持${r.label}，请去掉该参数或换一个模型`
        : `暂时无法确认当前模型是否支持${r.label}，为避免返回错误结果已拒绝本次请求`
    // Anthropic 客户端看 message；细节放 error.details，便于排障又不破坏规范
    sendJson(res, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: capsMessage,
        details: {
          capability: r.capability,
          capability_value: r.value,
          ...(capsMasked ? {} : { capability_source: r.source, all_unsupported: r.all }),
        },
      },
    })
    return
  }

  // --- thinking → 推理档位（Anthropic 用预算 token，DSH 用档位 id，二者不等价） ---
  // 映射不上的一律记进 dropped 并写响应头：说"我按你的 budget_tokens 调了"就是撒谎。
  // 映射失败**不拒绝**：thinking 是软诉求（客户端常常默认带上），拒绝会让
  // Claude Code / Cursor 这类客户端整条请求失败。改为如实写 dropped 头。
  //
  // ⚠ 第十轮：改为走统一四档契约。旧实现直接拿 `capsView.reasoning.efforts`（全链并集）
  // 取 defaultEffort 或末档，然后把那个词发给**每一个**后端——一旦链上有不认识它的档，
  // 就是静默降级。现在先按 thinking 语义定出契约档，再交给 resolveEffortForChain 逐档映射。
  const thinkingMap = resolveAnthropicThinking(capsView, body.thinking)
  // 把 thinking 的意图转成契约档：
  //   disabled → 用 thinkingMap.value（现在按 rank===0 找到的是 `none`/`off` 这类真关闭档；
  //              找不到就说明这模型关不掉，此时**不下发**，尊重 note 的说法）
  //   enabled  → thinkingMap.value（已按最强档解出）
  //   未传     → 不干预（undefined）
  //
  // ⚠ 第十轮 #110：这里原来在 disabled 时**硬编码 `'minimal'`**，绕过了
  // thinkingMap 的判断。后果是同一个响应里三句话互相矛盾：
  // Thinking-Note 说"没有可关闭的档位、未能生效"，Effort-Served 却报了个真实档位，
  // 而响应体里确实带着 thinking 块 —— 用户要关思考，实际还在思考、还在烧 token。
  // 现在两条路径共用同一个 value，自洽了。
  const thinkingContract = body.thinking === undefined || body.thinking === null
    ? undefined
    : typeof body.thinking === 'object' && (body.thinking.type === 'disabled' || body.thinking.type === 'enabled')
      ? thinkingMap.value
      : undefined
  const effort = thinkingContract === undefined
    ? { word: undefined, headers: {} }
    : await resolveEffortForChain(deps, plans, thinkingContract, effortOptsOf(target))
  // thinking 映射到契约档后，具体下发哪个真实词由链的对照表决定。
  const effortWord = thinkingContract === undefined ? undefined : effort.word
  // 逐档注解（第十一轮 #121）：anthropic 通道同样必须让每个后端拿到自己的档，
  // 否则 3/5/8 档混编时 `thinking` 的意图会被"全链投票"拉平。
  const anthPlans = effort.contract === undefined
    ? plansWithEffort
    : await annotatePlanEfforts(deps, plansWithEffort, effort.contract)
  // 逐档挂输出上限（#150）：与 chat 通道一致，
  // 否则 anthropic 通道的 max_tokens 仍会被发给撑不住它的绑定。
  const anthReady = await annotatePlanMaxOutput(deps, anthPlans)
  // 该模型关不掉思考时，thinking 必须进 dropped（不能一边说没做到一边照发）。
  if (body.thinking?.type === 'disabled' && effortWord === undefined
      && !thinkingMap.dropped.includes('thinking')) {
    thinkingMap.dropped.push('thinking')
  }

  // --- 熔断闸门（P12）：与 OpenAI 通道同一份实现，避免两条通道保护强度不一致 ---
  const admit = deps.breaker?.admit(deps.record?.id ?? '__anonymous__') ?? { ok: true }
  if (!admit.ok) {
    res.setHeader('Retry-After', String(admit.retryAfterSec ?? 60))
    // 与 OpenAI 通道同一判据：token 超限 → 429；熔断中 → 503
    const status = admit.code === 'circuit_open' ? 503 : 429
    fail(status, admit.message, admit.code === 'circuit_open' ? 'overloaded_error' : 'rate_limit_error')
    return
  }

  // --- 并发闸门 ---
  const slot = deps.acquireSlot()
  if (slot === undefined) {
    res.setHeader('Retry-After', '5')
    fail(429, `网关并发已满（上限 ${limits.maxConcurrent ?? 2}），请稍后重试`, 'rate_limit_error')
    return
  }

  const abort = new AbortController()
  let finished = false
  const callStarted = Date.now()
  let builtRefs = []
  const onClose = () => {
    if (!finished) abort.abort()
  }
  // 断连信号必须挂 **res**，不能挂 req：
  // req 的 'close' 在请求体读完时就已经派发过了（readBody 在上面 await 完），
  // 那时再注册等于挂了个永远不会触发的监听器——客户端断开后上游照跑、
  // token 照烧，而注释里承诺的「客户端断连必须 abort」实际是空实现。
  res.on('close', onClose)
  // 注册之前就可能已经断开（快客户端 / 反向代理超时），补一次状态兜底。
  // 只能看 res：`req.destroyed` 在 body 读完的那一刻就是 true（IncomingMessage
  // 读到 EOF 后会自动 destroy），用它判断「客户端已断开」等于每个请求开局就 abort ——
  // 实测后果是上游一次都没被调用，客户端拿到 200 + content:null + finish_reason:stop，
  // 账本记 status:'ok'、ms 个位数。res 的 destroyed 才代表这次连接真的没了。
  if (res.destroyed) abort.abort()
  /**
   * 请求**总时长**上限（`limits.requestTimeoutMs`，默认 10 分钟）。
   *
   * 之前这个配置项只在 DEFAULT_CONFIG 里存在，**代码从不读它** —— 请求一旦发出
   * 就没有天花板：上游如果肯慢慢吐字（隔几十秒一个 token），连接会一直挂着、
   * 并发槽位被占死，表现是"网关越用越慢，最后并发满"。
   *
   * 它和自定义模型的 `timeoutMs` 是**两个层次**，不能互相替代：
   *   · `target.timeoutMs` 是**单档首包**超时，决定"这家不回话就换下家"；
   *   · 这里管的是**整个请求**（含全部故障转移重试）最多花多久，超了就 504。
   */
  const requestTimeoutMs = Number.isFinite(limits.requestTimeoutMs) && limits.requestTimeoutMs > 0
    ? Math.round(limits.requestTimeoutMs)
    : 600_000
  const totalTimer = setTimeout(() => {
    if (finished) return
    abort.abort()
  }, requestTimeoutMs)
  totalTimer.unref?.()

  try {
    // --- 构造消息（图片走附件账本，P8） ---
    const attachments = sctx.get('attachments')
    let built
    try {
      built = await buildMessages(parsed, attachments, {
        allowImage: cfg.allowImageInput === true,
        ledger: deps.ledger,
        // 该模型把 system 合并进 user 消息（#155；有些上游见到独立 system role 就返回全空）
        mergeSystemIntoUser: target.mergeSystemIntoUser === true,
        toolResultAsText: target.toolResultAsText === true,
      })
    } catch (error) {
      const code = error?.lanternCode ?? 'invalid_request'
      fail(400, error?.message ?? '请求无法处理')
      deps.log?.('error', `[lantern][anthropic] 构造消息失败（${code}）：${error?.message}`)
      return
    }
    builtRefs = built.imageRefs ?? []
    // 消息构建期的降级必须可见（见 applyMessageWarnings 的说明）
    applyMessageWarnings(res, built, cfg)

    // --- max_tokens：Anthropic 协议必填，但**绝不自定义数值**（用户定案） ---
    // 角色划分：
    //   · 客户端给的 → 不可信，按网关上限封顶（只封顶不放大）；
    //   · provider 声明的 defaultMaxTokens（adapter 配置）→ **可信，原样使用**；
    //   · 都没有 → **不传**，交由 DSH/adapter 自行决定
    //     （DSH 的 resolveCallWithInfo() 本就支持"调用方省略 maxTokens"）。
    const providerDefault = capsView?.maxOutputTokens?.value
    const resolvedMax = resolveAnthropicMaxTokens(
      body.max_tokens,
      typeof providerDefault === 'number' ? providerDefault : undefined,
      limits.maxTokensCap,
    )

    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: built.messages,
      // 工具定义：历史重建 + 本轮声明合并（见 mergeToolSchemas 的说明，#117）
      ...toolsOptionOf(built, parsed),
      ...(typeof body.temperature === 'number' && !enforceResult.ignored.includes('temperature')
        ? { temperature: body.temperature }
        : {}),
      // **只在解析出值时传**（unset 时交给 DSH 自己决定，不替 provider 拍板）
      ...(resolvedMax.value === undefined ? {} : { maxTokens: resolvedMax.value }),
      ...(Array.isArray(body.stop_sequences) && !enforceResult.ignored.includes('stop')
        ? { stop: body.stop_sequences }
        : {}),
      // thinking → 档位：具体词由「四档契约对照表」按链上各档词表算出
      // （effortWord 为 undefined = 不下发，比如整条链都不会思考）。
      ...(effortWord === undefined ? {} : { reasoningEffort: effortWord }),
      signal: abort.signal,
    }

    const messageId = newMessageId()

    // 软参数被忽略时必须显式标注（§6.5.5）
    for (const [name, valueOf] of Object.entries(enforceResult.headers ?? {})) {
      res.setHeader(name, valueOf)
    }
    // 如实告知本次 max_tokens 的处理方式（不做暗箱）：
    //   client   —— 用了客户端给的值（可能被网关封顶）
    //   provider —— 用了 provider 声明的默认值（原样，未封顶）
    //   unset    —— 两者都没有，交由 DSH/adapter 自行决定
    res.setHeader('X-Lantern-Max-Tokens-Source', resolvedMax.source)
    if (resolvedMax.value !== undefined) {
      res.setHeader('X-Lantern-Max-Tokens', String(resolvedMax.value))
    }
    // 网关没有通道的 Anthropic 专有参数 + 映射不到的 thinking：合并进同一个头
    const anthDropped = [...describeAnthropicDroppedParams(body), ...(thinkingMap.dropped ?? [])]
    if (anthDropped.length > 0) {
      res.setHeader('X-Lantern-Dropped-Params', anthDropped.join(','))
    }
    if (thinkingMap.note !== undefined) {
      res.setHeader('X-Lantern-Thinking-Note', encodeURIComponent(thinkingMap.note))
    }
    // 推理档位的契约外显（契约档 / 实发词 / 偏差说明）
    for (const [name, valueOf] of Object.entries(effort.headers ?? {})) {
      res.setHeader(name, valueOf)
    }

    if (body.stream === true) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      // 同 chat 通道：故障转移头必须在 flushHeaders 之前（#141）
      {
        const fo0 = { plan: anthReady[0], attempts: [] }
        try { applyServedHeaders(res, fo0, anthReady, deps.current()) } catch { /* 头已发则跳过 */ }
      }
      res.flushHeaders?.()
      // 关掉 TCP Nagle：否则短回答会被攒成一包一次性到达（#165）
      try { res.socket?.setNoDelay?.(true) } catch { /* 连接已断则忽略 */ }
      // 心跳（第十六轮 #171 / #175）
      //
      // 两级：
      //   · 还没出过任何内容 → 发**合法空 content 帧**（translator.keepalive()），
      //     客户端会据此刷新"正在输入"，而不是当注释丢掉；
      //   · 已经在输出     → 发 `: ping` 注释，避免打断打字机动画。
      //
      // 为什么必须有：实测 `Seed-2.1-Pro` 在 `trae` 上游会先空白 **116 秒**，
      // 再在 43ms 内吐完全部 2,890 字。那段空白里若只有注释帧，界面完全静止。
      let streamTranslatorForBeat
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        try {
          if (streamTranslatorForBeat !== undefined) {
            const ka = streamTranslatorForBeat.keepalive()
            if (Array.isArray(ka) && ka.length > 0) {
              for (const f of ka) writeFrame(res, f)
              return
            }
          }
        } catch { /* 保活失败不影响主流程 */ }
        res.write(': ping\n\n')
      }, 5_000)
      heartbeat.unref?.()

      const translator = new AnthropicStreamTranslator({
        id: messageId,
        model: target.publicName,
        sanitize: (failure) => publicFailurePatch(failure, deps.current()),
      })
      streamTranslatorForBeat = translator
      let streamFailure
      let rawUsage
      const fo = { plan: anthReady[0], attempts: [] }
      try {
        for await (const chunk of streamWithFailover(sctx, deps, anthReady, options, fo, tuneOf(target))) {
          if (abort.signal.aborted) break
          if (chunk.type === 'usage') rawUsage = chunk.usage
          for (const frame of translator.push(chunk)) writeFrame(res, frame)
        }
        if (rawUsage === undefined) rawUsage = fo.usage
        if (fo.failure !== undefined && fo.plan === undefined) streamFailure = fo.failure
        // 续写次数**不能**用 res.setHeader 通告：上面已经 flushHeaders()，
        // 头一旦发出再 setHeader 必抛 ERR_HTTP_HEADERS_SENT，而这个异常会被
        // 下面的 catch 记成「上游失败」——一次**成功**的断点续写反而把该后端
        // 记进负能力学习，并让客户端在完整正文之后收到一个 error 帧。
        // 改用 SSE 注释帧（规范要求解析器忽略以 ':' 开头的行），信息照样
        // 可观测，协议不受影响。
        if (fo.resumed !== undefined && fo.resumed > 0 && !res.writableEnded) {
          res.write(': lantern-resume=' + String(fo.resumed) + '\n\n')
        }
      } catch (error) {
        deps.log?.('error', `[lantern][anthropic] 流式转发异常：${error?.message}`)
        streamFailure = { message: error?.message, code: error?.code }
      } finally {
        clearInterval(heartbeat)
        if (streamFailure === undefined && translator.failure !== undefined) {
          streamFailure = translator.failure
        }
        // 兜住"错误不是以 finish chunk 形式到达"的情形（如 for await 抛出）：
        // 必须显式标记，否则 end() 会走正常收尾，客户端只看到
        // "200 + stop_reason:end_turn + 空内容"，即把上游故障伪装成正常空回答。
        if (streamFailure !== undefined && translator.errorEvent === undefined) {
          translator.markFailed(streamFailure)
        }
        for (const frame of translator.end()) writeFrame(res, frame)
        if (!res.writableEnded) res.end()
      }
      const used = fo.plan ?? anthReady[0]
      if (streamFailure !== undefined) await learnFromFailure(deps, used, streamFailure)
      await recordCall(deps, used, {
        usage: rawUsage,
        status: streamFailure === undefined ? 'ok' : 'error',
        ...(streamFailure === undefined ? {} : { errorCode: streamFailure.code ?? 'upstream_error', errorStatus: streamFailure.status, errorMessage: streamFailure.message }),
        ms: Date.now() - callStarted,
        protocol: 'anthropic',
        imageCount: builtRefs.length,
      })
      return
    }

    // --- 非流式（故障转移）---
    const fo2 = { plan: anthReady[0], attempts: [] }
    const aggregator = await collectWithFailover(
      sctx,
      deps,
      anthReady,
      options,
      fo2,
      (plan) => new AnthropicAggregator({ id: messageId, model: target.publicName }),
      tuneOf(target),
    )
    const aggUsage = fo2.usage
    const used2 = fo2.plan ?? anthReady[0]
    if (fo2.plan === undefined) {
      const failure = fo2.failure ?? { message: '上游调用失败' }
      await learnFromFailure(deps, used2, failure)
      await recordCall(deps, used2, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'anthropic',
        errorCode: failure.code ?? 'upstream_error', errorStatus: failure.status, errorMessage: failure.message,
      })
      const masked = maskedFailureBody({
        target,
        failure,
        attempts: fo2.attempts,
        cfg: deps.current(),
        custom: target.custom === true,
      })
      fail(502, masked.message, 'api_error')
      return
    }
    // ── #188：耗尽全部尝试仍空产出 → 必须报错，不能 200 ──
    // 与 chat 通道同一判据（见上方 #188 的详细说明）。
    //
    // ⚠ fail() 的签名是 (status, message, type, code?, extra?)：
    //    第 3 个参数是 **type**（Anthropic 风格类型），不是 error code。
    //    此前误把 code 传在第 3 位，会变成 type='upstream_empty_completion'
    //    —— 类型非法，客户端解析会出岔子。
    {
      const body0 = aggregator.end()
      const fr0 = body0?.choices?.[0]?.finish_reason
      const len0 = (body0?.choices?.[0]?.message?.content ?? '').length
      const tc0 = (body0?.choices?.[0]?.message?.tool_calls ?? []).length > 0
      // ── #219：判据要同时看 **OpenAI 形状** 和 **Anthropic 形状** ──
      //
      // 实测 hy4 max_tokens=1：
      //   stop_reason=max_tokens、content 只有 thinking 块、正文 0 字、HTTP 200
      // 而原来的判据读的是 `body0.choices[0].message.content`（OpenAI 形状）——
      // anthropic 通道的聚合器产出的是 Anthropic 形状（`body0.content[]`），
      // 于是 `len0` 恒为 0 之外的误判、`fr0` 恒为 undefined，
      // 整条判空逻辑**在这个通道上从来没生效过**。
      //
      // 现在两种形状都读：
      //   · Anthropic：`body0.content` 里 type==='text' 的块
      //   · OpenAI   ：`body0.choices[0].message.content`
      // 只算 **text**，不算 thinking —— 用户要的是正文，
      // 只思考不回答对他等于空（这一点与空回答保护的初衷一致）。
      const anthContent = Array.isArray(body0?.content) ? body0.content : undefined
      const anthTextLen = anthContent === undefined
        ? undefined
        : anthContent.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').length
      const anthToolCalls = anthContent === undefined
        ? undefined
        : anthContent.filter((b) => b?.type === 'tool_use').length
      const anthStop = typeof body0?.stop_reason === 'string' ? body0.stop_reason : undefined
      // 归一化：优先用 Anthropic 形状（本通道的真实形状），退化时用 OpenAI 形状。
      const effectiveFr = anthStop !== undefined ? anthStop : fr0
      const effectiveLen = anthTextLen !== undefined ? anthTextLen : len0
      const effectiveTc = anthToolCalls !== undefined ? anthToolCalls : (tc0 ? 1 : 0)
      // 结束原因里"正常收尾"的集合（两种形状的取值都列上）。
      const NORMAL_STOPS = new Set(['stop', 'end_turn', 'stop_sequence', 'tool_use'])
      const isEmptyLike = effectiveFr !== undefined
        && !NORMAL_STOPS.has(String(effectiveFr))
        && effectiveLen === 0
        && effectiveTc === 0
      if (isEmptyLike) {
        fail(503, '上游返回了空内容（0 字、无工具调用），请稍后重试或更换模型。', 'overloaded_error', 'upstream_empty_completion')
        await recordCall(deps, used2, {
          usage: aggUsage,
          status: 'error',
          ms: Date.now() - callStarted,
          protocol: 'anthropic',
          imageCount: builtRefs.length,
        })
        return
      }
      sendJson(res, 200, body0)
    }
    await recordCall(deps, used2, {
      usage: aggUsage,
      status: 'ok',
      ms: Date.now() - callStarted,
      protocol: 'anthropic',
      imageCount: builtRefs.length,
    })
  } finally {
    finished = true
    clearTimeout(totalTimer)
    res.off?.('close', onClose)
    deps.releaseSlot(slot)
    if (deps.ledger !== undefined && builtRefs.length > 0) {
      await deps.ledger.release(builtRefs).catch((error) => {
        deps.log?.('error', `[lantern][attachment] release 失败：${error?.message}`)
      })
    }
  }
}

/**
 * 处理 `POST /v1/responses`（OpenAI Responses 兼容端点）。
 *
 * 与 Chat Completions / Anthropic 通道**共用**：限流、读体、模型解析、
 * 能力闸门、图片闸门、并发闸门、附件账本、用量记账、负能力学习。
 * 本函数只负责协议差异：请求解析（responses.js）、响应翻译、错误体形状（OpenAI）。
 *
 * @param sctx - 已注入 webServer 的作用域上下文。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param deps - 依赖集合。
 */
async function handleResponses(sctx, req, res, deps) {
  const cfg = deps.current()
  const limits = cfg.limits ?? {}

  /**
   * OpenAI 形状的错误出口（统一脱敏，与 handleChatCompletions 同一套判据）。
   *
   * ⚠ 第 5 个参数 `extra` 不可省（第十轮 #107）。
   *
   * 原来这里只有 4 个形参，而调用处按 chat 通道的习惯传了第 5 个
   * `{ capability, allowed }` —— JS 会**静默丢弃**多出来的实参。后果：
   * 同一个非法 `reasoning_effort`，chat 的 400 体里有 `capability` 与 `allowed`，
   * responses 的错误体里两个字段都没有。客户端拿到 400 后不知道该填什么，
   * 只能去读文档或试错 —— 这正是"一条严、一条松"的那种分叉。
   */
  const failJson = (status, message, type = 'invalid_request_error', code = 'bad_request', extra = {}) => {
    sendJson(res, status, errorBody(publicMessage(maskSecrets(message), cfg), type, code, extra))
  }

  // --- 限流（与其它通道同一套计数） ---
  const perKeyRpm = deps.record?.limits?.perKeyRpm ?? limits.perKeyRpm ?? 30
  const keyId = deps.record?.id ?? '__anonymous__'
  if (!deps.allowRate(keyId, perKeyRpm)) {
    res.setHeader('Retry-After', '60')
    failJson(429, `超出速率上限（每 Key 每分钟 ${perKeyRpm} 次请求）`, 'rate_limit_error', 'rate_limit_exceeded')
    return
  }

  // --- 读体 ---
  const maxBodyBytes = limits.maxBodyBytes ?? 4 * 1024 * 1024
  const read = await readBody(req, maxBodyBytes)
  if (!read.ok) {
    if (read.reason === 'too_large') {
      failJson(413,
        `请求体超过上限（${Math.round(maxBodyBytes / 1024 / 1024)} MB）。带图的长会话易超限，建议开新会话。`,
        'invalid_request_error', 'payload_too_large')
      return
    }
    failJson(400, '请求体不是合法 JSON 对象', 'invalid_request_error', 'bad_request')
    return
  }

  // --- 解析（Responses 形状 → 内部口径） ---
  // 先做结构校验：`input: []` 会被 parseResponsesRequest 翻译成空消息列表，
  // 上游随后回 `200` 空内容——和 chat 空 messages 是同一个坑。
  {
    const invalid = validateResponsesRequest(read.body)
    if (invalid !== undefined) {
      failJson(400, invalid, 'invalid_request_error', 'bad_request')
      return
    }
  }
  let parsed
  try {
    parsed = parseResponsesRequest(read.body)
  } catch (error) {
    failJson(400, error?.message ?? '请求无法解析', 'invalid_request_error', 'bad_request')
    return
  }

  // --- 解析模型（全名制，与其它通道同语义） ---
  const target = resolveModel(deps.directory, parsed.model, cfg)
  if (target.error !== undefined || (target.custom !== true && target.provider === undefined)) {
    const maskedList = isTopologyMasked(cfg)
    sendJson(res, 404, errorBody(
      publicMessage(`模型未找到：${String(parsed.model ?? '(空)')}`, cfg),
      'invalid_request_error', 'model_not_found',
      maskedList ? {} : { available_hint: 'GET /v1/models' },
    ))
    return
  }
  if (target.custom !== true && !deps.directory.isProviderLive(target.provider)) {
    failJson(404,
      isTopologyMasked(cfg)
        ? `模型「${target.publicName ?? String(parsed.model ?? '')}」当前不可用，请稍后重试`
        : `provider「${target.provider}」当前未注册（可能已被移除）`,
      'invalid_request_error', 'provider_not_found')
    return
  }

  // --- 后端计划（与其它通道同一份实现） ---
  // 同样先展开、再按健康记忆重排（只改顺序，不删档）。
  const { plans: rawPlans, skipped } = buildFailoverPlans(deps.directory, target, deps.current())
  const allPlans = orderByHealth(deps, rawPlans)
  if (allPlans.length === 0) {
    const noBackend = publicNoBackendError({ target, skipped, cfg: deps.current() })
    failJson(503, noBackend.message, 'service_unavailable', 'no_backend')
    return
  }
  if (target.custom === true) applyFailoverHeaders(res, allPlans, skipped, deps.current())

  const wantsImage = parsed.images.length > 0

  // --- 能力闸门（与其它通道同一份实现） ---
  const { enforceResult, capsView, plans } = await enforceCapabilityGate(deps, target, {
    // 历史里有工具调用也算"要工具"（#126）：理由见 chat 通道同处注释。
    hasTools: (Array.isArray(parsed.toolSchemas) && parsed.toolSchemas.length > 0)
      || (Array.isArray(parsed.turns) && parsed.turns.some((t) => (Array.isArray(t?.toolCalls) && t.toolCalls.length > 0) || t?.role === 'tool')),
    hasImage: wantsImage,
    hasJsonMode: parsed.jsonMode !== undefined,
    hasReasoningEffort: parsed.reasoningEffort !== undefined,
    // 同 chat：档位值参与筛链（各后端词表不同）。
    reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort : undefined,
    hasTemperature: parsed.temperature !== undefined,
    hasStop: false,
  }, allPlans)
  // 同 chat：闸门筛完再重排，否则冷却在后端被筛链时丢失。
  const plansWithEffort = orderByHealth(deps, plans)
  // 上面那次 applyFailoverHeaders 发生在闸门之前，显示的还不是最终链（筛链会
  // 改变档位）。已经出去的头没法收回，所以这里按最终链再写一遍；同名 setHeader
  // 是覆盖语义，调用方看到的始终是真实会走的顺序。
  if (target.custom === true) applyFailoverHeaders(res, plansWithEffort, skipped, deps.current())

  const imageGate = imageGateMessage(cfg, wantsImage)
  if (imageGate !== undefined) {
    failJson(400, imageGate, 'invalid_request_error', 'image_input_disabled')
    return
  }
  if (enforceResult.reject !== undefined) {
    const r = enforceResult.reject
    const capsMasked = isHintMasked(cfg)
    const capsMessage = !capsMasked
      ? r.message
      : r.value === 'unsupported'
        ? `当前模型不支持${r.label}，请去掉该参数或换一个模型`
        : `暂时无法确认当前模型是否支持${r.label}，为避免返回错误结果已拒绝本次请求`
    sendJson(res, 400, errorBody(capsMessage, 'invalid_request_error', 'capability_rejected', {
      capability: r.capability,
      capability_value: r.value,
      ...(capsMasked ? {} : { capability_source: r.source, all_unsupported: r.all }),
    }))
    return
  }

  // --- reasoning.effort → 四档契约 ---
  // 与 chat 通道完全同一条纪律：客户端只说四档，网关按链上词表映射到真实词；
  // 认不出就 400（带四档可选值），整条链都不会思考就不下发。
  const effort = await resolveEffortForChain(deps, plans, parsed.reasoningEffort, effortOptsOf(target))
  if (effort.error !== undefined) {
    failJson(400, effort.error.message, 'invalid_request_error', 'invalid_reasoning_effort', {
      capability: 'reasoning',
      allowed: effort.error.allowed,
    })
    return
  }
  const effortMap = { value: effort.word }
  // 逐档注解（第十一轮 #121）：responses 通道同样要逐档算。
  const respPlans = effort.contract === undefined
    ? plansWithEffort
    : await annotatePlanEfforts(deps, plansWithEffort, effort.contract)
  // 逐档挂输出上限（#150）：三条通道都要有，否则换通道就又回到"全链单值"。
  const respReady = await annotatePlanMaxOutput(deps, respPlans)

  // --- 熔断闸门 ---
  const admit = deps.breaker?.admit(deps.record?.id ?? '__anonymous__') ?? { ok: true }
  if (!admit.ok) {
    res.setHeader('Retry-After', String(admit.retryAfterSec ?? 60))
    const status = admit.code === 'circuit_open' ? 503 : 429
    failJson(status, admit.message, admit.code === 'circuit_open' ? 'service_unavailable' : 'rate_limit_error', admit.code)
    return
  }

  // --- 并发闸门 ---
  const slot = deps.acquireSlot()
  if (slot === undefined) {
    res.setHeader('Retry-After', '5')
    failJson(429, `网关并发已满（上限 ${limits.maxConcurrent ?? 2}），请稍后重试`, 'rate_limit_error', 'concurrency_limit_exceeded')
    return
  }

  const abort = new AbortController()
  let finished = false
  const callStarted = Date.now()
  let builtRefs = []
  const onClose = () => {
    if (!finished) abort.abort()
  }
  // 断连信号必须挂 **res**，不能挂 req：
  // req 的 'close' 在请求体读完时就已经派发过了（readBody 在上面 await 完），
  // 那时再注册等于挂了个永远不会触发的监听器——客户端断开后上游照跑、
  // token 照烧，而注释里承诺的「客户端断连必须 abort」实际是空实现。
  res.on('close', onClose)
  // 注册之前就可能已经断开（快客户端 / 反向代理超时），补一次状态兜底。
  // 只能看 res：`req.destroyed` 在 body 读完的那一刻就是 true（IncomingMessage
  // 读到 EOF 后会自动 destroy），用它判断「客户端已断开」等于每个请求开局就 abort ——
  // 实测后果是上游一次都没被调用，客户端拿到 200 + content:null + finish_reason:stop，
  // 账本记 status:'ok'、ms 个位数。res 的 destroyed 才代表这次连接真的没了。
  if (res.destroyed) abort.abort()
  /**
   * 请求**总时长**上限（`limits.requestTimeoutMs`，默认 10 分钟）。
   *
   * 之前这个配置项只在 DEFAULT_CONFIG 里存在，**代码从不读它** —— 请求一旦发出
   * 就没有天花板：上游如果肯慢慢吐字（隔几十秒一个 token），连接会一直挂着、
   * 并发槽位被占死，表现是"网关越用越慢，最后并发满"。
   *
   * 它和自定义模型的 `timeoutMs` 是**两个层次**，不能互相替代：
   *   · `target.timeoutMs` 是**单档首包**超时，决定"这家不回话就换下家"；
   *   · 这里管的是**整个请求**（含全部故障转移重试）最多花多久，超了就 504。
   */
  const requestTimeoutMs = Number.isFinite(limits.requestTimeoutMs) && limits.requestTimeoutMs > 0
    ? Math.round(limits.requestTimeoutMs)
    : 600_000
  const totalTimer = setTimeout(() => {
    if (finished) return
    abort.abort()
  }, requestTimeoutMs)
  totalTimer.unref?.()

  try {
    // --- 构造消息（图片走附件账本，与其它通道同一份实现） ---
    const attachments = sctx.get('attachments')
    let built
    try {
      built = await buildMessages(parsed, attachments, {
        allowImage: cfg.allowImageInput === true,
        ledger: deps.ledger,
        // 该模型把 system 合并进 user 消息（#155；有些上游见到独立 system role 就返回全空）
        mergeSystemIntoUser: target.mergeSystemIntoUser === true,
        toolResultAsText: target.toolResultAsText === true,
      })
    } catch (error) {
      const code = error?.lanternCode ?? 'invalid_request'
      failJson(400, error?.message ?? '请求无法处理', 'invalid_request_error', code)
      deps.log?.('error', `[lantern][responses] 构造消息失败（${code}）：${error?.message}`)
      return
    }
    builtRefs = built.imageRefs ?? []
    // 消息构建期的降级必须可见（见 applyMessageWarnings 的说明）
    applyMessageWarnings(res, built, cfg)

    // --- max_output_tokens：客户端值只封顶不放大；provider 默认原样；都没有则不传 ---
    const providerDefault = capsView?.maxOutputTokens?.value
    // 与另外两条通道统一：0 / 非有限 = 不封顶（不是"压成 0"）。
    const rawCap = limits.maxTokensCap
    const cap = Number.isFinite(rawCap) && rawCap > 0 ? rawCap : undefined
    let maxTokensValue = undefined
    let maxTokensSource = 'unset'
    if (typeof parsed.maxOutputTokens === 'number' && parsed.maxOutputTokens > 0) {
      maxTokensValue = cap === undefined ? parsed.maxOutputTokens : Math.min(parsed.maxOutputTokens, cap)
      maxTokensSource = 'client'
    } else if (typeof providerDefault === 'number') {
      maxTokensValue = providerDefault
      maxTokensSource = 'provider'
    }

    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: built.messages,
      // 工具定义：历史重建 + 本轮声明合并（见 mergeToolSchemas 的说明，#117）
      ...toolsOptionOf(built, parsed),
      ...(typeof parsed.temperature === 'number' && !enforceResult.ignored.includes('temperature') ? { temperature: parsed.temperature } : {}),
      ...(maxTokensValue === undefined ? {} : { maxTokens: maxTokensValue }),
      ...(effortMap?.value === undefined ? {} : { reasoningEffort: effortMap.value }),
      signal: abort.signal,
    }
    // ⚠ 曾经这里还下发过 topP / responseFormat / toolChoice 三个字段，全部是
    // 幻觉通道：DSH 的 GenerateOptions 里没有它们（全树 0 命中，两个 adapter
    // 只消费 provider/model/messages/tools/temperature/maxTokens/stop/
    // reasoningEffort/signal）。塞进去的后果不是报错，而是**静默消失**——
    // 客户端传 top_p:0.3 以为收窄了采样面，实际什么都没变，响应头也不提。
    //
    // responseFormat 尤其阴：Responses 的 text.format 已经由 parseResponsesRequest
    // 归一化成 jsonMode 并拼进 system 提示（与 chat 的 response_format 同一条路），
    // 那才是真正生效的约束；再塞一个 responseFormat 只是给同一个需求挂了个空壳。
    // top_p 与 tool_choice 则彻底没有落地通道，已在 parseResponsesRequest 里
    // 记进 dropped，由下面统一写 X-Lantern-Dropped-Params。

    const responseId = newResponseId()

    // 软参数头：如实标注（与其它通道同一纪律）
    for (const [name, valueOf] of Object.entries(enforceResult.headers ?? {})) {
      res.setHeader(name, valueOf)
    }
    res.setHeader('X-Lantern-Max-Tokens-Source', maxTokensSource)
    if (maxTokensValue !== undefined) res.setHeader('X-Lantern-Max-Tokens', String(maxTokensValue))
    if (parsed.dropped.length > 0) {
      res.setHeader('X-Lantern-Dropped-Params', parsed.dropped.join(','))
    }
    // 推理档位的契约外显
    for (const [name, valueOf] of Object.entries(effort.headers ?? {})) {
      res.setHeader(name, valueOf)
    }

    if (parsed.stream === true) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      // 同 chat 通道：故障转移头必须在 flushHeaders 之前（#141）
      {
        const fo0 = { plan: respReady[0], attempts: [] }
        try { applyServedHeaders(res, fo0, respReady, deps.current()) } catch { /* 头已发则跳过 */ }
      }
      res.flushHeaders?.()
      // 关掉 TCP Nagle：否则短回答会被攒成一包一次性到达（#165）
      try { res.socket?.setNoDelay?.(true) } catch { /* 连接已断则忽略 */ }
      // 心跳（第十六轮 #171 / #175）
      //
      // 两级：
      //   · 还没出过任何内容 → 发**合法空 content 帧**（translator.keepalive()），
      //     客户端会据此刷新"正在输入"，而不是当注释丢掉；
      //   · 已经在输出     → 发 `: ping` 注释，避免打断打字机动画。
      //
      // 为什么必须有：实测 `Seed-2.1-Pro` 在 `trae` 上游会先空白 **116 秒**，
      // 再在 43ms 内吐完全部 2,890 字。那段空白里若只有注释帧，界面完全静止。
      let streamTranslatorForBeat
      const heartbeat = setInterval(() => {
        if (res.writableEnded) return
        try {
          if (streamTranslatorForBeat !== undefined) {
            const ka = streamTranslatorForBeat.keepalive()
            if (Array.isArray(ka) && ka.length > 0) {
              for (const f of ka) writeFrame(res, f)
              return
            }
          }
        } catch { /* 保活失败不影响主流程 */ }
        res.write(': ping\n\n')
      }, 5_000)
      heartbeat.unref?.()

      const translator = new ResponsesStreamTranslator({
        id: responseId,
        model: target.publicName,
        sanitize: (failure) => publicFailurePatch(failure, deps.current()),
      })
      streamTranslatorForBeat = translator
      let streamFailure
      let rawUsage
      const fo = { plan: respReady[0], attempts: [] }
      try {
        for await (const chunk of streamWithFailover(sctx, deps, respReady, options, fo, tuneOf(target))) {
          if (abort.signal.aborted) break
          if (chunk.type === 'usage') rawUsage = chunk.usage
          for (const frame of translator.push(chunk)) writeFrame(res, frame)
        }
        if (rawUsage === undefined) rawUsage = fo.usage
        if (fo.failure !== undefined && fo.plan === undefined) streamFailure = fo.failure
        // 续写次数**不能**用 res.setHeader 通告：上面已经 flushHeaders()，
        // 头一旦发出再 setHeader 必抛 ERR_HTTP_HEADERS_SENT，而这个异常会被
        // 下面的 catch 记成「上游失败」——一次**成功**的断点续写反而把该后端
        // 记进负能力学习，并让客户端在完整正文之后收到一个 error 帧。
        // 改用 SSE 注释帧（规范要求解析器忽略以 ':' 开头的行），信息照样
        // 可观测，协议不受影响。
        if (fo.resumed !== undefined && fo.resumed > 0 && !res.writableEnded) {
          res.write(': lantern-resume=' + String(fo.resumed) + '\n\n')
        }
      } catch (error) {
        deps.log?.('error', `[lantern][responses] 流式转发异常：${error?.message}`)
        streamFailure = { message: error?.message, code: error?.code }
      } finally {
        clearInterval(heartbeat)
        if (streamFailure !== undefined) translator.markFailed(streamFailure)
        for (const frame of translator.end()) writeFrame(res, frame)
        if (!res.writableEnded) res.end()
      }
      const used = fo.plan ?? respReady[0]
      if (streamFailure !== undefined) await learnFromFailure(deps, used, streamFailure)
      await recordCall(deps, used, {
        usage: rawUsage,
        status: streamFailure === undefined ? 'ok' : 'error',
        ...(streamFailure === undefined ? {} : { errorCode: streamFailure.code ?? 'upstream_error', errorStatus: streamFailure.status, errorMessage: streamFailure.message }),
        ms: Date.now() - callStarted,
        protocol: 'responses',
        imageCount: builtRefs.length,
      })
      return
    }

    // --- 非流式（故障转移） ---
    const fo2 = { plan: respReady[0], attempts: [] }
    const aggregator = await collectWithFailover(
      sctx, deps, respReady, options, fo2,
      () => new ResponsesAggregator({ id: responseId, model: target.publicName }),
      tuneOf(target),
    )
    const aggUsage = fo2.usage
    const used2 = fo2.plan ?? respReady[0]
    if (fo2.plan === undefined) {
      const failure = fo2.failure ?? { message: '上游调用失败' }
      await learnFromFailure(deps, used2, failure)
      await recordCall(deps, used2, {
        usage: aggUsage, status: 'error', ms: Date.now() - callStarted,
        protocol: 'responses', errorCode: failure.code ?? 'upstream_error', errorStatus: failure.status, errorMessage: failure.message,
      })
      const masked = maskedFailureBody({
        target, failure, attempts: fo2.attempts, cfg: deps.current(), custom: target.custom === true,
      })
      failJson(502, masked.message, 'upstream_error', failure.code ?? 'upstream_error')
      return
    }
    // ── #188：耗尽全部尝试仍空产出 → 必须报错，不能 200 ──
    // 与 chat 通道同一判据（见上方 #188 的详细说明）。
    //
    // ⚠ failJson 的签名是 (status, message, type, code?, extra?)：
    //    type 必须是合法值（service_unavailable / invalid_request_error / ...），
    //    自定义 code 放第 4 位。
    {
      const body0 = aggregator.end()
      const fr0 = body0?.choices?.[0]?.finish_reason
      const len0 = (body0?.choices?.[0]?.message?.content ?? '').length
      const tc0 = (body0?.choices?.[0]?.message?.tool_calls ?? []).length > 0
      // #219：结束原因的白名单与 anthropic 通道保持同一份语义。
      // 三种"正常收尾"必须放行，其余非空原因 + 0 正文 = 空回答。
      const NORMAL_STOPS_R = new Set(['stop', 'end_turn', 'stop_sequence', 'tool_use'])
      const isEmptyLike = fr0 !== undefined && !NORMAL_STOPS_R.has(String(fr0))
        && len0 === 0 && !tc0
      if (isEmptyLike) {
        failJson(503, '上游返回了空内容（0 字、无工具调用），请稍后重试或更换模型。', 'service_unavailable', 'upstream_empty_completion')
        await recordCall(deps, used2, {
          usage: aggUsage, status: 'error', ms: Date.now() - callStarted,
          protocol: 'responses', imageCount: builtRefs.length,
        })
        return
      }
      sendJson(res, 200, body0)
    }
    await recordCall(deps, used2, {
      usage: aggUsage, status: 'ok', ms: Date.now() - callStarted,
      protocol: 'responses', imageCount: builtRefs.length,
    })
  } finally {
    finished = true
    clearTimeout(totalTimer)
    res.off?.('close', onClose)
    deps.releaseSlot(slot)
    if (deps.ledger !== undefined && builtRefs.length > 0) {
      await deps.ledger.release(builtRefs).catch((error) => {
        deps.log?.('error', `[lantern][attachment] release 失败：${error?.message}`)
      })
    }
  }
}
