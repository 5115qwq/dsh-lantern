/**
 * dsh-lantern — 模型目录层（Host 半部内部模块）。
 *
 * 职责：
 * 1. **全量枚举** DSH 已注册的 provider 与其模型（只读，不触碰任何状态）；
 * 2. **动态跟随** provider 增删：订阅 `llm/adapters-updated`，去抖后重建；
 * 3. **全名制命名**：公开名一律 `<model>@<slug(provider)>`（设计方案 §5，
 *    唯一提供者也不省略后缀）→ 名字只依赖 (model, provider)，**永不漂移**；
 * 4. **显示规则**（§4.4，官方与第三方**完全统一**）：
 *    未注册 / 无模型 / 被过滤 → 对局域网隐藏；**不做凭据探测**，
 *    缺 key 由上游在调用时报 MISSING_CREDENTIAL，经错误原样呈现如实告知。
 *
 * 全部为只读查询：listProviders / listModels / resolveModelInfo。
 *
 * @module dsh-lantern/directory
 */
import { createHash } from 'node:crypto'

/** 去抖：合并突发变化。 */
const REFRESH_DEBOUNCE_MS = 250
/** 最短刷新间隔：防抖风暴。 */
const REFRESH_MIN_INTERVAL_MS = 1000
/** 兜底轮询：事件可能被漏（消费者失败被隔离），低频保险。 */
const FALLBACK_POLL_MS = 60_000

/**
 * provider 路由 id → slug。
 * 只保留 `[a-z0-9-]`，小写化，超长截断到 24 字符。
 *
 * ⚠ 这是**有损**映射，不是单射：`a.b` / `a-b` / `a/b` / `A_B` / `a b` 都会得到
 * `a-b`；纯中文 id 全部落到兜底常量 `provider`；超过 24 字符的 id 按前缀截断。
 * 所以它只能当**候选**用，真正对外发布的 slug 必须经过 {@link assignSlugs}
 * 消歧（否则 `/v1/models` 会出现两行同名，其中一行永远调不到）。
 *
 * @param providerId - provider 路由 id。
 * @returns 稳定且只含安全字符的 slug 候选。
 */
export function slugOf(providerId) {
  const cleaned = String(providerId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned.length > 0 ? cleaned : 'provider').slice(0, 24)
}

/**
 * 给一组 provider 分配**互不相同**的 slug。
 *
 * 为什么必须有这一步：`slugOf` 是多对一的。早先目录直接用 `slugOf` 当对外名，
 * 于是两个 provider 撞 slug 时 `byPublic.set` 是**后写覆盖前写**——
 * `/v1/models` 里两行 id 一模一样，`resolve()` 只能命中后写的那家，
 * 而 `providerBySlug()` 撞车时返回 undefined，于是那个名字既"调不到"
 * 又"调错了家在解释上说不通"，`diagnostics()` 还报一切正常（完全静默）。
 *
 * 消歧规则（对唯一者**零影响**，只在撞车组里动）：
 * - 唯一组 → 直接用它自己的候选 slug（今天的行为不变）；
 * - 撞车组 → 每个成员都加一段由 provider id 派生的短哈希后缀
 *   `a-b-<hash4>`。用哈希而不是 `-2/-3` 序号，是因为序号取决于"当前有哪些
 *   provider"，某家下线后另一家的公开名会跟着漂移——公开名一旦漂移，
 *   已经配好的客户端就会 404。
 *
 * @param providerIds - provider 路由 id 数组。
 * @returns `Map<providerId, slug>`，每个值都不相同且满足 `^[a-z0-9-]+$`。
 */
