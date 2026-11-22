/**
 * dsh-lantern — 对外统一推理等级契约（第十轮）。
 *
 * ## 为什么需要这一层
 *
 * 各家的推理档位词表**互不相同**（第十轮在 DSH 源码层核实过）：
 *
 *   · `dsh-llm-deepseek`  → `off / low / high / max`（写死在 REASONING_EFFORTS）
 *   · `dsh-llm-pi-ai`     → `off / minimal / low / medium / high / xhigh / max`
 *                            （THINKING_LEVELS，源码注释原话 "in escalation order"）
 *   · 本机实测的虚拟模型并集 → `glm-5.3` 8 档、`hy4` 5 档、`Seed` 2 档、`Qwen` 5 档
 *
 * 多绑定模型的并集是**按"首次出现顺序"**拼出来的（`mergeReasoningCell`），
 * 于是并集顺序既不是升序也不是降序 —— 实测 `hy4` 是
 * `["high","low","medium","xhigh","max"]`。这带来两个连锁问题：
 *
 * 1. **调用方没法写"高一档"**：它不知道 `medium` 在这台网关上排第几。
 * 2. **`resolveAnthropicThinking` 取末档 ≠ 取最高档**：它靠
 *    `efforts[efforts.length - 1]` 猜"最高"，那是在 DSH 权威列表（真升序）下成立的
 *    假设；一旦拿到的是并集，末档可能恰好是 `none` —— "要开思考"被映射成"关掉思考"。
 *
 * ## 这一层的做法：四档契约 + 对照表 + 自适应
 *
 * 对外只公开 **四个档位**（`minimal / low / medium / high`），每个绑定的真实词表
 * 通过**对照表**落到最接近的那一档。调用方永远只说四档之一。
 *
 * 三条铁律（与插件既有约定一致）：
 * 1. **降级永远可见**：映射到哪一档、原始请求是哪一档，都写进响应头。
 * 2. **不确定就说不确定**：词表里一个都匹配不上时返回 `no-match`，
 *    由调用方决定"拒绝"还是"不发这个参数"，绝不瞎猜。
 * 3. **全链都不支持 ≠ 拒绝**：整条链没人声明推理能力时，契约退化为
 *    "不发 reasoningEffort"（`degraded: no-backend-supports`），
 *    因为"关掉思考"在不会思考的模型上是天然满足的。
 *
 * @module dsh-lantern/effort-contract
 */

/**
 * 对外四档（**顺序即强弱，低的在前**）。
 *
 * 选四个而不是 5~7 个的理由：档位越多，能落到同一档的后端越少，
 * 一次请求被"排除"的档就越多（第七轮实测：`xhigh` 让 glm-5.3 从 6 档掉到 1 档）。
 * 四档是在"表达力"与"可用性"之间的折中值。
 */
// CONTRACT_LEVELS 在下面（第十一轮改名为 max）统一定义，这里不再重复声明。

/** 未指定时的默认档。选 `medium` 而不是最高：默认值不该悄悄烧掉全部思考预算。 */
export const DEFAULT_CONTRACT_LEVEL = 'medium'

/**
 * 档位强弱序（**全词表**，含各家私有词）。
 *
 * 这是全仓唯一一处"谁大谁小"的定义。任何需要比较档位高低的地方都必须走它，
 * 不许再写 `efforts[efforts.length - 1]` 那种靠数组位置猜的代码。
 */
const RANK_TABLE = Object.freeze({
  off: 0,
  none: 0,
  disabled: 0,
  minimal: 1,
  light: 2,
  low: 3,
  medium: 4,
  default: 4,
  auto: 4,
  high: 5,
  extra_high: 6,
  xhigh: 7,
  max: 8,
})

