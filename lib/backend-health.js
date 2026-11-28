/**
 * dsh-lantern — 后端健康记忆（故障转移的「记性」）。
 *
 * 解决的真实问题（用户实测提出）：
 * chain 是 `[A, B, C]`，A 挂掉时一次请求要**等满 A 的首包超时**才切到 B。
 * 下一个请求又从 A 开始——于是**每个**请求都要为同一个已知故障再付一次超时。
 * 表现就是「明明 B 好好的，每次都要先卡 30 秒」。
 *
 * 但也不能因此禁用 A：A 可能几分钟后就恢复了，永久禁用等于要人手动回来点。
 *
 * 解法：**冷却 + 排位**，不是禁用。
 * 1. A 失败一次 → 记一笔，进冷却（默认 30 秒）；
 * 2. 冷却期内构造执行链时，A **排到链尾**（不是移除）——
 *    健康的后端先试，A 只在别人也全挂时才被碰到；
 * 3. 冷却到期自动解除，A 回到它**原本的配置位置**（用户配的顺序就是首选顺序，
 *    这个语义不能被插件偷偷改掉）；
 * 4. 连续失败则冷却翻倍（30s → 60s → 120s → 上限 5 分钟），
 *    一次成功即清零。
 *
 * 边界（写死在这里，避免各处再判一遍）：
 * - **只影响排序，不减少候选**：链上一个都不会少，全部挂掉时仍会如实报「全部失败」；
 * - **客户端自己的错不记在后端头上**：400 参数错、401 Key 错这类是调用方的问题，
 *   记进去只会让一个好好的后端被无端降级；
 * - 状态只在内存，重启清零（和熔断器同一纪律：不把上次的结论带到新进程）。
 *
 * @module dsh-lantern/backend-health
 */

/** 冷却相关默认值（可被 config.limits.backendHealth 覆盖）。 */
const DEFAULT_COOLDOWN_SEC = 30
const DEFAULT_MAX_COOLDOWN_SEC = 300
/** 冷却翻倍因子：连续失败时 cooldown = base * 2^(streak-1)。 */
const BACKOFF_FACTOR = 2

/**
 * 判断这次失败该不该记在后端账上。
 *
 * 「不该记」的两类：
 * 1. **请求本身有病**：参数非法、模型名不存在、载荷过大——换谁来都一样；
 * 2. **鉴权/权限**：Key 无效是配置问题，重试不会自愈，但也不该把
 *    一个健康后端反复顶到链尾（用户改好 Key 之后它就正常了）。
 *
 * 其余（超时、限流、5xx、网络中断、无码内部异常）都算后端的锅。
 *
 * @param failure - `{ code, status, message }`。
 * @returns 是否记入后端健康账。
 */
export function isBackendBlame(failure) {
  if (failure === undefined || failure === null) return false
  const code = typeof failure.code === 'string' ? failure.code : ''
  if (code === 'backend_timeout') return true
  if (
    /^(model_not_found|invalid_request_error|INVALID_REQUEST|INVALID_ARGS|invalid_reasoning_effort|payload_too_large|bad_request|unauthorized|invalid_api_key|authentication_error|forbidden|capability_unsupported|tool_markup_leaked)$/i.test(
      code,
    )
  ) {
    return false
  }
  const status = typeof failure.status === 'number' ? failure.status : undefined
  if (status !== undefined) {
    if (status === 408 || status === 429) return true
    if (status >= 500) return true
    // 其余 4xx 都是「这次请求不对」，不是「这家后端坏了」
    return false
  }
  return true
}

/**
 * 后端健康记忆。
 *
 * 键用 `provider\u0000model`：同一个上游模型被多个虚拟模型复用时，
 * 健康状态应当是共享的（它挂了对谁都挂）。
 */