export function assignSlugs(providerIds) {
  const bases = new Map()
  const groups = new Map()
  for (const id of providerIds) {
    const base = slugOf(id)
    bases.set(id, base)
    const group = groups.get(base)
    if (group === undefined) groups.set(base, [id])
    else group.push(id)
  }
  const out = new Map()
  const used = new Set()
  for (const [base, members] of groups) {
    if (members.length === 1) {
      out.set(members[0], base)
      used.add(base)
    }
  }
  // 撞车组统一改名：谁都不保留裸 slug，避免"看起来有主"的那家被误认为唯一正主
  for (const [base, members] of groups) {
    if (members.length === 1) continue
    for (const id of members) {
      const digest = createHash('sha1').update(String(id), 'utf8').digest('hex').slice(0, 4)
      // 24 是 slug 的软上限；撞车时保后缀比保前缀更有价值，所以先截前缀再加后缀
      let slug = `${base.slice(0, 19)}-${digest}`
      for (let n = 2; used.has(slug); n += 1) slug = `${base.slice(0, 17)}-${digest}-${n}`
      used.add(slug)
      out.set(id, slug)
    }
  }
  return out
}

/**
 * 模型公开名（全名制）。模型名含 `@` 时转义为 `@@`。
 *
 * @param modelId - 上游模型 id。
 * @param providerId - provider 路由 id。
 * @param slug - 可选的已消歧 slug（{@link assignSlugs} 的结果）。
 *   不传时退回 `slugOf(providerId)`——只有"这个 provider id 一定不会撞车"
 *   的调用方（单测、外部工具）才该省略它；目录内部一律显式传，
 *   否则会拼出与 `/v1/models` 不一致的名字。
 * @returns `<model>@<slug>` 形式的公开名。
 */
export function publicNameOf(modelId, providerId, slug) {
  const suffix = typeof slug === 'string' && slug.length > 0 ? slug : slugOf(providerId)
  return `${String(modelId).replace(/@/g, '@@')}@${suffix}`
}

/**
 * 从公开名反解出 slug（宽松路由用，§4.3）。
 * @param publicName - 客户端传来的 model 字段。
 * @returns `{ model, slug }`，无法解析时返回 undefined。
 */
export function parsePublicName(publicName) {
  const text = String(publicName)
  const at = text.lastIndexOf('@')
  if (at <= 0 || at === text.length - 1) return undefined
  const model = text.slice(0, at).replace(/@@/g, '@')
  const slug = text.slice(at + 1)
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined
  return { model, slug }
}

/**
 * 模型目录：枚举 + 动态刷新 + 全名制映射 + 显示规则。
 */