/**
 * 四个对外档的**相对语义**（第十一轮重写，这是本轮最重要的修正）。
 *
 * ## 上一版错在哪
 *
 * 上一版把四档当成"字面匹配"：`high` 只在后端词表里找名叫 `high` 的词。
 * 于是后端声明 `[light, high, extra_high]` 时，用户要 `high` 只拿到 `high`，
 * 明明它还能 `extra_high` —— **模型能力没被发挥出来**。
 *
 * 用户的原话把语义说清楚了：
 *   "我们内置一个推理等级 default low high max，人家按我们的档位，
 *    比如设 max 肯定是最高了，轮询的模型肯定是按照他们的可选推理档位参数，
 *    那我们就对照着来呗 —— 选 max 就是 xhigh、就是 extra_high"
 *
 * 所以四档是**相对位置**，不是词：
 *   · `minimal` → 关思考（该后端能关到多低就多低）
 *   · `low`     → 该后端词表里**偏弱**的那一档
 *   · `medium`  → 该后端词表里**居中**的那一档
 *   · `max`     → 该后端词表里**最强**的那一档（叫 xhigh 就用 xhigh，叫 max 就用 max）
 *
 * ## 为什么对外叫 max 而不是 high
 *
 * 上一版最高档叫 `high`，但它的实际行为是"最强档" ——
 * 而"high"这个词本身让人以为"只要到 high 就够"。
 * 用户的模型里有 `[none,low,medium,high,xhigh]`，叫 high 的档拿不到 xhigh，
 * 这跟用户的直觉（我要最高）不符。改名 `max` 之后语义直白：
 * **它就是这条链能给到的最强。**
 */
export const CONTRACT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'max'])

/**
 * 每个对外档 -1..1 的相对位置（用于在任意长度的词表上取分位）。
 *
 * 用位置而不是"词名"来做映射，就能覆盖任何私有词表：
 * 后端有 2 档时 `max` 取第 2 档，有 5 档时取第 5 档，都是"最强"。
 */
const LEVEL_POSITION = Object.freeze({
  minimal: 0,      // 最弱（关思考）
  low: 0.25,       // 偏弱
  medium: 0.5,     // 居中
  max: 1,          // 最强
})

/**
 * 每个对外档位 → **同强度真实词**（只放等价词，不放降级兜底）。
 *
 * 这张表只管"换名字"，不管"降档"：降档由 `rankOf()` 的最近强弱算法负责。
 * 两者混在一张表里会自相矛盾 —— `medium` 的兜底表若放了 `low`，
 * "只声明 low/high 的后端"会拿到 `low`，而按强弱序 `low(距1)` 与 `high(距1)`
 * 同距、规则要求"同距偏向更高档"→ 应该是 `high`。一张表两种语义，迟早打架。
 *
 * ⚠ 第十一轮：这张表现在只用来判"这家的某个词是不是该契约档的**标准词**"
 * （决定响应头里 strategy 标 exact 还是 scaled），**不再用来选词**。
 * 选词由 `mapLevelToBackend` 的"相对位置分位"负责 —— 那样才能做到
 * "选 max 就拿到该家最强的那档"（叫 xhigh 就给 xhigh）。
 */
const LEVEL_TO_WORDS = Object.freeze({
  // 最弱档：关掉思考的各种说法
  minimal: Object.freeze(['off', 'none', 'disabled', 'minimal']),
  // 轻思考
  low: Object.freeze(['low', 'light']),
  // 中等（各家默认值）
  medium: Object.freeze(['medium', 'default', 'auto']),
  // 最强档：这四个词在各自语义里都是"强思考"这一桶。
  // 注意 `high` 在这里只用于判 exact —— 真正选词要按位置取最强的那档。
  max: Object.freeze(['max', 'xhigh', 'extra_high', 'high']),
})

/**
 * 取某个档位词的强弱序号。
 *
 * 不认识的词返回 `undefined`（**不是** 0）——把它当 0 会让"未知档"被误判成
 * "最弱档"，于是"用户要最强"被映射成"关掉思考"。
 *
 * @param {unknown} word - 档位词（大小写不敏感）。
 * @returns {number|undefined} 序号，越大越强。
 */
export function rankOf(word) {
  if (typeof word !== 'string') return undefined
  const key = word.trim().toLowerCase()
  if (key.length === 0) return undefined
  return Object.hasOwn(RANK_TABLE, key) ? RANK_TABLE[key] : undefined
}

/**
 * 判断某个词是不是本契约的四个对外档之一。
 *
 * @param {unknown} word - 待判定值。
 * @returns {boolean}
 */
export function isContractLevel(word) {
  return typeof word === 'string' && CONTRACT_LEVELS.includes(word.trim().toLowerCase())
}