export class BackendHealth {
  /**
   * @param config - 返回当前配置的函数。
   * @param now - 可注入时钟（测试用）。
   */
  constructor(config, now = () => Date.now()) {
    this.config = config
    this.now = now
    /** `key -> { streak, cooldownUntil, lastFailureAt, lastFailureCode, ok, fail, lastOkAt }` */
    this.entries = new Map()
    this.stats = { reordered: 0, cooling: 0 }
    /**
     * #216：后台自检状态。
     *
     * 用户的设计：全冷却时**用户请求立即 503**，同时网关自己后台跑一次探活；
     * 探到的档立刻解除冷却（下一个请求就能用）；全探完还是全挂，
     * 就等冷却自然到期，**不再重复自检**。
     *
     * 字段含义：
     *   · lastSweepAt      —— 上次自检开始的时间（用于防抖"同一批全冷却只查一次"）
     *   · sweeping         —— 是否有自检正在进行（并发保护）
     *   · sweepAttempts    —— 累计自检次数（诊断用）
     *   · sweepOk / sweepFail —— 自检结果统计（诊断用）
     */
    this.sweep = {
      lastSweepAt: 0,
      sweeping: false,
      sweepAttempts: 0,
      sweepOk: 0,
      sweepFail: 0,
    }
  }