export class ModelDirectory {
  /**
   * @param ctx - Host 插件上下文（需要 `llm` 服务）。
   * @param config - 配置读取器（返回当前配置快照的函数）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** 公开名 → { provider, model } */
    this.byPublic = new Map()
    /** provider → 被隐藏的原因（对局域网隐藏，但对管理员可见，§4.4.2） */
    this.hidden = new Map()
    /** provider → 模型条目数（诊断用） */
    this.counts = new Map()
    this.lastRefreshAt = 0
    this.refreshing = undefined
    this.timer = undefined
    this.debounceTimer = undefined
    this.disposed = false
    /** 刷新期间是否又有新的变化（结束后需补一轮）。 */
    this.refreshDirty = false
    /** 过滤器 Set 缓存（按 filters 对象引用失效，见 isPubliclyAllowed）。 */
    this.filterCache = undefined
    // #199：provider id 列表的指纹，用于"目录没变就跳过整轮刷新"。
    this.lastProviderFingerprint = undefined
    // #199：entries 初值（schedule 里会读 .length 判断是否已有数据）。
    this.entries = []
    /** 已排序的条目缓存（list() 直接返回它，避免重复排序）。 */
    this.sorted = []
  }

  /** 启动订阅与兜底轮询。 */
  start() {
    // ★ 动态发现：provider 增删/替换都会触发（含 registration.replace()）
    //
    // ⚠ 必须保存 `ctx.on` 的返回值：Cordis 的 `ctx.on()` 返回一个**取消订阅函数**，
    // 不调用它监听器会一直挂在 ctx 上。插件禁用/重载后旧实例的闭包无法回收，
    // 重载 N 次就累积 N 个监听器 —— 表现为「改了配置没生效」「日志重复打印」
    // 这类查不出根因的怪现象。
    //
    // 早期版本只清定时器、不清监听器（dispose 里没有 off），是漏的。
    this.stopAdaptersUpdated = this.ctx.on('llm/adapters-updated', () => this.schedule())

    // ★★ 模型级变化：**必须单独订阅**，否则「新增模型」不会及时出现。
    //
    // DSH 有两类不同的变更，触发两个不同的事件（源码核实）：
    //
    //   llm/adapters-updated  —— provider 增删 / 替换（适配器装配层变化）
    //   llm/models-updated    —— **某个 provider 的模型清单或显示信息变了**
    //                            签名：`(provider: string) => void`
    //                            源码：`changed: () => ctx.emit('llm/models-updated', provider)`
    //
    // 早期版本只订阅了前者。后果：在 Hub 里给已有 provider 添加模型时，
    // provider 列表没变 → `adapters-updated` 不触发 → 目录不重建 →
    // **用户看不到新模型**，必须等 60 秒的兜底轮询，或者去设置里
    // 「添加接口」让 provider 变化来"撞"一次刷新。
    //
    // 现在两个都订阅。事件带 provider id，但我们不做增量更新（目录重建
    // 本身很轻，且 slug 分配需要全局视角），统一走去抖后的全量刷新。
    this.stopModelsUpdated = this.ctx.on('llm/models-updated', () => this.schedule())

    this.timer = setInterval(() => this.schedule(true), FALLBACK_POLL_MS)
    this.timer.unref?.()
    return this.refresh()
  }

  /**
   * 去抖 + 最短间隔地安排一次刷新。
   *
   * @param fromPoll - 是否由兜底轮询调用（`true` 时强制刷新）。
   *
   * ## 为什么轮询必须强制刷新
   *
   * #199 加的「provider 指纹短路」是为了省 CPU：目录结构没变就不重建。
   * 但它有个副作用 —— 指纹只看 **provider id 列表**，而
   * 「给已有 provider 新增/删除模型」**不改变这个指纹**。
   *
   * 于是兜底轮询每分钟跑一次，次次都被指纹短路挡回，
   * 模型清单哪怕变了也永远刷不出来。用户只能靠「去设置里加个接口」
   * 让 provider 列表变化来触发一次真刷新。
   *
   * 现在：轮询强制走完整刷新（保证最终一致）；事件驱动时也不再
   * 因指纹相同就直接 return —— 是否真的重建交给 refresh() 按内容判断。
   * 60 秒一次全量枚举的代价完全可以接受，它本来就是设计上的保险。
   */
  schedule(fromPoll = false) {
    if (this.disposed) return

    // ⚠ 这里**不再预取 listProviders() 做指纹**。
    //
    // 早期实现每次 schedule 都算一次 provider 指纹，加上 refresh() 内部
    // 还要再算一次，等于每个事件/每轮轮询多一次全量枚举。而指纹的
    // 唯一用途是「抖动压制」—— 现在这个职责已经交给
    // ①去抖定时器（REFRESH_DEBOUNCE_MS）
    // ②最短刷新间隔（REFRESH_MIN_INTERVAL_MS）
    // ③refresh() 内部的并发合并（refreshing 复用同一个 Promise）
    // 三重机制已经足够，不需要额外的指纹预取。
    //
    // 代价说明：事件风暴时最多多做几次 listModels —— 而那正是
    // 「模型真的变了」时需要做的事，不该被压掉。

    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    const since = Date.now() - this.lastRefreshAt
    // 轮询本身已经低频（60s），不再额外压延迟；
    // 事件驱动保持去抖 + 最小间隔，避免风暴。
    const delay = fromPoll ? 0 : Math.max(REFRESH_DEBOUNCE_MS, REFRESH_MIN_INTERVAL_MS - since)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh()
    }, delay)
    this.debounceTimer.unref?.()
  }

  /** 释放定时器与监听。 */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.timer = undefined
    this.debounceTimer = undefined
    // 取消两个订阅（见 start() 的说明）。
    // 单独 try 包：监听器取消失败不该让后续清理半途而废。
    try {
      this.stopAdaptersUpdated?.()
    } catch {
      /* 忽略 */
    }
    try {
      this.stopModelsUpdated?.()
    } catch {
      /* 忽略 */
    }
    this.stopAdaptersUpdated = undefined
    this.stopModelsUpdated = undefined
  }

  /**
   * 重建目录：枚举 → 应用显示规则 → 构建全名映射。
   * 单个 provider 拉取失败只标记降级，**不影响其它 provider**。
   * @returns 目录条目数组。
   */
  /**
   * 重建目录。
   *
   * ## 并发语义（重要）
   *
   * 同一时刻只跑一轮 `#refreshInner`（避免重复枚举上游），但**不能把
   * 期间到来的请求直接复用旧 Promise 就算了**：
   *
   *   正在刷新（快照 A）时用户又加了模型 → 事件触发第二次 refresh()
   *   → 若直接 return 那个旧 Promise，快照 A 里没有新模型，
   *     而这一次事件就这样被"吃掉"了 —— 新模型要等下一次事件或轮询才出现。
   *
   * 这正是「Hub 里加的模型要等一会儿才刷新」的另一个成因。
   *
   * 现在的做法：刷新进行中时记一个 `dirty` 标记；本轮结束后如果
   * 期间又有请求，**立刻再跑一轮**（最多连续两轮，避免无限自旋）。
   *
   * @returns 目录条目数组。
   */
  async refresh() {
    if (this.refreshing !== undefined) {
      // 刷新已在进行：标记"结束后要再刷一次"，并返回当前这轮的 Promise
      // （调用方拿到的是"至少包含本次之前的所有变化"的结果）。
      this.refreshDirty = true
      return this.refreshing
    }

    this.refreshDirty = false
    this.refreshing = this.#refreshInner().finally(() => {
      this.refreshing = undefined
      this.lastRefreshAt = Date.now()
    })

    const result = await this.refreshing

    // 期间又有变化 → 补一轮（只补一次，防止上游持续抖动时无限循环）
    if (this.refreshDirty === true) {
      this.refreshDirty = false
      try {
        const again = await this.#refreshInner()
        this.lastRefreshAt = Date.now()
        return again
      } catch {
        // 补刷失败：返回已有结果，让调用方仍能拿到可用目录
        return result
      }
    }

    return result
  }

  async #refreshInner() {
    const cfg = this.config()
    const excludedProviders = new Set(cfg?.filters?.providers ?? [])
    // 模型过滤（P16，设计方案 §4.4 + §7.3）：
    //   excludedModels  —— 黑名单，命中即不公开
    //   allowedModels   —— 白名单，**非空时只公开其中的**（空 = 全部）
    // 两者可叠加：先过白名单，再过黑名单（黑名单优先，避免"白名单里误留"）。
    const excludedModels = new Set(cfg?.filters?.models ?? [])
    const allowedModels = new Set(cfg?.filters?.allowedModels ?? [])
    const useAllowList = allowedModels.size > 0
    const hiddenModels = new Map()
    const providers = this.ctx.llm.listProviders()
    // 一次分配、全局一致：`#refreshInner` / `providerBySlug` / `diagnostics` 必须看到
    // 同一张表，否则会出现"列表里叫 a-b-1f2c，反解却按 a-b 去找"的错位。
    const slugs = assignSlugs(providers.map((p) => p.id))
    const slugOfProvider = (id) => slugs.get(id) ?? slugOf(id)
    this.slugs = slugs
    const hidden = new Map()
    const counts = new Map()
    const byPublic = new Map()
    const entries = []

    // ⚠ 限制并发：`listModels` 对某些 provider 会真的去上游拉清单（可能带网络 IO）。
    // 原来用 `Promise.allSettled(providers.map(...))`，provider 一多就是
    // 几十个并发请求同时打出去 —— 目录刷新发生在**每次 models-updated 事件
    // 和每分钟轮询**上，这种突发既没必要也容易触发上游限流。
    //
    // 上限 6 是经验值：单次刷新总耗时与"最慢的那个 provider"同量级，
    // 同时不足以打满任何上游的并发额度。
    const settled = await mapSettledWithConcurrency(
      providers,
      6,
      async (provider) => {
        const models = await this.ctx.llm.listModels(provider.id)
        return { provider, models }
      },
    )

    for (const [index, result] of settled.entries()) {
      const provider = providers[index]
      // 显示规则（§4.4，官方与第三方统一）：三项只读判定，不做凭据探测。
      if (excludedProviders.has(provider.id)) {
        hidden.set(provider.id, 'filtered')
        continue
      }
      if (result.status !== 'fulfilled') {
        // 拉取失败：不谎报为空，标记降级但仍尽量列出（下一次刷新会自愈）
        hidden.set(provider.id, `list_failed: ${result.reason?.message ?? 'unknown'}`)
        counts.set(provider.id, 0)
        continue
      }
      const allModels = result.value.models ?? []
      const providerSlug = slugOfProvider(provider.id)
      // 过滤后再判断"是否为空"，避免"全被过滤掉"的 provider 仍显示为空分组
      const models = allModels.filter((model) => {
        const publicName = publicNameOf(model.id, provider.id, providerSlug)
        // 白名单非空时，只允许其中的；两种写法都认（公开名 或 裸模型名）
        if (useAllowList && !allowedModels.has(publicName) && !allowedModels.has(model.id)) {
          hiddenModels.set(publicName, 'not_in_allowlist')
          return false
        }
        if (excludedModels.has(publicName) || excludedModels.has(model.id)) {
          hiddenModels.set(publicName, 'excluded')
          return false
        }
        return true
      })
      counts.set(provider.id, models.length)
      if (models.length === 0) {
        hidden.set(provider.id, allModels.length === 0 ? 'no_models' : 'all_models_filtered')
        continue
      }
      for (const model of models) {
        const publicName = publicNameOf(model.id, provider.id, providerSlug)
        const entry = {
          publicName,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          slug: providerSlug,
          model: model.id,
          name: model.name ?? model.id,
          description: model.description,
          inputModalities: model.inputModalities,
        }
        byPublic.set(publicName, entry)
        entries.push(entry)
      }
    }

    this.byPublic = byPublic
    this.hidden = hidden
    this.hiddenModels = hiddenModels
    this.counts = counts
    this.entries = entries
    // 排序一次并缓存：list() 在热路径上，不必每次重排（见 list() 的说明）。
    this.sorted = [...entries].sort((a, b) =>
      a.provider === b.provider
        ? a.model.localeCompare(b.model)
        : a.provider.localeCompare(b.provider),
    )
    return entries
  }

  /**
   * 列出当前所有公开条目。
   * @returns 条目数组（已按 provider 与模型名排序，输出稳定）。
   */
  /**
   * 列出当前所有公开条目（已排序）。
   *
   * 排序在 `#refreshInner` 里做一次、结果缓存在 `this.sorted`，
   * 这里只返回**防御性副本**。
   *
   * 为什么不在每次调用时排序：`list()` 在热路径上（每次 `GET /v1/models`、
   * 每次模型解析的宽松回退都会调），而条目数量随 provider×模型 增长。
   * 每次 `[...entries].sort(...)` 是 O(n log n) 的重复分配 ——
   * 目录没变时这个排序结果完全一样，纯属浪费。
   *
   * @returns 条目数组的副本（调用方可自由修改）。
   */
  list() {
    return [...(this.sorted ?? [])]
  }

  /**
   * 某个 (provider, model) 是否**允许公开**（P16 过滤判定）。
   *
   * 用途：`resolveModel()` 的**宽松回退路径**也要过这一关——
   * 否则被过滤的模型虽然不出现在 `/v1/models`，仍能被直接调用，
   * 过滤就只剩"看不见"而达不到"不能用"的设计目的（§7.3）。
   *
   * 语义：黑名单命中 → false；白名单非空且不在其中 → false；否则 true。
   *
   * @param providerId - provider id。
   * @param modelId - 裸模型 id。
   * @returns 是否允许公开。
   */
  isPubliclyAllowed(providerId, modelId) {
    const cfg = this.config()
    // 必须与目录发布用的 slug 一致：过滤器里写的公开名是按 /v1/models 抄下来的，
    // 用裸 slugOf 会拼出另一个名字，于是"明明拉黑了却还能调"。
    const publicName = publicNameOf(modelId, providerId, this.slugs?.get(providerId))

    // 过滤器集合化：这个函数在**热路径**上（每次宽松路由回退都要过一遍），
    // 原来每次调用都新建三个数组并做 `Array.includes` 线性扫描 ——
    // 配置里写了 100 个黑名单时，一次请求就要扫 300 次。
    //
    // 现在按"配置对象的引用"做一层极轻的缓存：只要 filters 还是同一个
    // 对象（配置没被 patch 替换过），就直接复用上次建好的 Set。
    const filters = cfg?.filters
    if (this.filterCache === undefined || this.filterCache.src !== filters) {
      this.filterCache = {
        src: filters,
        providers: new Set(filters?.providers ?? []),
        models: new Set(filters?.models ?? []),
        allowed: new Set(filters?.allowedModels ?? []),
      }
    }
    const f = this.filterCache

    if (f.providers.has(providerId)) return false
    if (f.models.has(publicName) || f.models.has(modelId)) return false
    if (f.allowed.size > 0 && !f.allowed.has(publicName) && !f.allowed.has(modelId)) return false
    return true
  }

  /**
   * 公开名 → 路由（严格命中目录；宽松拆解在路由层处理，§4.3）。
   * @param publicName - 客户端传来的 model 字段。
   * @returns 条目，或 undefined。
   */
  resolve(publicName) {
    return this.byPublic.get(String(publicName))
  }

  /**
   * 严格校验：目标 provider 当前是否仍注册着。
   * 这是"删除 Provider 后不能再使用"的硬保证，不依赖目录刷新速度。
   * @param providerId - provider 路由 id。
   * @returns 是否仍注册。
   */
  /**
   * 宽松路由：按裸模型 id 反查公开条目（§4.3 扩展）。
   *
   * 动机：绝大多数 OpenAI 兼容客户端只让用户填**模型名**（如 `deepseek-v4.1-flash`），
   * 不会写 `@provider` 后缀。若只认全名，这些客户端一律 404 model_not_found，
   * 表现为"服务能用但别人接不上"。
   *
   * @param modelId - 客户端传来的裸模型名。
   * @returns 命中的条目；未命中返回 undefined。
   */
  resolveByModelId(modelId) {
    const wanted = String(modelId)
    // 多个 provider 提供同名模型时的取值规则：**按对外展示的顺序取第一个**。
    //
    // 早期这里写的是 `hits.find((e) => e.provider === 'workbuddy') ?? hits[0]`——
    // 那是一条写死厂商名的偏好：只要装了 workbuddy，裸模型名就永远路由到它，
    // 与 `GET /v1/models` 里给用户看的顺序无关，也与用户在面板里排的顺序无关。
    // 对本插件来说这是最后一处"把某家当成主角"的残留（m00001 的核心诉求），
    // 而且它会让"我明明把另一家排在前面、为什么请求跑到这家去了"变成无法解释的现象。
    //
    // 现在的语义：与 `list()` 同一套排序（provider 名 → 模型名），
    // 即"用户在模型列表里看到的第一个就是会被命中的那个"。命中多个时记一条 warn，
    // 让管理员知道裸名有歧义、该用全名（`model@provider`）来精确指定。
    const ordered = this.list().filter((e) => e.model === wanted)
    if (ordered.length === 0) return undefined
    if (ordered.length > 1 && this.ambiguousWarned?.has?.(wanted) !== true) {
      this.ambiguousWarned ??= new Set()
      this.ambiguousWarned.add(wanted)
      // 可选链：目录层不该因为日志通道缺失就抛错（它只是诊断信息）
      this.ctx.logger?.warn?.(
        `[lantern] 裸模型名「${wanted}」有 ${ordered.length} 个 provider 都提供`
        + `（${ordered.map((e) => e.provider).join(' / ')}），按列表顺序命中 ${ordered[0].provider}；`
        + '要精确指定请用全名 model@provider。',
      )
    }
    return ordered[0]
  }

  isProviderLive(providerId) {
    return this.ctx.llm.listProviders().some((p) => p.id === providerId)
  }

  /**
   * 由 slug 反查 provider id（宽松路由用）。
   * @param slug - 公开名里的 slug 部分。
   * @returns provider id，或 undefined。
   */
  providerBySlug(slug) {
    // 反解必须走**分配后**的 slug 表（`assignSlugs` 的结果），不能用裸 `slugOf`：
    // 后者是有损映射（小写归一 + 截断 24），`a_b`/`a-b`/`a/b` 会撞成同一个名字。
    // 早先用 `find` 取第一个命中 → 手写宽松名可能被路由到**另一家**，
    // 而严格名（/v1/models 返回的那个）又是对的，排查成本极高
    // （"用 A 家的 key 打了 B 家"，账单与数据都错位）。
    const providers = this.ctx.llm.listProviders()
    const slugs = this.slugs ?? assignSlugs(providers.map((p) => p.id))
    const hits = providers.filter((p) => (slugs.get(p.id) ?? slugOf(p.id)) === slug)
    if (hits.length === 1) return hits[0].id
    if (hits.length > 1) {
      // 每对 slug 只警告一次，避免高频调用刷屏。
      const warned = this.slugCollisionWarned ?? (this.slugCollisionWarned = new Set())
      if (!warned.has(slug)) {
        warned.add(slug)
        this.ctx.logger?.warn?.(
          '[lantern] provider slug 冲突「' + slug + '」：' + hits.map((p) => p.id).join(' / ') +
            ' —— 宽松名 <model>@' + slug + ' 无法确定目标，请改用 /v1/models 返回的完整名',
        )
      }
      return undefined
    }
    return undefined
  }

  /** 供 `/v1/lantern/health` 与设置面板使用的诊断快照。 */
  diagnostics() {
    const providers = this.ctx.llm.listProviders()
    // 面板要把 slug 显示给人看（复制到客户端里当 model 名），所以这里也必须是
    // 分配后的那份，否则面板显示的名字和 /v1/models 返回的对不上。
    const slugs = this.slugs ?? assignSlugs(providers.map((p) => p.id))
    const rows = providers.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      slug: slugs.get(p.id) ?? slugOf(p.id),
      visible: !this.hidden.has(p.id),
      hiddenReason: this.hidden.get(p.id),
      modelCount: this.counts.get(p.id) ?? 0,
    }))
    return {
      // 可见的（对局域网公开）——设置面板左栏导航用它
      providers: rows.filter((r) => r.visible),
      // 全部（含被隐藏的）——面板用它显示"为什么某个 provider 不见了"
      allProviders: rows,
      publicCount: this.byPublic.size,
      hiddenCount: this.hidden.size,
      // P16：被过滤掉的模型（面板显示"哪些被排除了及原因"，避免"配了过滤器却看不出效果"）
      hiddenModels: [...(this.hiddenModels ?? new Map()).entries()].map(([publicName, reason]) => ({
        publicName,
        reason,
      })),
      hiddenModelCount: (this.hiddenModels ?? new Map()).size,
      lastRefreshAt: this.lastRefreshAt,
    }
  }
}


/**
 * 带并发上限的 `Promise.allSettled`。
 *
 * 语义与 `Promise.allSettled` 一致：**单个失败不影响其它**，
 * 返回数组与输入顺序一一对应，失败项是 `{ status: 'rejected', reason }`。
 *
 * 为什么要它：`Promise.allSettled(items.map(fn))` 会把所有 fn 同时启动。
 * 目录层用它拉 N 个 provider 的模型清单，N 大时会形成瞬时并发峰值。
 *
 * @param items - 输入数组。
 * @param limit - 最大并发数（至少 1）。
 * @param fn - 异步映射函数。
 * @returns 与 `Promise.allSettled` 同形的结果数组。
 */
async function mapSettledWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  if (list.length === 0) return results

  const size = Math.max(1, Math.min(limit, list.length))
  let cursor = 0

  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(list[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: size }, worker))
  return results
}