/**
 * 把任意档位词规范化成四个对外档之一（第十一轮：最高档叫 `max`）。
 *
 * 落位规则（便于人工核对）：
 *   off / none / disabled (0)                     → minimal
 *   minimal (1)                                   → minimal
 *   light (2) / low (3)                           → low
 *   medium / default / auto (4)                   → medium
 *   high (5) / extra_high (6) / xhigh (7) / max (8) → max
 *
 * ⚠ `high` 归一成 `max` 是刻意的：对外只有四档，而"high 及以上"在
 * 各家的语义里都是"强思考"这一桶。真正发哪个词由**该后端词表**决定
 * （见 `mapLevelToBackend`：max 会取该家最强的那一档）。
 *
 * @param {unknown} word - 任意档位词。
 * @returns {string|undefined} 四档之一，认不出为 undefined。
 */
export function toContractLevel(word) {
  if (typeof word !== 'string') return undefined
  const key = word.trim().toLowerCase()
  if (key.length === 0) return undefined
  if (CONTRACT_LEVELS.includes(key)) return key
  // 兼容旧名：上一版把最高档叫 `high`，已经发出去的客户端可能还在传它。
  if (key === 'high') return 'max'
  const rank = rankOf(key)
  if (rank === undefined) return undefined
  if (rank <= 1) return 'minimal'
  if (rank <= 3) return 'low'
  if (rank === 4) return 'medium'
  return 'max'
}

/**
 * 契约档位的目标强弱分（用于最近匹配）。
 *
 * 取该桶的**中心值**：
 *   minimal → 0.5（off 0 与 minimal 1 之间）
 *   low     → 3
 *   medium  → 4
 *   high    → 6.5（high 5 与 max 8 的中间偏下，避免被 max 拽走）
 */
const LEVEL_TARGET_RANK = Object.freeze({
  minimal: 0.5,
  low: 3,
  medium: 4,
  high: 6.5,
})

/**
 * 给**一个后端**声明的词表，算出它最能兑现某个契约档的真实词。
 *
 * 三级匹配（依次尝试，命中即返回）：
 *   1. **同义对照**：按 `LEVEL_TO_WORDS` 的顺序找，词表里有就用它。
 *      这一步保证"四档里有的词就直给"，不引入任何偏差。
 *   2. **最近强弱**：词表里没有同义词时，按 `rankOf()` 找与目标分最近的那个。
 *      距离相同时**偏向更高档**（宁可多思考，不可少思考 —— 少思考用户会以为没生效）。
 *   3. **无匹配**：返回 `{ ok: false, reason }`，由调用方决定。
 *
 * @param {string[]} declared - 该后端声明的真实词表（大小写不敏感，可含任意私有词）。
 * @param {string} level - 四档之一（或任意已知词，内部会先 `toContractLevel`）。
 * @returns {{ ok: true, word: string, contract: string, strategy: 'exact'|'nearest', direction?: 'ceiling'|'floor', distance: number }
 *          | { ok: false, contract: string|undefined, reason: 'empty-list'|'unknown-level'|'no-match' }}
 */
