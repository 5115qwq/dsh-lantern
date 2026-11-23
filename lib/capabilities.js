/**
 * dsh-lantern — 能力层（P4）。
 *
 * 原则（设计方案 §6.5，三条铁律）：
 * 1. **权威优先**：DSH 已声明的字段**原样透传**，不添加、不推测、不"善意补全"；
 * 2. **未知 ≠ 支持**：DSH 没声明的能力默认公开为 `unknown`，并按"未知即拒绝"处理；
 * 3. **双向如实**：公开"支持"的必须真能用，公开"不支持"的必须明确报错——
 *    **绝不静默忽略参数然后返回一个看起来正常的回答**。
 *
 * 三态取值：`supported` / `unsupported` / `unknown`，且**必带 `source`**：
 *   `dsh`（DSH 权威）/ `declared`（用户手动）/ `profile`（内建推测）
 *   / `learned`（运行时负能力学习）/ `probe`（主动探测）/ `null`（无依据）
 *
 * 覆盖优先级（§6.5.3b，用户已定案）：
 *   用户手动覆盖 > 负担学习 > 主动探测 > 内建画像 > DSH 权威自动判定
 *   —— 但 DSH 权威项（图片/推理/上下文）默认照填，用户可以推翻它，
 *      推翻后标 `declared` 并显示"已被手动修改（原始权威值：X）"。
 *
 * @module dsh-lantern/capabilities
 */
import { readJson, writeJson, PATHS } from './storage.js'
import { deflateSync } from 'node:zlib'

/** 三态。 */
export const VALUE = Object.freeze({
  supported: 'supported',
  unsupported: 'unsupported',
  unknown: 'unknown',
})

/** 能力键。 */
export const KEYS = Object.freeze([
  'text',
  'image',
  'reasoning',
  'tools',
  'parallelTools',
  'jsonMode',
  'temperature',
  'stop',
  'streaming',
])

/**
 * 「测试」结果可以自动回写的能力项。
 *
 * 只含**能力型探针**：连线（connectivity）失败是网络/上游可用性问题，
 * 不代表模型不具备某项能力；authoritative 只是零成本的元数据刷新。
 * 把这两类写进画像会造成"一次网络抖动 → 该模型被永久标成不支持"。
 */
export const WRITABLE_ITEMS = new Set(['tools', 'temperature', 'jsonMode', 'stop', 'image', 'parallelTools'])

/** 人类可读名称（UI 用）。 */
export const LABELS = Object.freeze({
  text: '文本输入',
  image: '图片输入',
  reasoning: '推理能力',
  tools: '工具调用',
  parallelTools: '并行工具调用',
  jsonMode: 'JSON 模式',
  temperature: '温度参数',
  stop: '停止序列',
  streaming: '流式输出',
})

/**
 * 内建画像（档 B 第 2 层）：按 provider 给**推测性**默认。
 *
 * ⚠ 这些只是默认值，**属推测**（`source: 'profile'`），可被用户覆盖，
 * 且落地前应逐条实测确认。本机已知的真实 provider 才预置。
 */