  /**
   * #216：判断这次"全部冷却"是否值得触发一次后台自检。
   *
   * 用户的规则是「自检一次，还全挂就等冷却结束、不再自检」。
   * 这里用**时间窗**实现：同一批全冷却期间只自检一次。
   *
   * 为什么用时间窗而不是"标记已自检"：因为冷却会陆续到期，
   * 到期后可能又是一轮新的全冷却（新的一批），那时应该允许再自检。
   * 窗口长度取基础冷却的 1/4（600 秒 → 150 秒）：
   * 足够覆盖"一批请求同时撞上全冷却"的密集期，
   * 又不会在冷却到期后阻止新一轮自检。
   *
   * @returns 是否应该触发自检。
   */
  shouldSweep() {
    if (!this.#cfg().enabled) return false
    if (this.sweep.sweeping) return false
    const now = this.now()
    const window = Math.max(30_000, Math.round(this.#cfg().baseMs / 4))
    if (now - this.sweep.lastSweepAt < window) return false
    this.sweep.lastSweepAt = now
    return true
  }

  /** #216：自检开始（占位，防并发）。 */
  beginSweep() {
    this.sweep.sweeping = true
    this.sweep.sweepAttempts += 1
  }

  /**
   * #216：自检结束，按结果更新统计。
   *
   * 注意：**这里不改任何档的冷却状态** —— 那是 `recordSuccess` /
   * `recordFailure` 的职责（由调用方在探测每一档时自然调用）。
   * 本方法只负责收尾统计与释放占位。
   *
   * @param okCount - 自检中成功的档数。
   * @param failCount - 自检中失败的档数。
   */
  endSweep(okCount = 0, failCount = 0) {
    this.sweep.sweeping = false
    // 防抖窗口从「自检结束」起算。一轮自检最多 N × 12s（8 档 = 96s），
    // 远大于默认 30s 窗口；若仍按开始时间计，sweeping 一释放下一个
    // 全冷却请求就会立刻再起一轮 → 对上游形成探活风暴。
    this.sweep.lastSweepAt = this.now()
    this.sweep.sweepOk += Math.max(0, Number(okCount) || 0)
    this.sweep.sweepFail += Math.max(0, Number(failCount) || 0)
  }

  /** 冷却参数（读配置，带保守默认）。 */
  #cfg() {
    const h = this.config()?.limits?.backendHealth ?? {}
    const base = Number.isFinite(h.cooldownSec) && h.cooldownSec > 0 ? h.cooldownSec : DEFAULT_COOLDOWN_SEC
    const max = Number.isFinite(h.maxCooldownSec) && h.maxCooldownSec > 0 ? h.maxCooldownSec : DEFAULT_MAX_COOLDOWN_SEC
    return {
      enabled: h.enabled !== false,
      baseMs: base * 1000,
      maxMs: Math.max(base, max) * 1000,
    }
  }

  /**
   * 后端标识（provider + model）。
   * @param plan - `{ provider, model }`。
   * @returns 稳定键。
   */
  static keyOf(plan) {
    return String(plan?.provider ?? '') + '\u0000' + String(plan?.model ?? '')
  }

  /**
   * 剩余冷却毫秒数（0 = 健康 / 已到期）。
   * @param plan - 后端计划。
   * @returns 剩余毫秒。
   */
  coolingMs(plan) {
    const entry = this.entries.get(BackendHealth.keyOf(plan))
    if (entry === undefined) return 0
    const left = Number(entry.cooldownUntil ?? 0) - this.now()
    return left > 0 ? left : 0
  }

  /**
   * 记一次失败。
   *
   * @param plan - 后端计划。
   * @param failure - `{ code, status, message }`。
   * @returns 本次冷却毫秒数（0 表示未记入）。
   */
  recordFailure(plan, failure, options) {
    if (!isBackendBlame(failure)) return 0
    const cfg = this.#cfg()
    const key = BackendHealth.keyOf(plan)
    const now = this.now()
    const entry = this.entries.get(key) ?? { streak: 0, cooldownUntil: 0, ok: 0, fail: 0 }
    // ── #232：noEscalate —— 记冷却，但**不做指数退避** ──
    //
    // 用于"这次预算不够"类失败（reasoning_only_empty / empty_completion）：
    // 它们会随客户端参数变化自愈，不属于"后端坏了"，不该滚到 3600s。
    //
    // 实测证据：hy4（6 个绑定、思考极长）在 max_tokens=40 时每个绑定都
    // reasoning_only_empty → streak 一路累加到封顶 → **之后 1 小时所有 hy4
    // 请求直接 503**，连 max_tokens=1000 的合理请求也进不来。
    //
    // 注意这与被用户否掉的 #209「软冷却」不同：#209 改的是**冷却时长**
    // （缩短到 baseMs/6），这里改的是**是否升级** —— 冷却仍是完整的基础值
    // （600s），只是永远停在那里，不会翻倍。
    const noEscalate = options?.noEscalate === true
    // 冷却期内再失败 = **同一轮故障**，不累加 streak。
    //
    // 实测：8 个并发请求同时撞上一个超时后端，各自调一次 recordFailure，
    // streak 一路 1→8，冷却从 30s 指数扩张到 300s 上限。用户看到的现象是
    // 「后端抖了一下，网关把它冷却了五分钟」——一次故障被按并发数放大。
    //
    // streak 的语义是「连续的**独立**故障轮次」：只有在冷却已经到期、
    // 重新试过又失败时才算新的一轮（那时 cooldownUntil 已过，走下面正常累加）。
    // 冷却期内重复失败只把终点往后推（保持当前档位），并照常累加 fail 原始计数。
    //
    // 判定必须带 `> 0`：cooldownUntil 用 0 表示「从未冷却」，而注入的时钟
    // 在测试里可以是负数；只写 `cooldownUntil > now` 会把「没有冷却」误判成
    // 「正在冷却」，进而永远不累加 streak。
    const until = Number(entry.cooldownUntil ?? 0)
    const alreadyCooling = until > 0 && until > now
    // #232：noEscalate 时不动 streak（保持已有档位；从未失败过则置 1 以取基础冷却）
    if (!alreadyCooling && !noEscalate) entry.streak = Number(entry.streak ?? 0) + 1
    if (noEscalate && Number(entry.streak ?? 0) < 1) entry.streak = 1
    entry.fail = Number(entry.fail ?? 0) + 1
    entry.lastFailureAt = now
    entry.lastFailureCode = failure?.code ?? 'unknown'
    entry.lastFailureMessage = String(failure?.message ?? '').slice(0, 200)
    if (!cfg.enabled) {
      this.entries.set(key, entry)
      return 0
    }
    const raw = cfg.baseMs * Math.pow(BACKOFF_FACTOR, Math.max(0, Number(entry.streak ?? 1) - 1))
    const cooldown = Math.min(Math.round(raw), cfg.maxMs)
    entry.cooldownUntil = now + cooldown
    this.entries.set(key, entry)
    return cooldown
  }

  /**
   * 记一次「接住了请求并开始输出」，但**还不知道能不能写完**。
   *
   * 为什么不能直接用 recordSuccess：流式路径出第一个字时就会调这里，
   * 而「出过字但中途断流」是最需要被记住的故障（用户实测场景：第一个后端
   * 正常响应、中途断掉，切到第二个）。如果出字就把连败清零，那么紧接着的
   * 断流只能记到 streak=1，冷却永远停在最短档；用户两次请求的间隔一旦超过
   * 这个冷却，它就永远排在首位、永远在同一处断流——等于没修。
   *
   * 所以这里只做「确认可达」那一半：清零 streak 与冷却，但保留 breakStreak
   * （中途断流的累计），后者只在**真正写完整了**时由 recordSuccess 清掉。
   *
   * @param plan - 后端计划。
   */
  recordEngaged(plan) {
    const key = BackendHealth.keyOf(plan)
    const entry = this.entries.get(key) ?? { streak: 0, cooldownUntil: 0, ok: 0, fail: 0 }
    entry.streak = 0
    entry.cooldownUntil = 0
    entry.ok = Number(entry.ok ?? 0) + 1
    entry.lastOkAt = this.now()
    this.entries.set(key, entry)
  }

  /**
   * 记一次「出过字但中途断流」。
   *
   * 与 recordFailure 分开计数（breakStreak），理由见 recordEngaged。
   * 同一条后端的断续次数越多，冷却翻得越久：30s → 60s → 120s → 上限。
   *
   * @param plan - 后端计划。
   * @param failure - `{ code, status, message }`。
   * @returns 本次冷却毫秒数（0 表示未记入）。
   */
  recordStreamBreak(plan, failure) {
    if (!isBackendBlame(failure)) return 0
    const cfg = this.#cfg()
    const key = BackendHealth.keyOf(plan)
    const now = this.now()
    const entry = this.entries.get(key) ?? { streak: 0, cooldownUntil: 0, ok: 0, fail: 0 }
    // 与 recordFailure 同一条理由：冷却期内又断一次，是同一轮坏后端，不是新的一轮。
    // 不加这个判断，5 个并发请求同时断流就会把 breakStreak 顶到 5、冷却直接吃满上限。
    // `> 0` 的理由同 recordFailure：cooldownUntil=0 表示「从未冷却」。
    const until = Number(entry.cooldownUntil ?? 0)
    const alreadyCooling = until > 0 && until > now
    if (!alreadyCooling) entry.breakStreak = Number(entry.breakStreak ?? 0) + 1
    entry.fail = Number(entry.fail ?? 0) + 1
    entry.lastFailureAt = now
    entry.lastFailureCode = failure?.code ?? 'stream_broken'
    entry.lastFailureMessage = String(failure?.message ?? '').slice(0, 200)
    if (!cfg.enabled) {
      this.entries.set(key, entry)
      return 0
    }
    const raw = cfg.baseMs * Math.pow(BACKOFF_FACTOR, Math.max(0, Number(entry.breakStreak ?? 1) - 1))
    const cooldown = Math.min(Math.round(raw), cfg.maxMs)
    entry.cooldownUntil = now + cooldown
    this.entries.set(key, entry)
    return cooldown
  }

  /**
   * 记一次完整成功：全部清零（连败、断续、冷却）。
   * @param plan - 后端计划。
   */
  recordSuccess(plan) {
    const key = BackendHealth.keyOf(plan)
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.entries.set(key, { streak: 0, cooldownUntil: 0, ok: 1, fail: 0, lastOkAt: this.now() })
      return
    }
    entry.streak = 0
    entry.breakStreak = 0
    entry.cooldownUntil = 0
    entry.ok = Number(entry.ok ?? 0) + 1
    entry.lastOkAt = this.now()
  }

  /**
   * 按健康状态重排执行链。
   *
   * **不是过滤**：冷却中的后端照样留在链上，只是排到最后。
   * 这样「A 挂了、B 也挂了、C 还活着」的链仍然是 A→B→C 的候选集合，
   * 只是顺序变成 B→C→A——用户看到的失败原因依旧完整。
   *
   * 排序是**稳定**的：同组内保持配置顺序，所以用户配的优先级只在
   * 「健康度相同」时才分先后，不会被插件悄悄改掉。
   *
   * @param plans - 原始执行链（有序）。
   * @returns `{ plans, cooling }`；cooling 是本次被挪到链尾的档数。
   */
  order(plans) {
    const list = Array.isArray(plans) ? plans : []
    if (list.length <= 1) return { plans: list, cooling: 0 }
    if (!this.#cfg().enabled) return { plans: list, cooling: 0 }
    const healthy = []
    const cooling = []
    for (const plan of list) {
      if (this.coolingMs(plan) > 0) cooling.push(plan)
      else healthy.push(plan)
    }
    if (cooling.length === 0) return { plans: list, cooling: 0 }
    this.stats.cooling = cooling.length

    // ── #207：冷却期内**直接剔除**，不再"排到链尾" ──
    //
    // 用户实测提出的场景（真实痛点）：
    //   链 = [#1 慢到超时, #2 正常]
    //   · #1 进冷却后"排到链尾" → 顺序变 [#2, #1]
    //   · 但 #2 如果也挂了，链尾的 #1 还是会被试一次 → 每个请求都要再陪它等满 10 秒
    //   · 更要命的是"全部冷却"时（用户截图里 #1/#2/#3 全在冷却）：
    //     代码原来 return 原序 → #1 又回到链首，冷却形同虚设。
    //
    // 所以改成：**冷却中的后端不参与本次尝试**。
    // 这是"降级永远可见"的正例 —— summary 里照实报告剔除了几档，
    // 且响应头 `X-Lantern-Attempt-Codes` 能看出实际试了哪几档。
    //
    // ── #216（按用户最终设计）：用户请求立即 503，**后台自己**去自检 ──
    //
    // 用户的原话（这次是最终版，与上一版不同）：
    //   「这个是在我们后端自己自检跑一遍。比如全部冷却了，
    //     用户正常返回 503 没问题，我们后端检测到模型全部冷却了，
    //     自己自检跑一遍之后，如果还是全都失败，那就等冷却结束，
    //     不会再去自检」
    //
    // 关键区别（上一版做错了）：
    //   ✗ 上一版：把冷却中的档塞进**用户请求**的执行链里真跑一遍
    //     → 用户要为这次"自检"白等 N 次首包超时（6 档 × 10 秒 = 60 秒）
    //     → 而用户其实只是想知道"现在能不能用"
    //   ✓ 现在：用户请求**立刻** 503；与此同时后台异步做一次健康探测，
    //     成功的档立刻解除冷却，**下一个**用户请求就能用上。
    //
    // 这样用户永远不为自检付费，而链仍能自愈（延迟到下一请求）。
    //
    // 三个必须守住的边界：
    // 1. **每次"全部冷却"只自检一次**：用 `lastSweepAt` 防抖，
    //    同一批全冷却期间重复触发不会反复打上游（用户的"不会再去自检"）。
    // 2. **自检失败不延长冷却**：失败即保持原状态，等冷却自然到期。
    // 3. **自检本身不计入并发上限**：它是网关自己的探活，不是用户流量。
    if (healthy.length === 0) {
      this.stats.cooling = list.length
      // 通知外部"需要自检了"（同进程内同步回调，真正的探测在调用方异步执行）。
      this.stats.allCoolingAt = this.now()
      return { plans: [], cooling: list.length, dropped: list.length, allCooling: true }
    }

    // 有健康的 → 只试健康的，冷却中的**这次完全不碰**
    const changed = healthy.some((plan, index) => plan !== list[index])
    if (changed) this.stats.reordered += 1
    return {
      plans: healthy,
      cooling: cooling.length,
      dropped: cooling.length,
      allCooling: false,
    }
  }

  /**
   * 撤销一批后端的冷却（用于「整轮重试」）。
   *
   * ## 为什么需要这个能力
   *
   * 健康记忆的初衷是"记住这个后端刚才失败了，先别试它"。但**一轮全挂**
   * 与 **单个后端坏了** 是两种完全不同的情况：
   *
   *   · 单个坏了：跳过它用别的，符合预期
   *   · 一轮全挂：更可能是这次请求运气不好（上游瞬时抖动、网络瞬断），
   *     把整条链全记进冷却会让用户接下来整个冷却期都不能用
   *
   * 所以整轮重试前先把这一轮的账清掉，让第二轮能正常跑。
   * 只有第二轮仍然全挂，才把冷却重新记上（那才是"真的都不可用"）。
   *
   * @param plans - 要撤销冷却的后端列表。
   * @returns 实际撤销的条数（用于日志）。
   */
  clearCooldowns(plans) {
    const list = Array.isArray(plans) ? plans : []
    let cleared = 0
    for (const plan of list) {
      const key = BackendHealth.keyOf(plan)
      const entry = this.entries.get(key)
      if (entry === undefined) continue
      if (Number(entry.cooldownUntil ?? 0) <= this.now()) continue
      // 只清「本轮失败累加的账」：
      //   · cooldownUntil —— 冷却本身
      //   · streak        —— 连续失败轮次
      //   · breakStreak   —— 连续断流轮次（recordStreamBreak 会同时写它；
      //                      不清的话下一次断流会直接从第 2 档起算，
      //                      等于"这一轮还是被记了一笔"，与日志不符）
      // ok / fail / lastFailureAt 等历史战绩保留 —— 重试不该抹掉历史。
      //
      // 注意这里按「当前仍在冷却」筛选，因此也会顺带撤掉更早之前记下的、
      // 尚未到期的冷却。这是有意的取舍：宁可多重试一次，也不要因为
      // 一次抖动把整个链拉黑一小时；第二轮若仍失败会重新记账。
      entry.cooldownUntil = 0
      entry.streak = 0
      entry.breakStreak = 0
      cleared += 1
    }
    if (cleared > 0) {
      this.stats.cooling = 0
      this.stats.allCoolingAt = 0
    }
    return cleared
  }

  /**
   * 供面板展示的健康快照。
   *
   * @returns 每条后端的 `{ key, provider, model, coolingSec, streak, ok, fail, lastFailureCode }`。
   */
  snapshot() {
    const now = this.now()
    const rows = []
    for (const [key, entry] of this.entries) {
      const [provider, model] = key.split('\u0000')
      const left = Number(entry.cooldownUntil ?? 0) - now
      rows.push({
        key,
        provider,
        model,
        coolingSec: left > 0 ? Math.ceil(left / 1000) : 0,
        streak: Number(entry.streak ?? 0),
        // 出过字但中途断流的累计次数（与 streak 分开：出字不代表写完了）
        breakStreak: Number(entry.breakStreak ?? 0),
        // ⚠ 历史字段（#209 引入、#210 撤销）：软失败计数。
        // 现在的策略是所有失败一律按完整冷却处理（见 recordFailure），
        // 所以新进程里它恒为 0。保留输出是为了让面板在**旧数据**上不报错
        // （热重载时 entries 可能带着旧字段），下个大版本可以删掉。
        softFail: Number(entry.softFail ?? 0),
        ok: Number(entry.ok ?? 0),
        fail: Number(entry.fail ?? 0),
        ...(entry.lastFailureCode === undefined ? {} : { lastFailureCode: entry.lastFailureCode }),
        ...(entry.lastFailureAt === undefined ? {} : { lastFailureAt: entry.lastFailureAt }),
      })
    }
    rows.sort(
      (a, b) =>
        b.coolingSec - a.coolingSec ||
        b.streak - a.streak ||
        b.breakStreak - a.breakStreak ||
        a.key.localeCompare(b.key),
    )
    return rows
  }

  /**
   * 清空全部记忆（面板「清除」按钮 / 用户改完上游配置后）。
   */
  reset() {
    this.entries.clear()
    this.stats.reordered = 0
    this.stats.cooling = 0
  }

  /**
   * 只清一条（面板上点某个绑定的「恢复」）。
   * @param plan - `{ provider, model }`。
   * @returns 是否清到了。
   */
  resetOne(plan) {
    return this.entries.delete(BackendHealth.keyOf(plan))
  }

  /** 供 /v1/lantern/health 使用的摘要。 */
  status() {
    const rows = this.snapshot()
    return {
      enabled: this.#cfg().enabled,
      cooling: rows.filter((r) => r.coolingSec > 0).length,
      tracked: rows.length,
      reordered: this.stats.reordered,
      // 有故事可讲的行：连败、断续、软失败、或还在冷却。都为 0 的只算"顺便记
      // 了一次成功"，不必占面板位置。
      entries: rows
        .filter((r) => r.streak > 0 || r.breakStreak > 0 || r.softFail > 0 || r.coolingSec > 0)
        .slice(0, 20),
    }
  }
}