export function mapLevelToBackend(declared, level) {
  const contract = toContractLevel(level)
  if (contract === undefined) {
    return { ok: false, contract: undefined, reason: 'unknown-level' }
  }
  const list = Array.isArray(declared)
    ? declared.filter((w) => typeof w === 'string' && w.trim().length > 0)
    : []
  if (list.length === 0) {
    // 词表为空 = 这个后端没声明推理元数据。不是"不支持"，是"不知道"，
    // 由上游自行决定（与"列表空则不下发"的口径一致）。
    return { ok: false, contract, reason: 'empty-list' }
  }

  // ⚠ 第十一轮核心改动：**按相对位置取档，不按词名匹配**。
  //
  // 上一版是"字面/同义词"匹配：`max` 在 `[light, high, extra_high]` 里会命中 `high`
  // 就停下，**拿不到 extra_high** —— 明明这家能给更高。用户要的是
  // "选 max 就是该家最强的那档"，与词名叫什么无关。
  //
  // 所以先把词表**按强度排序**，再按 LEVEL_POSITION 的分位取。
  //
  // ⚠ 认不出强度的词（某家自造的私有档）**不参与分位**：
  // 它们既不该被当成最强（`turbo` 不代表最强），也不该顶掉真正的最强档。
  // 只有整张表一个都认不出时，才退回原顺序的裸分位（别无选择）。
  const ranked = list
    .map((word, index) => ({ word, index, rank: rankOf(word) }))
    .sort((a, b) => {
      if (a.rank === undefined && b.rank === undefined) return a.index - b.index
      if (a.rank === undefined) return 1
      if (b.rank === undefined) return -1
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.index - b.index
    })
  const known = ranked.filter((r) => r.rank !== undefined)

  // ── 认不出的词不能一丢了之（第十六轮 #167）──
  //
  // 历史行为：只用 `known` 参与分位，认不出强度的词（某家自造的私有档）
  // 直接踢出池子。理由是"宁可承认我只知道它有 low，也不假装 turbo 是最强"。
  // 那条理由在**单后端**场景下是对的。
  //
  // 但它在**多绑定链**上会引发灾难：
  //   实测 `hy4` 三个绑定读到的词表是
  //     #1 ["high"]（1 档，认得出）
  //     #2 ["high"]（1 档，认得出）
  //     #3 五个词 —— 全都不在 RANK_TABLE 里（认不出）
  //   于是 #3 被整体踢出，`pool` 只剩 #1/#2 的 ["high"]，
  //   **四档全部落到 high**，`position` 显示 `1/1`。
  //   用户选 minimal 拿到最强档，且没有任何降级提示。
  //
  // 修法：认得出的词优先，但**当它们不足以表达档位差**（少于 2 个、
  // 或明显少于原表长度）时，把认不出的词按**原始位置**并回池子。
  // 这样 #3 的 5 个私有词仍能按顺序分出 5 个槽，四档就能落到不同位置。
  //
  // 保守性体现在：只要认得出的词足够表达（≥2 个且覆盖了半张表），
  // 就仍然只用它们——单后端场景的行为完全不变。
  const unrecognized = ranked.filter((r) => r.rank === undefined)
  const needMerge = unrecognized.length > 0
    && (known.length < 2 || known.length < Math.ceil(list.length / 2))
  // 合并时按**原始 index** 排，因为私有词之间没有可比较的强度，
  // 只能相信该家自己的排序（厂商通常从弱到强或从强到弱，至少是有序的）。
  const merged = needMerge
    ? ranked.slice().sort((a, b) => a.index - b.index)
    : ranked

  // ── 「关闭思考」不是思考强度档（第十六轮 #160）──
  //
  // 实测 `Qwen3.8-Flash` 的词表里有 `none` 和 `xhigh`：
  //   minimal → 落到 none   102,094ms  正文 0 字  ← 卡死后返空
  //   max     → 落到 xhigh  108,277ms  正文 0 字  ← 同一症状
  //   low     → 落到 low     24,198ms  正文 27 字  ✅
  //   medium  → 落到 medium  26,834ms  正文 42 字  ✅
  //
  // `off` / `none` / `disabled` 的语义是**切换思考开关**，不是"思考得更少"。
  // 把它当成最弱档参与分位，等于把"我要最轻的思考"翻译成"关掉思考"——
  // 而某些上游在关思考时并不走非思考路径，而是**挂死**。
  //
  // 所以：分位池里排除这三个词。只有当整张表**只剩**它们时（那家真的只有开关
  // 没有档位），才如实认定它**表达不了强度档**。
  //
  // ── #223：把"只剩开关词"从"退回使用"改成"拒绝映射" ──
  //
  // 上面的注释原来写的是「才退回使用——那种情况下没得选，只能如实标注」，
  // 但那个"退回使用"的实现本身就是错的，实测证据（用户实测 + 逐档矩阵）：
  //
  //   `deepseek-v4.1-flash` 的 #1 绑定词表是 ["off","on"]。
  //   原来 strength=[] → 退回 pool=[off] → 四档全落到 off
  //   → **用户设 medium 想要中等思考，实际把思考整个关掉了**。
  //
  //   实测思考量矩阵（reasoning_content 字数）：
  //     (不传)  head=off@1/1   思考=0    ← 思考被关
  //     minimal head=light@1/3 思考=197
  //     medium  head=high@2/3  思考=247
  //   注意 head 头报的是"链上第一档实际收到的词"，所以那条 `off` 是真的下发出去的。
  //   （`X-Lantern-Effort-Served` 报的 high 只是**聚合**值，容易让人误判成没问题。）
  //
  // 为什么必须拒绝而不是退回：
  //   · `off`/`none`/`disabled` 的语义是"关掉思考"，不是"思考得少"；
  //   · 用户要 minimal/low/medium/max 时，他要的是**强度**，不是开关；
  //   · 把"我要中等思考"翻译成"关掉思考"是明确的语义错误；
  //   · 而且 #160 已经实测过某些上游在关思考时会挂死 102 秒。
  //
  // 正确行为：该绑定**不下发 reasoningEffort**（交给上游默认），
  // 并在聚合时记为"无法表达"而不是参与投票。
  // 这样用户在链上其他正常档还能拿到想要的强度，而不是被一个开关档拉低。
  const SWITCH_ONLY = new Set(['off', 'none', 'disabled'])
  const strength = known.filter((r) => !SWITCH_ONLY.has(String(r.word).trim().toLowerCase()))
  // 关键：认得出的优先参与分位；
  //   · 认不出任何词      → 用全部（按原序）
  //   · 认得出但不足表达   → #167：把认不出的按原位置并回来（见上面的说明）
  //   · 认得出且足够      → 只用认得出的（单后端场景行为不变）
  //   · 只认得出开关词    → #223：拒绝映射（不下发），不把开关当强度档
  let pool
  if (strength.length > 0) {
    pool = needMerge ? merged : strength
  } else if (known.length > 0) {
    // #223：known 非空但**全是开关词** → 这家的词表只有开关，没有强度档。
    // 不能拿 off 当"最弱档"用（那等于响应任何档位请求都关掉思考）。
    // 返回 ok:false 让调用方跳过该绑定、不下发该字段。
    return { ok: false, contract, reason: 'switch-only' }
  } else {
    pool = ranked
  }

  // 分位取档（第十六轮 #161 重写）。
  //
  // ## 历史
  //
  // 第十二轮：`Math.round(pos * (n-1))`。3 档时 `low` 与 `medium` 都落到 `high`
  // —— 用户设了等于没设（"推理等级设置不了"）。
  //
  // 第十三轮 #146：改成"按方向取整"（minimal→0 / low→floor / medium→round / max→末）。
  // 修好了 3 档，但**在 4 档池上仍然有重合**：
  //   池 = [minimal, low, medium, max]，n=4，span=3
  //     minimal → 0          → minimal
  //     low     → floor(0.75) = 0 → minimal   ← 和 minimal 撞
  //     medium  → round(1.5)  = 2 → medium
  //     max     → 3          → max
  //   四档只区分出 3 种。
  //
  // 而且实测在 5–8 档的大词表上，`medium` 一律落到 `high`：
  //   Qwen(去none) 池4档：medium → high
  //   deepseek     池6档：medium → high
  //   glm          池7档：medium → high
  // 客户选 `medium`（"中等思考"）却拿到 `high`，等于被暗中加档。
  //
  // ## 现在的做法：按"四档在 n 个槽上的均匀分布"直接算槽位
  //
  // 不再用 pos×(n-1) 这种连续分位，而是把 n 个槽**按四档需要切成 4 段**：
  //   minimal 永远第 0 槽，max 永远最后一槽，low/medium 分居其间。
  // 具体：`slot = round(target * (n-1))`，target 取 {0, 1/3, 2/3, 1}。
  //
  // 这样：
  //   n=2 → 0, 0, 1, 1        （两档只能二分，必然重合）
  //   n=3 → 0, 1, 1, 2        （三档：low 与 medium 重合是抽屉原理，无法避免）
  //   n=4 → 0, 1, 2, 3        （四档全不同 ✅）
  //   n=6 → 0, 2, 3, 5
  //   n=7 → 0, 2, 4, 6
  //
  // 关键改进：**n≥4 时四档必然互不相同**，且 `medium` 不再系统性偏向 `high`
  // （n=4 时 medium 落第 2 槽 = `medium` 词本身，不再是 `high`）。
  // ── 第十八轮 #197：分位取整改成「按档数自适应」──
  //
  // ## 为什么不能一刀切
  //
  // 原来用 `Math.round(target * span)`，n=3 时得到 slot = [0, 1, 1, 2]：
  //   low 和 medium **挤在第 2 槽**，第 1 槽空着 ——
  //   实测 3 档模型（low/high/max）用户选 `low` 却拿到 `high`（暗中加档）。
  //
  // 单纯改成 `Math.floor` 能修好 n=3（→ [0, 0, 1, 2]），
  // 但会在 **n=2** 上矫枉过正：
  //   floor([0, 0.67, 1.33, 2]) = [0, 0, 1, 2] → clamp 到 n-1=1 → [0,0,1,1]
  //   medium 落第 1 槽 = 最弱档 —— 用户选"中等"拿到最弱，同样错。
  //
  // ## 现在的做法：n≥3 向下取整，n=2 向上取整
  //
  //   n=2 → [0, 0, 1, 1]   medium 落强档（2 档没有中间档，只能二选一，
  //                        选强的比选弱的更符合"中等思考"的预期）
  //   n=3 → [0, 0, 1, 2]   minimal=low 重合，low/medium/max 分开
  //   n=4 → [0, 1, 2, 3]   四档全不同 ✅
  //   n=5 → [0, 1, 2, 4]
  //   n=6 → [0, 1, 3, 5]
  //
  // ## 为什么 n≥3 时向下取整是对的
  //
  // 用户选某一档，期望"**最多**这么强的思考"。向下取整保证
  // **永远不会比用户要的更强** —— 保守但不欺骗。
  // 反过来（向上取整）会让用户选 low 拿到 high，那是明显的加档。
  //
  // n=2 是个特例：只有两档时"向上"只到强档、不会跳级，
  // 且 medium 本就该偏强（它代表"居中偏上"的意图）。
  //
  // 与 `#166`"距离相同时偏向更高档"不冲突：那条是**同义对照**阶段，
  // 这里是**分位取槽**阶段，两处语义不同。
  const POSITION = Object.freeze({ minimal: 0, low: 1 / 3, medium: 2 / 3, max: 1 })
  const target = POSITION[contract] ?? 0.5
  const span = pool.length - 1
  let idx = pool.length <= 2
    ? Math.round(target * span)   // n=1/2：向上取，medium 偏强
    : Math.floor(target * span)   // n>=3：向下取，绝不加档
  idx = Math.min(span, Math.max(0, idx))
  const chosen = pool[idx]

  // ── 只有"标准词恰好也是该家最强/最弱"时才算 exact ──
  //
  // ⚠ 这条判据是第十一轮的第二个教训：**"有个叫 max 的词"不等于"它是最强档"**。
  // 举例 hy4 的 `[high,low,medium,xhigh,max]`：`max` 和 `xhigh` 都是 rank 7/8，
  // 但若某家声明 `[max, medium, low]`（把 max 当"默认"用），字面命中 `max`
  // 会拿到一档**并不是最强**的词。
  //
  // 所以 exact 的成立条件收紧成：命中的那个词**同时也是按位置算出来的那个**。
  // 这样既保留了"叫 max 就用 max"的直观，又不会因为词名误导而丢掉真正的上限。
  const standard = (LEVEL_TO_WORDS[contract] ?? []).map((w) => w.toLowerCase())
  const byPosition = pool[idx].word
  const standardHit = standard.includes(String(byPosition).trim().toLowerCase())
  const isExact = standardHit
  return {
    ok: true,
    word: byPosition,
    contract,
    strategy: isExact ? 'exact' : 'scaled',
    // 记下这个后端一共几档、取的是第几档（从 1 开始），面板与排障要用
    position: idx + 1,
    total: pool.length,
    distance: 0,
  }
}