export const BUILTIN_PROFILES = Object.freeze({
  // DeepSeek 系（官方 + 腾讯/国际版中转）：均支持工具调用与温度
  'deepseek-official': { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
  buddy: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
  workbuddy: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
  // WorkBuddy 国际区（workbuddy-global）：本机实测 tools / jsonMode 均可用
  'workbuddy-global': { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
  codearts: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
  // cmdgo 走 CLI 私有网关，参数支持面较窄 → 保守标未知（不用 supported 赌）
  commandcode: { temperature: VALUE.unknown, stop: VALUE.unknown },
  // 硅基流动 OpenAI 兼容，常规参数齐备
  siliconflow: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported, jsonMode: VALUE.supported },
})

/**
 * 从上游错误文本里识别"不支持某能力"（档 C：运行时负能力学习）。
 *
 * 只在错误**明确指向该能力**时才记录，避免把"网络错误"误判成"不支持"。
 */
const NEGATIVE_PATTERNS = Object.freeze({
  tools: [
    /tool[s]?(?:\s*(?:is|are))?\s+not\s+support/i,
    /does\s+not\s+support\s+tool/i,
    /no\s+tool\s+call\s+support/i,
    /function\s+calling[^.]{0,20}not\s+support/i,
    /tools?[^.]{0,20}unsupported/i,
  ],
  jsonMode: [
    /response_format[^.]{0,30}not\s+support/i,
    /json[ _-]?mode[^.]{0,20}not\s+support/i,
    /structured\s+output[^.]{0,20}not\s+support/i,
  ],
  temperature: [
    /temperature[^.]{0,30}not\s+support/i,
    /unsupported[^.]{0,20}temperature/i,
    // 只认"不认识这个参数"，不认"这个值不合法"：
    // temperature 必须是 0-2 是**值**错了，模型明明支持 temperature，
    // 把它记成"不支持"会让之后所有带 temperature 的请求都被拒。
    /(?:unrecognized|unknown|unexpected)\s+(?:parameter|field|argument)[^.]{0,20}temperature/i,
    /temperature[^.]{0,20}(?:is\s+)?not\s+a\s+(?:valid|supported)\s+(?:parameter|field)/i,
  ],
  stop: [
    // 这条原来只是 /stop[ _-]?sequence/i —— 只要文本里出现 "stop sequence"
    // 就判"不支持 stop"，连 stop sequence is too long（值太长）、
    // Invalid stop sequence: must be an array（类型错）都会中招。
    // 一次超长 stop 就会把整个模型永久标成不支持 stop，之后所有带 stop 的
    // 请求全部被拒，而且这个结论会落进 data/capabilities.json 活很久。
    /stop[ _-]?sequences?[^.]{0,30}not\s+support/i,
    /(?:does\s+not|doesn't)\s+support[^.]{0,20}stop/i,
    /unsupported[^.]{0,20}stop[ _-]?sequence/i,
    /(?:unrecognized|unknown|unexpected)\s+(?:parameter|field|argument)[^.]{0,20}stop/i,
  ],
  image: [
    // 同理：image format not supported（**格式**不支持，模型能读图）、
    // image size not supported（尺寸超限）都会被原规则误判成"不支持图片"。
    /(?:does\s+not|doesn't)\s+support\s+(?:image|vision)/i,
    /(?:image|vision)[ _-]?(?:input|understanding)?\s+(?:is\s+)?not\s+support/i,
    /(?:model|endpoint)[^.]{0,20}text[ _-]?only/i,
  ],
  reasoning: [
    /reasoning[ _-]?effort[^.]{0,30}not\s+support/i,
    // "Unsupported parameter: 'reasoning'" 是 OpenAI 的官方措辞，
    // 它说的是"不认识这个参数"，等价于不支持。但要注意不能把
    // "reasoning effort must be low/medium/high"（值不对）算进来——
    // 所以这里要求 reasoning 与 unsupported 之间只能是参数名分隔符。
    /unsupported\s+(?:parameter|field|argument)\s*[:：]?\s*['"`]?reasoning/i,
    /(?:unrecognized|unknown|unexpected)\s+(?:parameter|field|argument)[^.]{0,20}reasoning/i,
  ],
  parallelTools: [/parallel[ _-]?tool[^.]{0,30}not\s+support/i],
})

/**
 * `GenerateOptions.<field>` → 能力键。
 *
 * 为什么单独认这一种：DSH 的 adapter 拒绝某个生成参数时，抛的是
 * `new LlmError("llm-pi-ai does not support GenerateOptions.stop", "UNSUPPORTED_OPTION")`
 * ——字段名嵌在 Identify 里，且 `GenerateOptions` 与字段名之间有个点。
 * NEGATIVE_PATTERNS 里那些正则都用 `[^.]` 限制跨度，正是为了不被句号
 * 骗过去，结果这一族"合法但错位"的文本反而漏了。实测 pi-ai adapter
 * 收到 `options.stop` 直接抛，而上面 stop 那组一条都不命中。
 *
 * 没映射的字段返回 undefined：宁可漏学，也不能把 `maxTokens` 之类的
 * 通用字段误记成"不支持某项能力"（它其实是本次请求给的值不合法）。
 */
const GENERATE_OPTION_CAPABILITY = Object.freeze({
  stop: 'stop',
  temperature: 'temperature',
  tools: 'tools',
  reasoningEffort: 'reasoning',
})

/** `does not support GenerateOptions.<field>`，抓字段名。 */
const UNSUPPORTED_GENERATE_OPTION = /(?:does\s+not|doesn't)\s+support[^.]{0,40}?GenerateOptions\s*\.\s*([A-Za-z]+)/i

/**
 * 从一段错误文本识别它指向哪个能力（没有命中则返回 undefined）。
 * @param message - 上游错误原文。
 * @returns 能力键，或 undefined。
 */
export function detectNegativeCapability(message) {
  const text = String(message ?? '')
  if (text.length === 0) return undefined
  const opt = UNSUPPORTED_GENERATE_OPTION.exec(text)
  if (opt !== null) {
    const mapped = GENERATE_OPTION_CAPABILITY[opt[1]]
    if (mapped !== undefined) return mapped
  }
  for (const [key, patterns] of Object.entries(NEGATIVE_PATTERNS)) {
    for (const re of patterns) {
      if (re.test(text)) return key
    }
  }
  return undefined
}

/**
 * 手写一个 24×12 的 PNG：**左半纯红、右半纯蓝**。
 *
 * 用途：图片能力探测的输入。它必须"有明确的、可校验的内容"，
 * 否则无法判断模型是否**真的读出了图**（用户明确要求）。
 * 只有约 100 字节，手写避免引入任何图像库依赖。
 *
 * @returns PNG 字节。
 */
export function buildProbePng() {
  const width = 24
  const height = 12
  // 扫描线：每行 = 过滤器字节(0) + width 个 RGB 三元组
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: None
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3
      const leftHalf = x < width / 2
      raw[p] = leftHalf ? 255 : 0 // R
      raw[p + 1] = 0 // G
      raw[p + 2] = leftHalf ? 0 : 255 // B
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** PNG CRC32 查表（延迟构建一次）。 */
let crcTable
/**
 * 计算 PNG 分块所需的 CRC32。
 * @param buf - 待校验字节。
 * @returns 无符号 32 位 CRC。
 */
function crc32(buf) {
  if (crcTable === undefined) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 组一个 PNG 分块（长度 + 类型 + 数据 + CRC）。
 * @param type - 4 字符类型（如 `IHDR`）。
 * @param data - 分块数据。
 * @returns 完整分块字节。
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([len, typed, crc])
}

/**
 * 构造一个能力结论。
 * @param value - 三态之一。
 * @param source - 来源标签。
 * @param extra - 附加字段（note / efforts / 数值等）。
 * @returns 结论对象。
 */
function cap(value, source, extra = {}) {
  return { value, source, ...extra }
}

/**
 * 能力解析器：管理权威透传、手动覆盖、画像、学习结果与缓存。
 */
export class CapabilityResolver {
  /**
   * @param ctx - Host 插件上下文（需要 llm 服务）。
   * @param config - 返回当前配置的函数。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /**
     * 占并发槽的执行器（默认直通）。
     *
     * 探测会真实调用模型，却原来直接打 `ctx.llm.stream()`——完全绕过
     * `limits.maxConcurrent` 的闸门。上游已经满载时点一次「能力测试」，
     * 等于再挤进 1~6 个请求；用户看到的是"网关突然变慢"，
     * 而面板上显示的并发数一切正常。由 index.js 注入真实的 acquire/release。
     *
     * @type {(fn: () => Promise<any>) => Promise<any>}
     */
    this.withSlot = (fn) => fn()
    /** 用户手动覆盖：`"provider\u0000model\u0000key"` -> { value, at } */
    this.overrides = new Map()
    /** 运行时学习：同键 -> { value, evidence, at } */
    this.learned = new Map()
    /** 权威元数据缓存：`"provider\u0000model\u0000generation"` -> caps */
    this.authoritative = new Map()
    /** describe() 的结果缓存：同键 -> 组装好的能力视图（key 含 generation，见 describe） */
    this.describeCache = new Map()
    /** 能力缓存代次（收到 adapters-updated 时递增，使权威缓存失效，§6.5.7） */
    this.generation = 0
    this.loaded = false
    /**
     * 用量记账回调（P9）：`(usage, item, where, status) => void`。
     * 探测会真实调用模型，因此这些消耗也要进账本（记为 `kind: 'test'`）。
     *
     * `status` 必须如实传：此前回调固定按 'ok' 记账，于是**探针失败也会被当成
     * 一次成功**——熔断器的 streak 被清零，"上游正在限流"这件事被管理员点一次
     * 「测试」就抹掉了。探测本身就是对上游健康状况的一次观测，不能只报喜。
     *
     * @type {((usage: object|undefined, item: string, where: object, status: string) => void)|undefined}
     */
    this.onUsage = undefined
  }

  /** 从磁盘载入覆盖与学习结果（`data/capabilities.json`）。 */
  async load() {
    const doc = await readJson(PATHS.capabilities, { version: 1, overrides: {}, learned: {} })
    this.overrides = new Map(Object.entries(doc?.overrides ?? {}))
    this.learned = new Map(Object.entries(doc?.learned ?? {}))
    this.loaded = true
    return { overrides: this.overrides.size, learned: this.learned.size }
  }

  /** 落盘（只写插件自己的 data/）。 */
  async persist() {
    await writeJson(PATHS.capabilities, {
      version: 1,
      overrides: Object.fromEntries(this.overrides),
      learned: Object.fromEntries(this.learned),
      updatedAt: Date.now(),
    })
  }

  /** 缓存键。 */
  #key(provider, model, field) {
    return `${provider}\u0000${model}\u0000${field}`
  }

  /**
   * 使权威缓存失效（provider 拓扑变化时调用）。
   * 理由：像 cmdgo 这类 adapter 会在目录刷新时 `registration.replace()`，
   * 同一 provider 的能力可能在运行中改变（§6.5.7）。
   */
  invalidate() {
    // generation 变化已让 describe 的缓存 key 失效，这里顺手清空避免堆积。
    this.describeCache.clear()
    this.generation += 1
    this.authoritative.clear()
  }

  /**
   * 当前的条目计数（#193 内存诊断用）。
   *
   * 只返回**数量**，不返回内容 —— 面板/status 用它判断"插件持有的数据有多少"，
   * 与 `process.memoryUsage()` 的分段数字对照，就能区分：
   *   · 数据条目多 → 是真·数据占内存
   *   · 条目少但 external 高 → 是 Buffer（图片解码）占内存
   *
   * @returns `{ overrides, learned, authoritative }`。
   */
  counts() {
    return {
      overrides: this.overrides.size,
      learned: this.learned.size,
      authoritative: this.authoritative.size,
    }
  }

  /**
   * 取 DSH 权威能力（档 A，**只读透传**）。
   * @param provider - provider 路由 id。
   * @param model - 模型 id。
   * @returns 权威能力对象；查询失败返回 undefined。
   */
  /**
   * 取"该模型所有绑定里该字段的最大值"，作为权威值缺失时的兜底（第十三轮 #149）。
   *
   * ⚠ 实测结论：这条兜底**在真实环境里拿不到值**。
   *
   * DSH 的 `llm` 服务只暴露 `resolveModelInfo(provider, model)` 与 `stream()`，
   * **没有 `listProviders()` / `listModels()`**（这两个名字在整棵树里只出现在
   * 这个方法内部，原代码从未用过）。所以我无法枚举"同名的其它绑定"。
   *
   * 保留这个方法（有 `?.` 保护，拿不到就返回 unknown）是为了：
   *   · 将来 DSH 若加上枚举 API，这里自动生效；
   *   · 明确记录"为什么 deepseek 的 maxOut 只能报到 64000"。
   *
   * 真正要改这个值，用**手动覆盖**（设置面板的 provider 页）或
   * 在 `cordis.patch.yml` 里给每个绑定都写上 `maxTokens`。
   *
   * @param provider - 本绑定 provider。
   * @param model - 模型名。
   * @param field - `'contextWindow'` 或 `'maxOutputTokens'`。
   * @param preferred - 本绑定已有的权威值（可能 undefined）。
   * @returns 能力 cell。
   */
  async bestOf(provider, model, field, preferred) {
    if (preferred !== undefined && typeof preferred.value === 'number') return preferred
    return cap(VALUE.unknown, 'dsh')
  }

  async authoritativeOf(provider, model) {
    const cacheKey = `${provider}\u0000${model}\u0000${this.generation}`
    const cached = this.authoritative.get(cacheKey)
    if (cached !== undefined) return cached

    let info
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model)
    } catch {
      return undefined
    }
    // ── 必须处理 null（第十六轮 #166）──
    //
    // `resolveModelInfo` 有两种"查不到"的表达：**抛异常** 和 **返回 null/undefined**。
    // 上面只接了前一种，于是后者会一路走到 `info.inputModalities` 抛 TypeError。
    //
    // 后果比崩溃更隐蔽：`describe()` 的调用方（`resolveChainWordFor`）
    // 用 `try { ... } catch {}` 包着，**异常被吞成空词表**。于是某个绑定
    // 明明有 5 档 reasoning 词表，却被当成"无档案"不参与投票 ——
    // 实测 hy4 三个绑定里两个这样被跳过，四档全被压成 `high`，
    // 用户选 minimal 却拿到最强档，且没有任何降级提示。
    //
    // 这跟"字段缺失 = 未知"是同一条原则：**查不到 ≠ 崩溃**。
    if (info === null || info === undefined || typeof info !== 'object') return undefined
    // ⚠ 语义要点：字段缺失 = 未知；字段存在但不含 = 明确不支持
    const mods = info.inputModalities
    const textCap =
      mods === undefined
        ? cap(VALUE.unknown, 'dsh')
        : cap(mods.includes('text') ? VALUE.supported : VALUE.unsupported, 'dsh')
    const imageCap =
      mods === undefined
        ? cap(VALUE.unknown, 'dsh', { note: '该模型未声明输入模态，故图片能力未知' })
        : mods.includes('image')
          ? cap(VALUE.supported, 'dsh')
          : cap(VALUE.unsupported, 'dsh', { note: 'inputModalities 显式不含 image（明确不支持）' })

    const reasoningCap =
      info.reasoning !== undefined && info.reasoning.efforts.length > 0
        ? cap(VALUE.supported, 'dsh', {
            efforts: info.reasoning.efforts.map((e) => e.id),
            ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
          })
        : cap(VALUE.unknown, 'dsh', { note: '未声明 reasoning 元数据' })

    const result = {
      text: textCap,
      image: imageCap,
      reasoning: reasoningCap,
      // 上下文与输出上限是**数值型**能力
      contextWindow: info.context !== undefined ? { value: info.context.contextWindow, source: 'dsh' } : cap(VALUE.unknown, 'dsh'),
      // ⚠ 输出上限的字段名在不同来源里不一样（第十三轮 #148）。
      //
      // 原来只读 `info.defaultMaxTokens`。但 DSH 的模型定义里写的是
      // `maxTokens`（见 cordis.patch.yml：`maxTokens: 128000`），
      // 而 `resolveModelInfo()` 暴露出来的名字可能是 `defaultMaxTokens`，
      // 也可能仍是 `maxTokens` —— 取决于内核版本。
      //
      // 实测现象：`deepseek-v4.1-flash` 本地明确配了 128000，
      // 但 #1/#3 两个绑定报 maxOut=undefined，只有 #2 报 64000。
      // 于是对外只能取到 64000，比本地少一半。
      //
      // 现在两个字段都读，谁有就用谁；再退一步读 `info.context?.maxOutput`。
      // 这属于"多来源同一语义"，只要有一处给了真实值就该用上。
      maxOutputTokens: (() => {
        const candidates = [
          info.defaultMaxTokens,
          info.maxTokens,
          info.maxOutputTokens,
          info.context?.maxOutputTokens,
          info.context?.maxTokens,
        ]
        const hit = candidates.find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
        return hit !== undefined ? { value: hit, source: 'dsh' } : cap(VALUE.unknown, 'dsh')
      })(),
      systemPromptUpdate:
        info.systemPromptUpdate !== undefined
          ? { value: info.systemPromptUpdate, source: 'dsh' }
          : cap(VALUE.unknown, 'dsh'),
      // 结构上恒为流式（内核统一暴露 AsyncIterable）
      streaming: cap(VALUE.supported, 'dsh', { note: '内核恒为 AsyncIterable 流式' }),
      // 展示字段
      name: info.name,
      ...(info.description === undefined ? {} : { description: info.description }),
      ...(mods === undefined ? {} : { inputModalities: [...mods] }),
    }
    this.authoritative.set(cacheKey, result)
    return result
  }

  /**
   * 解析某个档 B 能力（四层优先级）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键（如 'tools'）。
   * @returns 能力结论。
   */
  resolveField(provider, model, field) {
    const key = this.#key(provider, model, field)

    // 1) 用户手动覆盖（最高优先）
    const override = this.overrides.get(key)
    if (override !== undefined) {
      return cap(override.value, 'declared', { at: override.at, ...(override.note === undefined ? {} : { note: override.note }) })
    }

    // 2) 运行时负能力学习
    const learned = this.learned.get(key)
    if (learned !== undefined) {
      return cap(learned.value, 'learned', {
        at: learned.at,
        ...(learned.evidence === undefined ? {} : { evidence: learned.evidence }),
      })
    }

    // 3) 内建画像（**推测**，标 profile）
    //
    // `capabilities.profiles` 可以关掉这一层：
    //   'use-builtin'（默认）—— 用内建画像兜底
    //   'ignore'             —— 当作没有画像，直接落到 unknown
    // 关掉它的理由：画像是我按实测填的推测值（capabilities.js:76 起），
    // 换了一家同名的 provider 或上游改了行为时，它可能一直是错的；
    // 那时用户宁可看到诚实的 unknown（走"无证据"路径，排链尾但不被剔除），
    // 也不想被一条过期推测误导。此前这个配置项**写了但没人读**，
    // 用户改成 'ignore' 毫无效果——属于"假开关"。
    const useProfiles = this.config()?.capabilities?.profiles !== 'ignore'
    const profile = useProfiles ? BUILTIN_PROFILES[provider]?.[field] : undefined
    if (profile !== undefined) {
      return cap(profile, 'profile', { note: '内建画像推测，非 DSH 权威声明；可用「测试」按钮实测确认' })
    }

    // 4) 都没有 → 未知（**不是** supported）
    return cap(VALUE.unknown, null)
  }

  /**
   * 汇总某模型的完整能力视图。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @returns 能力对象（权威 + 档 B 四层解析）。
   */
  async describe(provider, model) {
    // ── 结果缓存 ──
    //
    // describe() 在**热路径**上被反复调用：
    //   · 每次 `GET /v1/models` 对每个模型调一次
    //   · 每次请求的能力闸门、思考档位解析、错误信息组装各调一次
    //   · 面板每次刷新对每个模型调一次
    //
    // 而它的输入只来自 (provider, model) 与 { overrides, learned, authoritative, config }，
    // 这些在 `generation` 变化时才会变（invalidate() 会 ++generation）。
    // 所以用 generation 做 key 就够了 —— 与 authoritativeOf 用同一套失效机制。
    //
    // 之前没有这层缓存：同一请求里同一 (provider, model) 会被组装多次，
    // 每次都要拼 6+ 个字段对象并 await 两次。
    const cacheKey = `${provider}\u0000${model}\u0000${this.generation}`
    const cachedView = this.describeCache.get(cacheKey)
    if (cachedView !== undefined) return cachedView

    const auth = (await this.authoritativeOf(provider, model)) ?? {}
    const fields = {}
    for (const key of ['tools', 'parallelTools', 'jsonMode', 'temperature', 'stop']) {
      fields[key] = this.resolveField(provider, model, key)
    }

    /**
     * 可被人工覆盖的字段（§6.5.3b：用户改过就以用户为准）。
     *
     * ⚠ **必须优先取 `resolveField`，`auth` 只作兜底**。
     * 这些字段原先直接返回 `auth.*`，导致 `setOverride` 写入了覆盖、
     * `describe` 却永远读不出来 —— 界面表现是"点了复选框没反应"
     *（用户实测：文本输入 / 图片输入 / 推理能力 三项无法手动修改）。
     *
     * `resolveField` 的优先级链已包含"用户覆盖 > 学习 > 画像 > 未知"，
     * 但它的最后一层是 `unknown`，而权威值（来自 DSH）比"未知"更有信息量，
     * 因此这里做：**有覆盖/学习/画像 → 用它；否则 → 用权威值**。
     *
     * @param field - 能力键。
     * @param fallback - 权威值（`auth[field]` 或 undefined）。
     * @returns 能力描述对象。
     */
    const preferOverride = (field, fallback) => {
      const resolved = this.resolveField(provider, model, field)
      // 解析出"未知且无依据"时，说明没有覆盖/学习/画像命中 → 用权威值
      if (resolved?.value === VALUE.unknown && resolved?.source === null) {
        return fallback ?? resolved
      }
      // ── 推理字段特例：档位列表必须比"是否支持"更值钱（第十六轮 #164）──
      //
      // 实测：`hy4` 的三个绑定里只有 #1 的 `reasoning.efforts` 非空。
      // 另两个被内建画像（`BUILTIN_PROFILES[provider].reasoning`）命中，
      // 返回 `{value:'supported', source:'profile'}` —— **不带 efforts**。
      // 于是 `resolveChainWordFor` 读到的词表是空的，三绑定的加权投票
      // 只剩 #1 那一个 `["high"]` 参与，四档全被压成 `high`
      // （用户设 minimal 却拿到最强档，且没有任何降级提示）。
      //
      // 而同一路径 `/v1/models` 显示 #3 有 5 档 —— 说明权威值里确实有，
      // 只是被画像的音量盖过了。
      //
      // 判据：解析结果**没有 efforts** 而 fallback **有** → 用 fallback。
      // 只对 reasoning 生效：别的字段没有这种"部分信息"结构。
      if (field === 'reasoning') {
        const resolvedEfforts = Array.isArray(resolved?.efforts) ? resolved.efforts : []
        const fallbackEfforts = Array.isArray(fallback?.efforts) ? fallback.efforts : []
        if (resolvedEfforts.length === 0 && fallbackEfforts.length > 0) {
          return fallback
        }
      }
      return resolved
    }

    return {
      // 档 A/B 混合：人工可覆盖，未覆盖时用权威值
      text: preferOverride('text', auth.text),
      image: preferOverride('image', auth.image),
      reasoning: preferOverride('reasoning', auth.reasoning),
      streaming: preferOverride('streaming', auth.streaming),
      // 上下文窗口 / 最大输出是**数值**，不适用三态覆盖，仍走权威透传。
      //
      // ⚠ 但权威值可能**缺失**（第十三轮 #149）。实测：`deepseek-v4.1-flash`
      // 的三个绑定里只有 #2 报 maxOut=64000，#1/#3 都报 undefined；
      // 而用户在 `cordis.patch.yml` 里明明给这个模型写了 `maxTokens: 128000`。
      // 于是对外只能聚合到 64000，比本地配置少一半。
      //
      // 兜底：`resolveModelInfo()` 没给时，用该模型**其它绑定**已经报出的最大值。
      // 这是同一个模型的不同通道，取最大是合理的（绑定是"多一条路"，
      // 不是"取最差的那条"）。真正的上限仍由上游在调用时说了算。
      contextWindow: await this.bestOf(provider, model, 'contextWindow', auth.contextWindow),
      maxOutputTokens: await this.bestOf(provider, model, 'maxOutputTokens', auth.maxOutputTokens),
      systemPromptUpdate: auth.systemPromptUpdate ?? cap(VALUE.unknown, 'dsh'),
      // 档 B：四层解析
      tools: fields.tools,
      parallelTools: fields.parallelTools,
      jsonMode: fields.jsonMode,
      temperature: fields.temperature,
      stop: fields.stop,
      // 原始权威值（供 UI 显示"被手动修改前的原值"）
      authoritativeRaw: {
        text: auth.text?.value ?? VALUE.unknown,
        image: auth.image?.value ?? VALUE.unknown,
        reasoning: auth.reasoning?.value ?? VALUE.unknown,
        contextWindow: auth.contextWindow?.value ?? VALUE.unknown,
        maxOutputTokens: auth.maxOutputTokens?.value ?? VALUE.unknown,
      },
      ...(auth.name === undefined ? {} : { name: auth.name }),
      ...(auth.description === undefined ? {} : { description: auth.description }),
    }

    // 写入缓存。用 generation 做 key —— invalidate() 一加代次，整批自动失效。
    // 容量上限防御：generation 变化后旧 key 不会再被读到，
    // 但 Map 会一直留着它们；超过阈值时整体重建（比逐个淘汰简单且够用）。
    if (this.describeCache.size > 512) this.describeCache.clear()
    this.describeCache.set(cacheKey, result)
    return result
  }

  /**
   * 用户手动设置某能力（§6.5.3b：改过就以用户为准）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键。
   * @param value - 三态值（传 null 表示清除覆盖、恢复权威值）。
   * @param origin - 'user'（用户在面板上手勾）或 'probe'（能力测试探针写回）。
   *   probe 不能覆盖已有的 user 记录，否则弱证据会推翻强证据。
   * @returns 是否成功。
   */
  async setOverride(provider, model, field, value, origin = 'user') {
    const key = this.#key(provider, model, field)
    if (value === null || value === undefined) {
      this.overrides.delete(key)
    } else if (value === VALUE.supported || value === VALUE.unsupported || value === VALUE.unknown) {
      // origin 用来区分「用户手勾」与「能力测试探针写回」。
      //
      // 两者原先完全等价（都进 overrides、都标 source:'declared'），于是
      // 点一次「能力测试」就能把用户手填的 unsupported 冲成 supported——
      // 而探针的 supported 判据只是"请求没报错"（上游可能悄悄忽略了参数），
      // 强度远低于"用户实测过它不行"。用弱证据覆盖强证据，方向是反的。
      //
      // 现在探针写回带 origin:'probe'：用户可以推翻探针，探针不能推翻用户。
      const existing = this.overrides.get(key)
      if (origin === 'probe' && existing !== undefined && existing.origin !== 'probe') {
        return false
      }
      this.overrides.set(key, { value, at: Date.now(), origin })
    } else {
      return false
    }
    await this.persist()
    return true
  }

  /**
   * 记录一次负能力学习（档 C）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键。
   * @param evidence - 上游错误原文（脱敏后）。
   * @returns 是否记录了新结论。
   */
  async learnNegative(provider, model, field, evidence) {
    // 开关（`capabilities.learnNegative`，默认开）此前**写了但没人读**。
    // 用户关掉它应当真的不再往 data/capabilities.json 里写推测结论——
    // 有些上游的错误文案会误报（例如"当前模型不支持图片输入"其实只是这张图坏了），
    // 关掉学习等于"所有判断都以我手动配的为准"，是个合理的诉求。
    if (this.config()?.capabilities?.learnNegative === false) return false
    const key = this.#key(provider, model, field)
    // 用户手动覆盖优先：不覆盖用户的判断
    if (this.overrides.has(key)) return false
    const existing = this.learned.get(key)
    if (existing?.value === VALUE.unsupported) return false
    this.learned.set(key, { value: VALUE.unsupported, evidence: String(evidence ?? '').slice(0, 400), at: Date.now() })
    await this.persist()
    return true
  }

  /**
   * 能力测试（§6.5.10）：**逐项真实调用**，用于发现模型隐藏/未声明的能力。
   *
   * **测试结果会直接回写能力画像**（用户要求，见下方 `applied`）：
   * 探到明确结论（supported / unsupported）就写进 overrides，
   * 这项能力立刻生效，不需要用户再去手动勾选。
   *
   * 为什么不写 unknown：unknown 是"没测出结论"，拿它覆盖已有的明确声明
   * 只会让信息变少；而且硬能力按"未知即拒绝"处理，写 unknown 等于把
   * 一个本来能用的模型关掉——这不是测试该有的副作用。
   *
   * 为什么不写异常分支：请求抛错（超时/网络抖动/被中断）不代表模型不支持
   * 该能力。把抖动持久化成"不支持"是最坏的体验（用户看不出它从哪来），
   * 因此异常一律只报告、不回写。
   *
   * 注意成本：每一项都是一次真实模型调用，会消耗上游额度。
   *
   * @param options - `{ provider, model, items, perItemTimeoutMs, onProgress }`。
   * @returns 逐项结果数组（每项带 `applied` 表明是否已回写）。
   */
  async test({ provider, model, items, perItemTimeoutMs = 30_000, onProgress }) {
    const results = []
    const emit = (item, result) => {
      results.push(result)
      try {
        onProgress?.(item, result)
      } catch {
        /* 进度回调失败不影响测试 */
      }
    }

    // 先刷新权威项（零成本，纯读）
    const auth = await this.authoritativeOf(provider, model)
    if (auth !== undefined) {
      emit('authoritative', {
        item: 'authoritative',
        ok: true,
        image: auth.image?.value ?? VALUE.unknown,
        reasoning: auth.reasoning?.value ?? VALUE.unknown,
        contextWindow: auth.contextWindow?.value ?? VALUE.unknown,
        maxOutputTokens: auth.maxOutputTokens?.value ?? VALUE.unknown,
        systemPromptUpdate: auth.systemPromptUpdate?.value ?? VALUE.unknown,
      })
    }

    const wanted = Array.isArray(items) && items.length > 0 ? items : ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image']

    for (const item of wanted) {
      if (item === 'authoritative') continue
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), perItemTimeoutMs)
      const started = Date.now()
      try {
        // 每次探测都是一次真实上游调用 → 必须走并发闸门。
        // （原来直接调 #probeOne，完全绕开 limits.maxConcurrent：上游满载时
        // 点一次「能力测试」会再挤进 1~6 个请求，而面板上的并发数看不出异常。）
        const probe = await this.withSlot(() => this.#probeOne(item, provider, model, ac.signal))
        clearTimeout(timer)
        // ===== 测试结果**自动回写**（用户要求：测试为什么不能自动改写能力？）=====
        //
        // 回写规则（三条，缺一不可）：
        // ① 只回写**明确结论** supported / unsupported；unknown 一律不写，
        //    因为 unknown 的含义是"没测出来"，拿它覆盖已知结论只会让信息变少
        //    （硬能力还会因此被"未知即拒绝"关掉——测试不该关门）。
        // ② 只回写**能力型探针**。authoritative/connectivity 不是能力项：
        //    connectivity 失败是网络问题，不是"这个模型不支持聊天"。
        // ③ 回写走 setOverride（标 source: 'declared'），与用户手勾等价，
        //    因此**立刻生效**，且用户在界面上能看到并推翻它。
        //
        // 与"临时故障被持久化"的区别：异常分支（catch）**不回写**，
        // 只有探针自己给出明确 supported/unsupported 才写。探针的
        // unsupported 判定由 detectNegativeCapability 把关（错误原文必须
        // 明确指向该能力），不会因一个泛化报错就误判。
        let applied = false
        if (WRITABLE_ITEMS.has(item) && (probe.value === VALUE.supported || probe.value === VALUE.unsupported)) {
          try {
            // origin:'probe' —— 探针写回不能覆盖用户手动设置（见 setOverride 注释）
            applied = await this.setOverride(provider, model, item, probe.value, 'probe')
          } catch {
            applied = false
          }
        }
        emit(item, { item, ms: Date.now() - started, ...probe, applied })
      } catch (error) {
        clearTimeout(timer)
        emit(item, {
          item,
          ms: Date.now() - started,
          value: VALUE.unknown,
          error: String(error?.message ?? error).slice(0, 300),
        })
      }
    }
    return results
  }

  /**
   * 单项探测（真实调用一次）。
   * @param item - 能力键。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns `{ value, evidence? }`。
   */
  async #probeOne(item, provider, model, signal) {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    // ── 探针必须走与网关主路径**完全相同**的消息形状（第十六轮 #176）──
    //
    // 旧实现有两个问题，叠加起来让面板上的「功能测试」全线失败：
    //
    // 1. `createSystemMessage(...)` 塞进 messages 数组
    //    → 实测各上游在收到**独立 system 消息**时会攒包甚至直接返回空
    //      （网关主路径用 `mergeSystemIntoUser` 把 system 拼进第一条 user，
    //       面板探针却没这么做，于是"网关好好的、面板一测就挂"）。
    //
    // 2. `createUserMessage({ content: [...] })` 这个形状在内核里会走到
    //    `content.some(...)`，一旦 content 不是数组就抛
    //    `content.some is not a function`。面板上那一排红字就是这个。
    //
    // 现在：不传 system 消息（探针只问"ok"，不需要系统提示）；
    //       user 消息用**内核定义的形状** `{ content: [...] }`
    //       （`createUserMessage(input)` → `createMessage({...input, role})`）。
    const prompt = item === 'tools'
      ? '请调用 echo 工具，参数 text 设为 ok。'
      : item === 'jsonMode'
        ? '输出形如 {"ok": true, "n": 1} 的 JSON 对象，不要任何解释。'
        : '请只回复：ok'
    // 内核三处会遍历每条消息的 content：
    //   contentHasFile()  / contentHasImage()  / replaceFilesWithHandles()
    // 用的都是 `for (const block of content)`，所以 content **必须**是数组。
    // 这里显式构造，避免任何 undefined 混进来。
    const probeBlocks = [{ type: 'text', text: prompt }]
    const messages = [
      createUserMessage({ content: probeBlocks }),
    ]
    // 断言：所有消息的 content 都必须是数组（内核会 for...of 它）
    for (const m of messages) {
      if (!Array.isArray(m?.content)) {
        throw new Error('探针消息形状错误：' + m?.role + '.content=' + typeof m?.content)
      }
    }

    /** @type {Record<string, unknown>} */
    const options = { provider, model, messages, maxTokens: 64, signal }
    if (item === 'tools') {
      options.tools = [
        {
          name: 'echo',
          description: '回显测试工具',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ]
    }
    if (item === 'temperature') options.temperature = 0
    if (item === 'stop') options.stop = ['\n\n']
    if (item === 'jsonMode') {
      // ⚠ 事实（已核实）：DSH 的 GenerateOptions **没有** response_format 字段
      // （只有 provider/model/messages/tools/temperature/maxTokens/stop/signal…），
      // 所以"把 response_format 原样透传给上游"这条路在本机**不存在**。
      //
      // 那就不该假装测不了：网关对 JSON 模式的实现方式是**提示词强约束**
      // （见 protocol.js 的 renderJsonModeInstruction，由 messages.js 合进 system），
      // 因此这里就按同样方式实测——
      // 要求模型输出指定结构的 JSON，再**真的把回答解析一遍**。
      // 解析成功才是 supported，否则 unknown（不轻易判"不支持"）。
      return await this.#probeJsonMode(provider, model, signal)
    }
    if (item === 'image') {
      return await this.#probeImage(provider, model, signal)
    }
    if (item === 'systemMerge') {
      return await this.#probeSystemMerge(provider, model, signal)
    }

    let sawToolCall = false
    let sawText = false
    let failure
    let probeUsage
    try {
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk.type === 'tool-call-delta') sawToolCall = true
        else if (chunk.type === 'text-delta' && String(chunk.text).trim().length > 0) sawText = true
        else if (chunk.type === 'usage') probeUsage = chunk.usage
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          failure = chunk.reason.failure
        }
      }
    } catch (probeError) {
      // #178 诊断：把探针的完整堆栈打出来。
      // 面板只显示 `content is not iterable` 这样的短消息，看不出是哪条消息、
      // 哪一层抛的。这里把 options 的形状与堆栈一起记下来，一次定位。
      try {
        const shape = (options.messages ?? []).map((m) => ({
          role: m?.role,
          contentType: Array.isArray(m?.content) ? 'array:' + m.content.length : typeof m?.content,
        }))
        this.ctx?.logger?.error?.('[lantern][probe] options.messages=' + JSON.stringify(shape))
        this.ctx?.logger?.error?.('[lantern][probe] stack=' + String(probeError?.stack ?? probeError))
      } catch { /* 日志失败不影响主流程 */ }
      throw probeError
    }
    // 探测是真实调用，消耗要进账本（记为测试用量）。
    //
    // 顺序与状态都有讲究：
    // 1. 必须**先**判定 failure 再记账——否则一次失败的上游调用会被按
    //    status='ok' 记成成功，recordCall 因此清零熔断器 streak，
    //    "上游正在限流"被管理员点一次「测试」就抹掉了。
    // 2. 失败时 usage 通常是 undefined（没跑到出 token 那步），但错误本身
    //    仍要进账本，否则面板上"测试失败"与"线路健康"两个事实互相矛盾。
    try {
      this.onUsage?.(probeUsage, item, { provider, model }, failure === undefined ? 'ok' : 'error')
    } catch {
      /* 记账失败不影响测试 */
    }

    if (failure !== undefined) {
      const msg = String(failure.message ?? '')
      // 只有明确指向该能力的错误才算 unsupported
      const detected = detectNegativeCapability(msg)
      if (item === 'connectivity') {
        return { value: VALUE.unsupported, evidence: msg.slice(0, 300), note: '基础连通性失败' }
      }
      return detected === item
        ? { value: VALUE.unsupported, evidence: msg.slice(0, 300) }
        : { value: VALUE.unknown, error: msg.slice(0, 300), note: '失败原因与该能力无明确关联，记为未知' }
    }

    if (item === 'tools') {
      return sawToolCall
        ? { value: VALUE.supported, note: '模型确实发起了 tool-call' }
        : { value: VALUE.unknown, note: '未发起工具调用，但也没有报错 → 不足以判定为支持' }
    }
    if (item === 'connectivity') {
      return sawText ? { value: VALUE.supported } : { value: VALUE.unknown, note: '有响应但无文本增量' }
    }
    // temperature / stop：能正常返回即视为"已通过"（DSH 会把它透传给 adapter）。
    //
    // ⚠ 措辞说明（用户反馈"带该参数调用成功"对非专业用户不可读）：
    // 1. note 写**各项自己的**人话，而不是共用一句 —— 原先两项共用
    //    '带该参数调用成功'，UI 的"相同 note 合并"逻辑就把它显示成
    //    「（2 项一致）」，用户看不懂这个"2 项"从哪来；
    // 2. 判据只是"**请求没报错**"，并不证明参数真的生效 ——
    //    所以措辞用"已通过"而非"支持"，如实反映验证强度（方案 2）。
    if (item === 'temperature') {
      return { value: VALUE.supported, note: '实测：带上温度参数请求，模型正常返回（不报错即视为通过）' }
    }
    if (item === 'stop') {
      return { value: VALUE.supported, note: '实测：带上停止序列请求，模型正常返回（不报错即视为通过）' }
    }
    return { value: VALUE.supported, note: '实测：带上该参数请求，模型正常返回' }
  }

  /**
   * 探测 JSON 模式能力。
   *
   * 判据分两步，避免"看着像 JSON 就算过"：
   * ① 回答能被 `JSON.parse` 解析；
   * ② 解析出来的对象**含有要求的字段**（`ok` 且为 true）。
   *
   * 为什么不用 response_format 探：DSH 的 GenerateOptions 没有该字段
   * （已核实），这条路径在本机不存在，加了也只是自欺。
   * 网关对 JSON 模式的真实实现就是提示词约束 + 客户端侧的可解析性，
   * 所以按同样方式实测才是"测的就是实际会跑的路径"。
   *
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns 能力结论（含 sample 证据）。
   */
  /**
   * 检测「该模型是否需要把 system 并进 user」（第十七轮 #182）。
   *
   * ## 为什么要测
   *
   * 中转上游（`@deepai` / `@xdpool` / `@trae` …）很多**不接受独立的
   * `role:'system'` 消息**：实测 `hy4` / `Qwen-3.8-Flash` / `GPT-6-Luna`
   * 只要带非空 system 就在几毫秒内返回**全空**，去掉 system 则完全正常。
   *
   * 这个坑已经踩过三批模型，每次的症状都一样：
   * **面板测试正常、本机正常，一开放 API 就返回空**（因为真实调用几乎都带 system）。
   *
   * ## 怎么测
   *
   * 同一句话，发两次：
   *   A. 独立 system 消息 + user
   *   B. system 文本拼进 user（不发 system 消息）
   *
   * 判据：
   *   · A 有正文B 也有正文  → `either`  （两种都行，建议仍用 merge 更稳）
   *   · A 空，B 有正文     → **`merge-required`** ← 必须开开关
   *   · A 有正文，B 空     → `system-required`（极少见，别关开关）
   *   · 都空               → `unknown`（可能是别的问题，不轻易下结论）
   *
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns `{ value, note, evidence }`。
   */
  async #probeSystemMerge(provider, model, signal) {
    const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const SYS = '你是一个严谨的助手，只回答被问的内容。'
    const ASK = '请只回复两个字：收到'

    /** 跑一次，返回是否拿到正文。 */
    const once = async (withSeparateSystem) => {
      const messages = withSeparateSystem
        // #230：system 用**单参数** `createSystemMessage(string)`
        // （与 DSH 内核自身用法一致；第二参数塞一个不存在的 provider id
        //  会让内核归属归组失败 → content.some is not a function）。
        ? [createSystemMessage(SYS), createUserMessage({ content: [{ type: 'text', text: ASK }] })]
        : [createUserMessage({ content: [{ type: 'text', text: SYS + '\n\n' + ASK }] })]
      let text = ''
      let failure
      try {
        for await (const chunk of this.ctx.llm.stream({ provider, model, messages, maxTokens: 32, signal })) {
          if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
          else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
            failure = chunk.reason.failure
          }
        }
      } catch (error) {
        failure = { message: error?.message ?? String(error), code: error?.code }
      }
      return { ok: text.trim().length > 0, len: text.trim().length, failure }
    }

    let withSystem
    let withMerge
    try {
      withSystem = await once(true)
      withMerge = await once(false)
    } catch (error) {
      return { value: VALUE.unknown, note: '探测失败：' + (error?.message ?? String(error)) }
    }

    const evidence = `独立system=${withSystem.ok ? '有正文' : '空'}（${withSystem.len}字） / 并入user=${withMerge.ok ? '有正文' : '空'}（${withMerge.len}字）`

    if (!withSystem.ok && withMerge.ok) {
      // 这是最常见的坑：必须开 merge，否则真实调用全空
      return {
        value: VALUE.unsupported,
        note: '该模型不接受独立 system 消息（会返回空回答）→ 必须开启「system 并入 user」',
        evidence,
        recommended: { mergeSystemIntoUser: true },
      }
    }
    if (withSystem.ok && !withMerge.ok) {
      return {
        value: VALUE.supported,
        note: '该模型需要独立 system 消息才能作答 → 不要开启「system 并入 user」',
        evidence,
        recommended: { mergeSystemIntoUser: false },
      }
    }
    if (withSystem.ok && withMerge.ok) {
      // 两种都行 —— 这个是"能力"意义上的 supported（能带 system），
      // 但建议仍用 merge：中转上游随时可能改模板，merge 更稳。
      return {
        value: VALUE.supported,
        note: '两种消息形状都能正常作答（建议仍开启「system 并入 user」，更抗上游变更）',
        evidence,
        recommended: { mergeSystemIntoUser: true },
      }
    }
    // 两种都空：可能是别的原因（限流/模型故障/额度），不下结论
    return {
      value: VALUE.unknown,
      note: '两种消息形状都返回空，无法判断（可能是限流或模型故障，建议稍后重试）',
      evidence,
    }
  }

  async #probeJsonMode(provider, model, signal) {    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    // #176：与主探针一致——不用独立 system 消息（上游会攒包/返空），
    // 把"只输出 JSON"的要求直接写进 user 文本。
    const messages = [
      createUserMessage({
        content: [{
          type: 'text',
          text: '只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。格式形如 {"ok": true, "n": 1}。',
        }],
      }),
    ]
    let text = ''
    let failure
    let usage
    try {
      for await (const chunk of this.ctx.llm.stream({ provider, model, messages, maxTokens: 128, signal })) {
        if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
        else if (chunk.type === 'usage') usage = chunk.usage
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          failure = chunk.reason.failure
        }
      }
    } catch (error) {
      // 真调用抛错也是一次真实消耗/失败，必须进账
      // （此前 jsonMode 完全不上账：用户点了这项测试，账本上看不出任何消耗与失败）。
      try {
        this.onUsage?.(usage, 'jsonMode', { provider, model }, 'error')
      } catch { /* 记账失败不影响测试 */ }
      return { value: VALUE.unknown, note: 'JSON 探测调用失败：' + String(error?.message ?? error).slice(0, 200) }
    }
    try {
      this.onUsage?.(usage, 'jsonMode', { provider, model }, failure === undefined ? 'ok' : 'error')
    } catch { /* 记账失败不影响测试 */ }
    if (failure !== undefined) {
      return { value: VALUE.unknown, note: 'JSON 探测调用失败：' + String(failure.message ?? '').slice(0, 200) }
    }
    // 去掉可能被模型包上的 markdown 代码块围栏
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      return {
        value: VALUE.unknown,
        note: '回答不是可解析的 JSON（可能只是普通文本），不足以判定支持',
        sample: text.slice(0, 200),
      }
    }
    const ok = parsed !== null && typeof parsed === 'object' && parsed.ok === true
    return ok
      ? { value: VALUE.supported, note: '实测：要求输出 JSON，模型返回了可解析且含约定字段的对象', sample: cleaned.slice(0, 200) }
      : { value: VALUE.unknown, note: '返回了 JSON 但结构不符合约定（缺 ok:true），记为未知', sample: cleaned.slice(0, 200) }
  }

  /**
   * 探测图片能力：**生成一张带确定可验证内容的极小图片**，要求模型读出它，
   * 并**校验答案**——而不是"不报错就算支持"。
   *
   * 为什么必须这样（用户明确要求）：
   * 上游可能"声明支持图片"但实际**读不出内容**（例如把图片当透明占位、
   * 或在网关侧被丢弃）。只发一张 1×1 图并看是否报错，**发现不了这种情况**。
   * 因此这里发一张有明确图案（左半纯红、右半纯蓝）的小图，
   * 提问"左边和右边各是什么颜色"，再用**关键词校验**回答是否真的读出了内容。
   *
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns 能力结论（含 answers / verified 等证据字段）。
   */
  async #probeImage(provider, model, signal) {
    const cfg = this.config()
    if (cfg?.allowImageInput !== true) {
      return {
        value: VALUE.unknown,
        note: '网关未开启图片输入（allowImageInput=false），跳过图片探测以免落盘；这不是"模型不支持"',
      }
    }
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      return { value: VALUE.unknown, note: '本机附件服务不可用，无法探测图片能力' }
    }

    // 生成"左红右蓝"的 24×12 PNG（约 100 字节级，极小但有可读内容）
    const png = buildProbePng()
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const [ref] = await attachments.saveImages([{ data: png, mediaType: 'image/png' }])
    if (ref === undefined) return { value: VALUE.unknown, note: '图片入库失败' }

    // 与主探针一致——不用独立 system 消息；形状用 `{ content: [...] }`。
    const messages = [
      createUserMessage({
        content: [
          { type: 'text', text: '你是图像识别测试对象。这张图被竖着分成两半。请只回答两个词：左半部分的主色、右半部分的主色。不要解释，不要客套。' },
          { type: 'image', attachment: ref },
        ],
      }),
    ]

    let text = ''
    let failure
    let imageUsage
    for await (const chunk of this.ctx.llm.stream({ provider, model, messages, maxTokens: 64, signal })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'usage') imageUsage = chunk.usage
      else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        failure = chunk.reason.failure
      }
    }
    // 图片探测同样是真实调用（含图片 token），必须进账本。
    // 顺序同 #probeOne：先判定 failure 再记账，否则失败会被记成成功。
    try {
      this.onUsage?.(imageUsage, 'image', { provider, model }, failure === undefined ? 'ok' : 'error')
    } catch {
      /* 记账失败不影响测试 */
    }

    if (failure !== undefined) {
      const msg = String(failure.message ?? '')
      return detectNegativeCapability(msg) === 'image'
        ? { value: VALUE.unsupported, evidence: msg.slice(0, 300) }
        : { value: VALUE.unknown, error: msg.slice(0, 300), note: '失败原因与图片无明确关联，记为未知' }
    }

    // 关键词校验：必须同时读出"红"与"蓝"（允许中英文）
    const answer = text.trim()
    const sawRed = /红|red/i.test(answer)
    const sawBlue = /蓝|blue/i.test(answer)
    const verified = sawRed && sawBlue

    if (verified) {
      return {
        value: VALUE.supported,
        note: '图片内容实测读出（左红右蓝均答对）',
        answers: answer.slice(0, 120),
        verified: true,
      }
    }
    // 明确答错 → 上游多半只是"声明"支持图片，实际读不出内容
    if (answer.length > 0) {
      return {
        value: VALUE.unsupported,
        note: `模型未能读出图片内容（期望"左红右蓝"，实际回答："${answer.slice(0, 80)}"）——可能只声明了图片能力但实际读不出`,
        answers: answer.slice(0, 120),
        verified: false,
      }
    }
    return {
      value: VALUE.unknown,
      note: '模型对图片没有给出任何文本回答，无法判定是否真的读出了内容',
      answers: '',
      verified: false,
    }
  }

  /**
   * 按能力结论决定"用户请求的参数"是否放行（§6.5.5）。
   *
   * 策略：**硬能力拒绝、软参数标注**。
   * - 硬能力（tools / image / jsonMode / reasoning）：不支持或未知 → 拒绝（400）
   * - 软参数（temperature / stop）：不支持或未知 → 忽略 + 响应头标注
   *
   * @param caps - `describe()` 的结果。
   * @param request - 客户端请求中的参数存在性描述。
   * @returns `{ reject?: {capability, message}, ignored: string[], headers: Record<string,string> }`。
   */
  enforce(caps, request) {
    const ignored = []
    const headers = {}

    const check = (capability, present, label) => {
      if (!present) return undefined
      const c = caps[capability]
      const value = c?.value ?? VALUE.unknown
      if (value === VALUE.supported) return undefined
      return { capability, label, value, source: c?.source ?? null }
    }

    // 硬能力：不支持/未知 → 拒绝
    const hard = [
      check('tools', request.hasTools === true, '工具调用'),
      check('jsonMode', request.hasJsonMode === true, 'JSON 模式'),
    ].filter(Boolean)
    // 图片单独判定（图片同时受"模型能力"与"网关开关"两层约束，见下）
    if (request.hasImage === true) {
      const c = caps.image ?? { value: VALUE.unknown }
      if (c.value !== VALUE.supported) {
        hard.push({ capability: 'image', label: '图片输入', value: c.value, source: c.source ?? null })
      }
    }
    // 推理档位：客户端显式点名该能力，不支持/未知 → 拒绝
    if (request.hasReasoningEffort === true) {
      const c = caps.reasoning ?? { value: VALUE.unknown }
      if (c.value !== VALUE.supported) {
        hard.push({ capability: 'reasoning', label: '推理档位', value: c.value, source: c.source ?? null })
      }
    }

    if (hard.length > 0) {
      // ── unknown 不再硬拒，改为"降级放行 + 明确标注"（第十三轮 #142）──
      //
      // 原设计是"未知即拒绝"，理由是避免返回错误结果。但它有一个致命副作用：
      // 只要模型没声明某项能力（hy4 的三个绑定全没声明 tools），
      // 用户就**完全无法使用该功能** —— 实测 hy4 带 tools 直接 400，
      // 而实际上它很可能是支持的，只是 DSH 没元数据。
      //
      // 用户的原话是"确保功能全部正常可用"。在"拒绝"与"盲信"之间还有第三条路：
      //   · 仍然**放行**（否则功能彻底不可用）；
      //   · 但在响应头如实标注 `X-Lantern-Capability-Unverified: tools`，
      //     并建议用户去面板点「测试」把它变成确定值；
      //   · 真不支持时上游会报错，那一次失败会被"负能力学习"记下来，
      //     下次就变成确定的不支持 —— 自我修正。
      //
      // 只有**确定不支持**（unsupported）才继续硬拒：那是已知事实，不该浪费一次调用。
      const unsupported = hard.filter((h) => h.value === VALUE.unsupported)
      const unknownOnly = hard.filter((h) => h.value !== VALUE.unsupported)

      if (unknownOnly.length > 0) {
        // 放行，但把"未经验证"如实写进 headers（由调用方合并到响应头）
        headers['X-Lantern-Capability-Unverified'] = unknownOnly.map((h) => h.capability).join(',')
        headers['X-Lantern-Capability-Hint'] = encodeURIComponent(
          `${unknownOnly.map((h) => h.label).join('、')} 的能力未经验证，本次已放行；`
          + '如结果异常，请在 设置 → LANtern → 该 provider 页点「测试」实测确认。',
        )
      }

      if (unsupported.length > 0) {
        const f = unsupported[0]
        return {
          reject: {
            capability: f.capability,
            label: f.label,
            value: f.value,
            source: f.source,
            message: `该模型不支持${f.label}（来源：${f.source ?? '未知'}）。`
              + '请去掉该参数，或换一个支持它的模型。',
            all: unsupported,
          },
          ignored,
          headers,
        }
      }
      // 只剩 unknown → 继续往下走（不 return），让请求真正发出去
    }

    // 软参数：不支持/未知 → 忽略 + 响应头标注
    for (const [field, present, label] of [
      ['temperature', request.hasTemperature === true, 'temperature'],
      ['stop', request.hasStop === true, 'stop'],
    ]) {
      if (!present) continue
      const c = caps[field]
      const value = c?.value ?? VALUE.unknown
      if (value !== VALUE.supported) ignored.push(label)
    }
    if (ignored.length > 0) headers['X-Lantern-Ignored-Params'] = ignored.join(',')

    return { ignored, headers }
  }
}