/**
 * 给**整条链**算一次「这次请求到底能兑现哪个契约档」。
 *
 * 这是"自适应"的核心：调用方只说四档，网关按链上每个后端各自的词表算，
 * 得到一个**全链公共可达**的真实档位。
 *
 * 语义（三态，与能力闸门一致）：
 *   · `mode: 'native'`     —— 至少有一个后端能同义兑现该契约档，用它；
 *   · `mode: 'fallback'`   —— 没有人能同义兑现，但能算出最接近的词，用它；
 *   · `mode: 'degraded'`   —— 整条链没有任何后端声明推理词表（全不支持/全无档案），
 *                             此时**不下发** `reasoningEffort`，并在响应头标注。
 *
 * @param {Array<{label?: string, efforts?: string[]}>} backends - 每个后端的 `{ 标识, efforts }`。
 * @param {string} level - 调用方给的契约档（或任意已知词）。
 * @returns {{
 *   mode: 'native'|'fallback'|'degraded'|'reject',
 *   contract: string|undefined,
 *   word: string|undefined,
 *   strategy: string|undefined,
 *   direction: string|undefined,
 *   mappedBackends: number,
 *   totalBackends: number,
 *   reason: string|undefined,
 *   detail: Array<{ label: string, ok: boolean, word?: string, strategy?: string, reason?: string }>,
 * }}
 */
export function resolveChainLevel(backends, level) {
  const rows = Array.isArray(backends) ? backends : []
  const contract = toContractLevel(level)
  if (contract === undefined) {
    return {
      mode: 'reject',
      contract: undefined,
      word: undefined,
      strategy: undefined,
      direction: undefined,
      mappedBackends: 0,
      totalBackends: rows.length,
      reason: 'unknown-level',
      detail: [],
    }
  }

  const detail = []
  /** 拿到"标准词"的后端（该家词表里真的有 max/medium 这种词）。 */
  const exact = []
  /** 按相对位置取档的后端（常态：该家用的是 xhigh/extra_high 之类）。 */
  const scaled = []
  let declaredCount = 0

  for (const row of rows) {
    const label = typeof row?.label === 'string' ? row.label : '#?'
    const mapped = mapLevelToBackend(row?.efforts, contract)
    if (mapped.ok) {
      declaredCount += 1
      detail.push({
        label, ok: true, word: mapped.word, strategy: mapped.strategy,
        position: mapped.position, total: mapped.total,
      })
      if (mapped.strategy === 'exact') exact.push(mapped)
      else scaled.push(mapped)
    } else {
      detail.push({ label, ok: false, reason: mapped.reason })
    }
  }

  if (rows.length === 0) {
    // 没有后端（链为空）—— 上层的 503 会先拦住，这里只做安全兜底。
    return {
      mode: 'degraded', contract, word: undefined, strategy: undefined, direction: undefined,
      mappedBackends: 0, totalBackends: 0, reason: 'no-backends', detail,
    }
  }

  // 整条链一个词表都没有 → 没人会思考 → 调档天然满足，不下发。
  if (declaredCount === 0) {
    return {
      mode: 'degraded',
      contract,
      word: undefined,
      strategy: undefined,
      direction: undefined,
      mappedBackends: 0,
      totalBackends: rows.length,
      // 区分两种退化：真的没有推理能力 vs 有词表但认不出我们的档位。
      reason: detail.every((d) => d.reason === 'empty-list') ? 'no-backend-supports' : 'no-match',
      detail,
    }
  }

  // ── 聚合：按「词表丰富度」加权投票（第十六轮 #162）──
  //
  // ## 为什么不能一人一票
  //
  // 实测 `hy4` 三个绑定：
  //   #1  reasoningEfforts = ["high"]                    ← 只有一档
  //   #2  reasoningEfforts = ["high"]                    ← 只有一档
  //   #3  reasoningEfforts = ["low","medium","max",...]  ← 多档
  // 一人一票时 #1/#2 各投 `high`，#3 投别的 → `high` 2 票胜出，
  // **四档全部落到 high**，用户设档等于没设。
  //
  // ## 现在：票权 = 该后端的词表档数
  //
  // 词表越丰富，它的映射越有区分度，说话越算数。
  //
  // ## 但还有一个更隐蔽的陷阱（第十六轮 #163）
  //
  // 实测发现：**运行时** `resolveChainWordFor` 拿到的词表可能比
  // `/v1/models` 里显示的少 —— 因为两条路径查的是不同来源。
  // 线上真实观测到「只有 #1 的 ["high"] 有值，#2/#3 查空」，
  // 于是四档全被压成 `high`。这与 `#162` 的加权无关，是**取词表失败**。
  //
  // 应对：词表为空的后端**不投票**（既有的 empty-list 分支已如此），
  // 但如果**最终只剩下一个「单档词表」的赢家**，说明我们没有足够信息
  // 判断该档真实强弱 —— 此时宁可**不下发档位**（word 留 undefined），
  // 让上游用它自己的默认。硬发一个 `high` 比不发更有害：
  // 用户选 `minimal` 却拿到最强档，还以为设置生效了。
  const all = [...exact, ...scaled]
  const tally = new Map()
  for (const m of all) {
    // 权重下限 1：即便词表只有一档，它也表达了一项事实，不该被完全无视
    const weight = Math.max(1, Number(m.total) || 1)
    tally.set(m.word, (tally.get(m.word) ?? 0) + weight)
  }
  let bestWord
  let bestCount = -1
  for (const [word, count] of tally) {
    const rank = rankOf(word) ?? -1
    const bestRank = bestWord === undefined ? -1 : (rankOf(bestWord) ?? -1)
    if (count > bestCount || (count === bestCount && rank > bestRank)) {
      bestWord = word
      bestCount = count
    }
  }

  // ── 证据不足时不下发（#163）──
  //
  // 判据：**所有投给 winner 的后端，它们的词表都只有一档**。
  // 那意味着「这个词」不是从档位序列里选出来的，而是唯一选项 ——
  // 它无法区分 minimal/low/medium/max，发下去只会让用户以为设置生效。
  const winnerVotes = all.filter((m) => m.word === bestWord)
  const allSingle = winnerVotes.length > 0 && winnerVotes.every((m) => (Number(m.total) || 1) <= 1)
  if (allSingle && tally.size > 0) {
    return {
      mode: 'degraded',
      contract,
      word: undefined,
      strategy: undefined,
      direction: undefined,
      mappedBackends: declaredCount,
      totalBackends: rows.length,
      reason: 'single-tier-only',
      detail,
    }
  }
  const chosenOne = all.find((m) => m.word === bestWord)
  const anyScaled = scaled.some((m) => m.word === bestWord)
  return {
    mode: anyScaled ? 'scaled' : 'native',
    contract,
    word: bestWord,
    strategy: anyScaled ? 'scaled' : 'exact',
    direction: undefined,
    position: chosenOne?.position,
    total: chosenOne?.total,
    mappedBackends: declaredCount,
    totalBackends: rows.length,
    reason: anyScaled
      ? `mapped to this backend's #${chosenOne?.position ?? '?'}/${chosenOne?.total ?? '?'} level`
      : undefined,
    detail,
  }
}

/**
 * 把结果压成对外可读的一句话（响应头 `X-Lantern-Effort-Note` 用）。
 *
 * ⚠ 第十一轮：`scaled` **不是**降级 —— 那才是常态（绝大多数后端用 xhigh/max
 * 而不是 high）。所以它不再返回"no backend declares it exactly"那种吓人的话，
 * 改成如实说明"落到了该家第 N/M 档"。
 *
 * `native` 与 `scaled` 都不算偏差，返回 undefined 免得每条响应挂噪音；
 * 真正的偏差只有 `degraded`（整条链没人声明推理词表 / 词表认不出）。
 *
 * @param {ReturnType<typeof resolveChainLevel>} resolved - `resolveChainLevel()` 的结果。
 * @returns {string|undefined}
 */
export function effortNote(resolved) {
  if (resolved === undefined || resolved === null) return undefined
  if (resolved.mode === 'degraded') {
    return resolved.reason === 'no-backend-supports'
      ? `requested ${resolved.contract}; no backend on this chain declares reasoning levels, so the parameter was not sent`
      : `requested ${resolved.contract}; no backend declares a recognisable level for it, so the parameter was not sent`
  }
  return undefined
}

/**
 * 某条链支持哪些对外档（给 `/v1/models` 外显用）。
 *
 * 语义：只要**有任何一个后端**能兑现，就算这条链支持该档。
 * 这与执行侧"按值筛链"一致 —— 某个档能不能用，取决于链上有没有人接得住。
 *
 * @param {Array<{efforts?: string[]}>} backends - 各后端的词表。
 * @returns {string[]} 四档的子集（保持 CONTRACT_LEVELS 顺序）。
 */
export function supportedContractLevels(backends) {
  const rows = Array.isArray(backends) ? backends : []
  return CONTRACT_LEVELS.filter((level) =>
    rows.some((row) => mapLevelToBackend(row?.efforts, level).ok === true),
  )
}

/**
 * 某条链**能兑现**的档位（给面板"这条链实际能做到什么"用）。
 *
 * 与 `supportedContractLevels` 的区别：这里返回每档落到的真实词，
 * 便于面板显示 `high → max` 这种对照关系。
 *
 * @param {Array<{efforts?: string[]}>} backends - 各后端的词表。
 * @returns {Array<{ level: string, word: string|undefined, mode: string }>}
 */
export function describeChainLevels(backends) {
  const rows = Array.isArray(backends) ? backends : []
  return CONTRACT_LEVELS.map((level) => {
    const r = resolveChainLevel(rows, level)
    return { level, word: r.word, mode: r.mode }
  })
}
