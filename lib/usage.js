/**
 * dsh-lantern — 用量记账与报告（P9）。
 *
 * 设计要点（设计方案 §11.6）：
 * 1. **只统计"经由本插件"的调用**，不碰 DSH 自己的 token 统计（口径不同）；
 * 2. 账本是插件目录内的 JSONL，追加式，滚动保留；
 * 3. 报告是**自包含单文件 HTML**（内联 CSS/SVG，零 CDN），可用默认浏览器打开；
 * 4. 区分**每个 API Key** 的用量（显示名称 + 指纹），并单列**测试用量**；
 * 5. 命中率口径（已查实，DSH 计数是**互斥**的）：
 *    `输入(未命中) = inputTokens`、`输入(命中) = cacheReadTokens`，
 *    `合计 = 未命中 + 命中 + 缓存写 + 输出`；
 *    命中率 = `Σ命中 / Σ(未命中 + 命中)`，**加权而非行平均**；
 *    无缓存数据的 provider 显示 `—`（不是 0%）。
 *
 * @module dsh-lantern/usage
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, readJsonlStreaming, PATHS } from './storage.js'

/** 一天/一周/一月/一年的毫秒数（用于分桶）。 */
const DAY_MS = 24 * 60 * 60 * 1000
/** 单位换算：1 M token。 */
export const MILLION = 1_000_000

/**
 * 账本滚动的默认阈值（16MB）：与 DEFAULT_CONFIG.usage.maxLedgerBytes 保持一致。
 * recordUsage 不读配置（配置对象不在它的入参里，且热路径上每次记账都去取配置
 * 属于本末倒置），所以用常量兜底；上限是防"写爆磁盘"而不是精确配额。
 */
const DEFAULT_MAX_LEDGER_BYTES = 16 * 1024 * 1024

// ── aggregate() 缓存（第十八轮 #189）──
//
// 为什么必须加：实测 usage.jsonl 到 8.24 MB / 27,683 行时，
// 一次 aggregate() 全量流式扫描要 **134–162 ms**。
// 而 `usage/summary` 是设置面板的常驻 RPC（前端打开面板就拉、切换粒度还拉），
// 每次 150 ms 的扫描会把事件循环占住，局域网请求跟着卡。
//
// 缓存键用「文件大小 + mtimeMs」而不是 TTL：
//   · 账本只在有调用时追加 → 没新调用时重算是纯浪费，大小/mtime 不变即命中；
//   · 有新调用时 mtime 必变 → 自动失效，**不会返回陈旧数据**。
// 这比 "缓存 5 秒" 精确：TTL 会在刚记账后返回旧数据，而面板恰恰要看最新数字。
/** @type {Map<string, { key: string, value: unknown }>} 按 granularity 分桶的缓存 */
const aggregateCache = new Map()

/** 读账本的「版本指纹」：大小 + mtime。读不到（文件不存在）返回固定串。 */
function ledgerFingerprint() {
  try {
    const st = statSync(PATHS.usage)
    return st.size + ':' + st.mtimeMs
  } catch {
    return 'missing'
  }
}

/**
 * 让 aggregate 缓存失效。
 * 记账后必须调用 —— 否则面板会一直看到上一笔之前的数据。
 */
export function invalidateAggregateCache() {
  aggregateCache.clear()
}

/**
 * 滚动账本：当前 usage.jsonl 超过阈值时改名归档，再新开一本。
 *
 * 归档名 usage-archive-<YYYYMMDD-HHmmss>.jsonl（时间戳到秒）：
 * 用序号会在同一天多次滚动时互相覆盖语义（"第 2 本"是哪本？），
 * 时间戳自解释且天然递增。报告聚合（aggregate）只读当前这本——
 * 历史账本安静躺在 data/ 里，需要时手工并回来即可。
 *
 * 竞态说明：recordUsage 是插件内的串行路径（每个请求完成后调用），
 * 单进程 Node 下 check→rename 之间没有并发写入者，不需要锁。
 */
async function rollLedgerIfNeeded(maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_LEDGER_BYTES
  try {
    const size = statSync(PATHS.usage).size
    if (size <= limit) return
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp =
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      '-' +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds())
    // 归档名必须**保证不覆盖**已有文件。
    //
    // 时间戳只到秒，而 Windows 的 renameSync 在目标已存在时是**静默覆盖**
    // （实测：不报错、直接换掉），于是"账本刚超限时两个并发请求同时滚动"
    // 就会把第一次的归档整段吞掉，且下面的 catch 什么都不会说。
    // 这里退让式找第一个空位：同秒第二次滚动落到 -1、第三次 -2……宁可名字难看，
    // 也不能丢历史账本。
    const base = 'usage-archive-' + stamp
    let target = join(PATHS.data, base + '.jsonl')
    for (let i = 1; existsSync(target); i += 1) {
      target = join(PATHS.data, base + '-' + i + '.jsonl')
      if (i > 1000) throw new Error('归档名冲突过多')
    }
    renameSync(PATHS.usage, target)
  } catch {
    // 不存在（首次记账）或归档失败都不记账里去：记账路径绝不能因为
    // 滚动失败而丢掉业务记录本身，宁可让文件继续长大等下一次滚动。
  }
}

/**
 * 把一次调用记入账本。
 *
 * 记录形态（字段名刻意用 inMiss/inHit，让"未命中/命中"一眼可辨）：
 *   { ts, provider, model, publicName, keyId, keyLabel, keyPrint,
 *     kind: 'inference'|'test'|'perf', status, ms, usage:{inMiss,inHit,cacheWrite,out,reasoning,total} }
 *
 * @param entry - 一条记录（见上）。
 * @returns Promise<void>。
 */
export async function recordUsage(entry, options = undefined) {
  const maxBytes = options?.maxLedgerBytes
  if (maxBytes === undefined || maxBytes === null) {
    // 默认路径：读一次配置文件里的 usage.maxLedgerBytes（若插件把配置传进来了则免读盘）。
    await rollLedgerIfNeeded(readLedgerLimitFromConfig())
  } else {
    await rollLedgerIfNeeded(Number(maxBytes))
  }
  await appendJsonl(PATHS.usage, entry)
  // #189：账本变了，aggregate 缓存必须失效，否则面板看到旧的汇总。
  invalidateAggregateCache()
}

/**
 * 从插件配置里读 usage.maxLedgerBytes；读不到/不合法回退默认值。
 *
 * ── #190 加缓存 ──
 * 这个函数在**每个请求的收尾路径**上被调用（recordUsage → rollLedgerIfNeeded）。
 * 原来每次都 readFileSync + JSON.parse 一遍 config.json：单次 0.1–0.3 ms 不多，
 * 但它是**同步阻塞事件循环**的，高频并发下会累积成可见的卡顿。
 *
 * 缓存键用 config.json 的 mtime：改配置立刻生效，不改就复用。
 */
let ledgerLimitCache = { mtime: -1, value: DEFAULT_MAX_LEDGER_BYTES }

function readLedgerLimitFromConfig() {
  try {
    const st = statSync(PATHS.config)
    if (st.mtimeMs === ledgerLimitCache.mtime) return ledgerLimitCache.value
    const text = readFileSync(PATHS.config, 'utf8')
    const parsed = JSON.parse(text)
    const raw = parsed?.usage?.maxLedgerBytes
    const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_LEDGER_BYTES
    ledgerLimitCache = { mtime: st.mtimeMs, value }
    return value
  } catch {
    return DEFAULT_MAX_LEDGER_BYTES
  }
}

/**
 * 把 DSH 的 TokenUsage 转成账本口径（互斥计数，口径见模块注释）。
 * @param usage - DSH TokenUsage（可能是 undefined）。
 * @returns 账本 usage 对象，或 undefined（没有用量数据）。
 */
export function toLedgerUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const inMiss = usage.inputTokens ?? 0
  const inHit = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens
  const out = usage.outputTokens ?? 0
  const reasoning = usage.reasoningTokens
  const total = inMiss + inHit + (cacheWrite ?? 0) + out
  return {
    inMiss,
    inHit,
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    out,
    ...(reasoning === undefined ? {} : { reasoning }),
    total,
    // provider 到底有没有提供过缓存字段 —— 和"缓存全未命中"是两件事。
    // 早先靠 `inHit > 0 || cacheWrite > 0` 反推，于是"这家有缓存、只是这次没命中"
    // 与"这家根本不报缓存"被判成同一类，命中率一律印成 `—`。
    hasCache: cacheWrite !== undefined || usage.cacheReadTokens !== undefined,
  }
}

/** 本地时区的日键 `YYYY-MM-DD`。 */
function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时区的月键 `YYYY-MM`。 */
function monthKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 本地时区的年键 `YYYY`。 */
function yearKey(ts) {
  return String(new Date(ts).getFullYear())
}

/**
 * ISO 8601 周键 `YYYY-Www`（**周一起算**，跨年周按 ISO 规则归属）。
 * 这样避免"12/31 算哪一年"的歧义。
 * @param ts - 时间戳。
 * @returns ISO 周键。
 */
function isoWeekKey(ts) {
  const d = new Date(ts)
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay() // 周一=1 … 周日=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum) // 移到本周四
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 一个聚合桶：累计 token 与请求数。
 * @returns 空桶。
 */
function emptyBucket() {
  return { inMiss: 0, inHit: 0, cacheWrite: 0, out: 0, reasoning: 0, total: 0, calls: 0, failed: 0, hasCacheData: false }
}

/**
 * 把一条记录累加进桶。
 * @param bucket - 目标桶。
 * @param u - 账本 usage。
 */
function addToBucket(bucket, u) {
  if (u === undefined) return
  bucket.inMiss += u.inMiss ?? 0
  bucket.inHit += u.inHit ?? 0
  bucket.cacheWrite += u.cacheWrite ?? 0
  bucket.out += u.out ?? 0
  bucket.reasoning += u.reasoning ?? 0
  bucket.total += u.total ?? 0
  // "provider 提供过缓存字段" ≠ "这次命中了缓存"。
  // 新记录带 hasCache（由 toLedgerUsage 按字段是否存在判定）；
  // 老账本没有这个字段，只能退回按数值推断。
  if (u.hasCache === true) bucket.hasCacheData = true
  else if (u.hasCache === undefined && ((u.inHit ?? 0) > 0 || (u.cacheWrite ?? 0) > 0)) bucket.hasCacheData = true
}

/**
 * 加权命中率（`Σ命中 / Σ(未命中+命中)`），**不是行平均**。
 * @param bucket - 桶。
 * @returns 命中率 0–1，或 null（无缓存数据 → 显示 `—`）。
 */
export function hitRateOf(bucket) {
  const denom = bucket.inMiss + bucket.inHit
  if (!bucket.hasCacheData || denom <= 0) return null
  return bucket.inHit / denom
}

/**
 * 读数账本并做多维度聚合。
 *
 * 维度：时间粒度（日/周/月/年）× provider × model × **API Key** × **调用类型**。
 *
 * @param options - `{ granularity, sinceMs, nowMs }`。
 * @returns `{ buckets, totals, keys, providers, models, kinds, range }`。
 */
export async function aggregate({ granularity = 'daily', nowMs = Date.now(), fromMs, toMs } = {}) {
  // ── #189 缓存层 ──
  //
  // 同一份账本 + 同一个粒度 + 同一时间窗 → 直接返回上次算好的结果。
  // `nowMs` 参与缓存键：不同「当期」窗口算出的 totals 不同，不能混用。
  //
  // 注：nowMs 默认 Date.now()，同一秒内的多次调用会命中；
  // 跨秒会重算一次，但那时账本多半也变了（指纹校验会兜住）。
  // 若要让"纯查看"完全零开销，可把 nowMs 粗化成分钟 —— 但那会让
  // "刚刚的调用"延迟最多 60 秒才出现在面板上，不值得。
  const cacheKey = granularity + '|' + nowMs + '|' + String(fromMs ?? '') + '|' + String(toMs ?? '') + '|' + ledgerFingerprint()
  const cached = aggregateCache.get(granularity)
  if (cached !== undefined && cached.key === cacheKey) return cached.value
  const result = await aggregateInner({ granularity, nowMs, fromMs, toMs })
  aggregateCache.set(granularity, { key: cacheKey, value: result })
  return result
}

/**
 * aggregate 的实际实现（无缓存）。
 * @param options - 同 aggregate。
 * @returns 聚合结果。
 */
async function aggregateInner({ granularity = 'daily', nowMs = Date.now(), fromMs, toMs } = {}) {
  // 认不出的粒度不能静默退化成 daily：回包里的 granularity 仍是用户传的原值，
  // 于是"客户端以为按年聚合、实际拿到按天的桶"——比直接报错难查得多。
  const bucketsOf = { daily: dayKey, weekly: isoWeekKey, monthly: monthKey, yearly: yearKey }
  const resolvedGranularity = bucketsOf[granularity] === undefined ? 'daily' : granularity
  const keyOf = bucketsOf[resolvedGranularity] ?? dayKey

  // 当期桶键：totals 与各维度汇总**只统计这个窗口内**的调用。
  //
  // 早先这里没有窗口概念：四个粒度都拿全账本往 totals 里加，
  // 于是报告「今日 / 本周 / 本月 / 今年」四张卡永远显示同一个数（真账本实测
  // 今日卡 657059475 vs 今日真实 467438，偏 1405 倍），而「按 API Key 汇总（本月）」
  // 里能出现 400 天前才有调用的 Key。细表（cells/bucketKeys）仍保留全部历史，
  // 那才是"看历史"的地方；卡片和汇总表回答的是"当期多少"。
  const windowKey = keyOf(nowMs)

  // ── #235：可选的时间范围筛选 ──
  //
  // 默认口径是"当期窗口"（当日/当周/当月/当年，由 granularity 决定），
  // 那是「今日/本周/本月/今年」四张卡的语义。
  //
  // 但用户常问"最近 7 天用了多少"——那不是任何一个粒度。
  // 所以加一对可选的 `fromMs`/`toMs`：
  //   · 传了 → 汇总口径改成"落在区间内的记录"（与当期窗口无关）；
  //   · 没传 → 保持原行为（当期窗口）。
  //
  // 明细（cells/bucketKeys）始终保留全部历史，不受影响。
  const useRange = Number.isFinite(fromMs) || Number.isFinite(toMs)
  const rangeStart = Number.isFinite(fromMs) ? Number(fromMs) : -Infinity
  const rangeEnd = Number.isFinite(toMs) ? Number(toMs) : Infinity
  const inRange = (ts) => ts >= rangeStart && ts <= rangeEnd

  /** @type {Map<string, {bucket:object, dims:{provider:string,model:string,keyId:string,kind:string}}>} */
  const cells = new Map()
  /** 全局合计。 */
  const totals = emptyBucket()
  /** 按 key 汇总。 */
  const byKey = new Map()
  /** 按 provider 汇总。 */
  const byProvider = new Map()
  /** 按模型（provider:model）汇总。 */
  const byModel = new Map()
  /** #234：按「用户请求的模型名」汇总（自定义模型名 / 公开名）。 */
  const byRequested = new Map()
  /** #235：按「请求名 × 时间桶」的明细 —— 供面板画迷你趋势图。 */
  const byRequestedBucket = new Map()
  /** 按调用类型汇总（推理 / 测试 / 性能测试）。 */
  const byKind = new Map()
  /** 各粒度的桶集合（用于柱状图）。 */
  const bucketOrder = new Set()
  let earliest = null
  let latest = null
  let lines = 0

  const getCell = (bucketKey, provider, model, keyId, kind) => {
    const k = `${bucketKey}\u0000${provider}\u0000${model}\u0000${keyId}\u0000${kind}`
    let cell = cells.get(k)
    if (cell === undefined) {
      cell = { bucketKey, bucket: emptyBucket(), provider, model, keyId, kind }
      cells.set(k, cell)
    }
    return cell
  }
  const bump = (map, key, u) => {
    let b = map.get(key)
    if (b === undefined) {
      b = emptyBucket()
      map.set(key, b)
    }
    addToBucket(b, u)
    return b
  }

  await readJsonlStreaming(PATHS.usage, (rec) => {
    if (rec === null || typeof rec !== 'object') return
    const ts = Number(rec.ts)
    if (!Number.isFinite(ts)) return
    lines += 1
    if (earliest === null || ts < earliest) earliest = ts
    if (latest === null || ts > latest) latest = ts

    const provider = String(rec.provider ?? 'unknown')
    const model = String(rec.model ?? 'unknown')
    // ⚠ 功能测试 / 性能实测是**面板自己发起的内部探测**，不经过局域网鉴权，
    // 所以记账时拿不到 key，历史上一律落成 keyId='anonymous'。
    // 用户看到「（匿名访问）」会以为有人绕过鉴权在用额度 —— 实际并没有。
    // 这里在聚合层把它们归一化为 internal（含历史数据），从此按
    // 「内部功能测试」显示并默认隐藏，不再伪装成匿名访问。
    const kind = String(rec.kind ?? 'inference')
    // ⚠ 不能无条件覆盖：老版本 / 第三方写入方可能把探测流量记在**真实 Key** 上。
    // 那种记录是真实用量，强制改成 internal 会让它在所有表里消失（internal 默认隐藏）。
    // 只把「本来就没有 Key」的探测归一到 internal。
    const rawKey = String(rec.keyId ?? 'anonymous')
    const keyId = (kind === 'test' || kind === 'perf') && rawKey === 'anonymous'
      ? 'internal'
      : rawKey
    const u = rec.usage
    const bk = keyOf(ts)
    bucketOrder.add(bk)

    const hasUsage = u !== undefined && u !== null
    // 明细表（cells）保留**全部历史**：那是"看历史"的地方。
    if (hasUsage) {
      const cell = getCell(bk, provider, model, keyId, kind)
      addToBucket(cell.bucket, u)
      cell.bucket.calls += 1
      if (rec.status !== 'ok') cell.bucket.failed += 1
    }
    // 汇总口径（totals / keys / providers / models / kinds）**只看统计窗口**。
    // #235：默认是"当期桶"；传了 fromMs/toMs 时改成"时间区间"。
    // 出窗口也不是白扫：失败次数在上面 cells 里已经记过了。
    if (useRange) {
      if (!inRange(ts)) return
    } else if (bk !== windowKey) {
      return
    }

    if (hasUsage) addToBucket(totals, u)
    // 每一行都算一次调用（含没有 usage 的失败行）
    totals.calls += 1
    // 各维度汇总：token 累加（有 usage 时）+ 调用计数（总是）
    const kb = bump(byKey, keyId, u)
    kb.calls += 1
    const pb = bump(byProvider, provider, u)
    pb.calls += 1
    const mb = bump(byModel, `${provider}\u0000${model}`, u)
    mb.calls += 1
    // ── #234：按「用户请求的模型名」再聚合一份 ──
    //
    // `byModel` 的 key 是上游真实坐标（provider + model），回答的是
    // "上游哪个模型最费"；而用户想知道的是"**我配的那个模型**一共花了多少"。
    //
    // 新账本有 `requestedModel`（buildFailoverPlans 挂上去的请求名）；
    // 老账本没有 → 回退用 publicName（真实坐标），保证历史数据不丢。
    // 两者混在一张表里是可接受的：那一列本来就叫"模型名"，
    // 老数据显示坐标、新数据显示自定义名，用户能看出来是新是旧。
    const reqName = typeof rec.requestedModel === 'string' && rec.requestedModel.length > 0
      ? rec.requestedModel
      : String(rec.publicName ?? 'unknown')
    const rb = bump(byRequested, reqName, u)
    rb.calls += 1
    // #235：同时按「请求名 × 桶」记一份，供面板画迷你趋势图。
    // 用"名称 + 桶"两段做 key，扁平存 —— 比嵌套 Map 省一层对象开销，
    // 输出时由调用方按名称分组（模型数×桶数量级很小，不值得为它建树）。
    {
      const rbKey = reqName + '\u0000' + bk
      let rbb = byRequestedBucket.get(rbKey)
      if (rbb === undefined) {
        rbb = emptyBucket()
        byRequestedBucket.set(rbKey, rbb)
      }
      addToBucket(rbb, u)
      rbb.calls += 1
    }
    const kd = bump(byKind, kind, u)
    kd.calls += 1
    // 失败：不计 token，但**每个维度都要计失败次数**（漏掉会让"按类型"表的失败列恒为 0）
    if (rec.status !== 'ok') {
      kb.failed += 1
      pb.failed += 1
      mb.failed += 1
      rb.failed += 1
      kd.failed += 1
      totals.failed += 1
    }
  })

  return {
    granularity: resolvedGranularity,
    granularityRequested: granularity,
    granularityFellBack: resolvedGranularity !== granularity,
    // 汇总统计的是哪个时间桶（cards 与三张汇总表的窗口）
    windowKey,
    rangeFrom: Number.isFinite(fromMs) ? Number(fromMs) : null,
    rangeTo: Number.isFinite(toMs) ? Number(toMs) : null,
    bucketKeys: [...bucketOrder].sort(),
    cells: [...cells.values()].map((c) => ({
      bucketKey: c.bucketKey,
      provider: c.provider,
      model: c.model,
      keyId: c.keyId,
      kind: c.kind,
      ...c.bucket,
      hitRate: hitRateOf(c.bucket),
    })),
    totals: { ...totals, hitRate: hitRateOf(totals), lines },
    keys: [...byKey.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    providers: [...byProvider.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    models: [...byModel.entries()].map(([id, b]) => {
      const [provider, model] = id.split('\u0000')
      return { provider, model, ...b, hitRate: hitRateOf(b) }
    }),
    // #234：按"用户请求的模型名"汇总 —— 这才是用户心智里的"模型"。
    requested: [...byRequested.entries()].map(([name, b]) => ({ name, ...b, hitRate: hitRateOf(b) })),
    // #235：请求名 × 桶 的扁平明细（面板迷你趋势图用）。
    // 每项 `{ name, bucketKey, total, calls }`；按 bucketKey 升序返回，
    // 调用方直接画，不用再排。
    requestedBuckets: [...byRequestedBucket.entries()]
      .map(([k, b]) => {
        const at = k.lastIndexOf('\u0000')
        return { name: k.slice(0, at), bucketKey: k.slice(at + 1), total: b.total, calls: b.calls }
      })
      .sort((a, b) => a.bucketKey.localeCompare(b.bucketKey)),
    kinds: [...byKind.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    range: { earliest, latest },
  }
}

/** 把 token 数格式化为 M（保留 3 位小数）。 */
export function fmtM(n) {
  return (Number(n ?? 0) / MILLION).toFixed(3)
}

/** 把命中率格式化为百分数，无数据显示 `—`。 */
export function fmtRate(r) {
  return r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`
}

/** HTML 转义（报告里所有来自数据的文本都要过一遍）。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 调用类型的中文标签。 */
const KIND_LABEL = { inference: '推理调用', test: '功能测试', perf: '性能测试' }

/**
 * 生成自包含的用量报告 HTML。
 *
 * ── 为什么重写（#224）──
 *
 * 上一版把 4 个粒度的明细树（桶 → provider → model×key）**各完整渲染一遍**。
 * 实测：439 KB、12,381 个 `<td>`（日 611 行 / 周 352 / 月 301 / 年 290）。
 * 三个具体毛病：
 *   1. **体积**：浏览器打开明显卡顿，发给人也不方便；
 *   2. **看不清**：三层缩进挤在同一列（「时间桶 / 模型」+「API Key」），
 *      想回答"哪个模型最费 token"要一行行找；
 *   3. **数据白算**：`aggregate()` 已经算出 `models` / `providers` 汇总，
 *      报告却完全没用它们。
 *
 * 现在按**维度拆成小表**，每张表只回答一个问题：
 *   概览 → 按模型 → 按上游 → 按 Key → 按类型 → 趋势（4 粒度） → 明细 Top N
 *
 * 体积从 439 KB 降到约 50 KB，代码从 282 行降到约 170 行。
 *
 * 口径（与面板、账本一致，写在页脚）：
 *   · 合计 = 未命中 + 命中 + 缓存写 + 输出；推理 token 已含在输出里；
 *   · 命中率 = 命中 ÷（未命中 + 命中），分组为加权；`—` 表示该来源没给缓存数据；
 *   · 失败请求计入次数但不计 token。
 *
 * @param options - `{ keyLabels, timezone, nowMs }`。
 *   `keyLabels` 为 `keyId -> { label, fingerprint }`。
 * @returns HTML 字符串。
 */
export async function buildReportHtml({ keyLabels = new Map(), timezone = 'local', nowMs = Date.now(), liveNames } = {}) {
  const GRAN_LABEL = { daily: '每日', weekly: '每周', monthly: '每月', yearly: '每年' }
  const views = Object.keys(GRAN_LABEL)
  const data = {}
  for (const g of views) data[g] = await aggregate({ granularity: g, nowMs })

  const tzName = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return timezone
    }
  })()

  const keyNameOf = (id) => {
    const info = keyLabels.get(id)
    if (info !== undefined) return { label: info.label ?? id, print: info.fingerprint ?? '' }
    if (id === 'internal') return { label: '（内部功能测试）', print: '—' }
    if (id === 'anonymous') return { label: '（匿名访问）', print: '—' }
    if (id === 'unknown') return { label: '（未知来源）', print: '—' }
    return { label: id, print: '' }
  }

  /** 6 个数值列（顺序与表头固定一致）。 */
  const numCells = (b) => [
    fmtM(b.inMiss),
    fmtM(b.inHit),
    fmtM(b.cacheWrite),
    fmtM(b.out),
    `<b>${fmtM(b.total)}</b>`,
    fmtRate(b.hitRate),
  ]

  /** 通用表：`heads` 决定列数；第一列（名称列）左对齐，其余右对齐。 */
  const table = (heads, rows, empty = '暂无数据') =>
    `<table><thead><tr>${heads.map((h, i) => `<th${i === 0 ? '' : ' class="r"'}>${h}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length > 0
      ? rows.join('')
      : `<tr><td colspan="${heads.length}" class="empty">${empty}</td></tr>`) +
    '</tbody></table>'

  /** 一行：若干标签列 + 6 个数值列。 */
  const line = (labels, b) =>
    `<tr>${labels.map((x, i) => `<td${i === 0 ? '' : ' class="r"'}>${x}</td>`).join('')}` +
    `${numCells(b).map((x) => `<td class="r">${x}</td>`).join('')}</tr>`

  /** 把一批 bucket 累加成一行（用于「其他 N 个」和父级小计）。 */
  const mergeBuckets = (list) => {
    const sum = emptyBucket()
    for (const b of list) addToBucket(sum, b)
    sum.hasCacheData = list.some((b) => b.hasCacheData === true)
    return { ...sum, hitRate: hitRateOf(sum) }
  }

  /** 取 Top N，剩下的合并成「其他」。 */
  const splitTop = (list, n) => {
    const sorted = list.slice().sort((a, b) => totalOf(b) - totalOf(a))
    return { head: sorted.slice(0, n), rest: sorted.slice(n) }
  }
  const totalOf = (x) => Number(x.total ?? 0)

  // ── 1. 概览 ──
  const t = data.daily.totals
  const w = data.weekly.totals
  const m = data.monthly.totals
  const y = data.yearly.totals
  const cards = [
    ['今日', `${fmtM(t.total)}<small> M</small>`],
    ['本周', `${fmtM(w.total)}<small> M</small>`],
    ['本月', `${fmtM(m.total)}<small> M</small>`],
    ['今年', `${fmtM(y.total)}<small> M</small>`],
    ['命中率（本月 · 加权）', fmtRate(m.hitRate)],
    ['本月请求 / 失败', `${m.calls} <small>/ ${m.failed}</small>`],
  ]
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('')

  const SUM_HEADS = ['未命中', '命中', '缓存写', '输出', '合计 M', '命中率']

  // ── 2. 按模型（最实用的一张：哪个模型最费）──
  // #234：改用"用户请求的模型名"（requested），与面板口径一致。
  // `liveNames` 由调用方传入（当前可用的模型名集合）；没传就全部当在线。
  // 已下线的标灰 + 加「·已下线」后缀，让读者一眼看出这是历史而非在用的。
  const isLive = (name) => !(liveNames instanceof Set) || liveNames.size === 0 || liveNames.has(name)
  const modelList = data.monthly.requested
    .filter((x) => x.calls > 0)
    .map((x) => ({ ...x, live: isLive(x.name) }))
    // 报表只列**当前还在用**的模型；已下线的历史行不进排行。
    // （面板里可以勾选"显示历史条目"看它们，报表是给人看的简报，不必带上。）
    .filter((x) => x.live)
    // 在线优先，同组内按总量降序
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
  const modelSplit = { head: modelList.slice(0, 12), rest: modelList.slice(12) }
  const modelRows = modelSplit.head.map((x) => {
    const tag = x.live ? '' : ' <span class="dead">·已下线</span>'
    const r = line([`${esc(x.name)}${tag}`], x)
    return x.live ? r : r.replace('<tr>', '<tr class="deadRow">')
  })
  if (modelSplit.rest.length > 0) {
    // 「其他」合并：不能直接 mergeBuckets（那些项带 live 字段但不影响求和）
    const merged = mergeBuckets(modelSplit.rest)
    modelRows.push(line([`其他 ${modelSplit.rest.length} 个模型`], merged))
  }

  // ── 3. 按上游 ──
  const provList = data.monthly.providers.filter((x) => x.calls > 0)
  const provSplit = splitTop(provList, 12)
  const provRows = provSplit.head.map((x) => line([esc(x.id)], x))
  if (provSplit.rest.length > 0) {
    provRows.push(line([`其他 ${provSplit.rest.length} 个上游`], mergeBuckets(provSplit.rest)))
  }

  // ── 4. 按 API Key ──
  // 匿名 / 未知来源不进入报表：未开启匿名访问时它们不该出现；
  // 即使曾经开着，把"匿名"当成一个用户来统计也没有意义。
  const keyList = data.monthly.keys
    .filter((x) => x.calls > 0 && x.id !== 'anonymous' && x.id !== 'unknown' && x.id !== 'internal')
  const keySplit = splitTop(keyList, 12)
  const keyRows = keySplit.head.map((x) => {
    const kn = keyNameOf(x.id)
    return line([esc(kn.label), `<span class="fp">${esc(kn.print)}</span>`], x)
  })
  if (keySplit.rest.length > 0) {
    keyRows.push(line([`其他 ${keySplit.rest.length} 个`, ''], mergeBuckets(keySplit.rest)))
  }

  // ── 5. 按调用类型 ──
  const kindRows = data.monthly.kinds
    .filter((x) => x.calls > 0)
    .sort((a, b) => totalOf(b) - totalOf(a))
    .map((x) => line([esc(KIND_LABEL[x.id] ?? x.id)], x))

  // ── 6. 趋势：每个粒度「总量柱状图 + 桶汇总表」──
  const PALETTE = ['#1677ff', '#389e0d', '#d46b08', '#722ed1', '#13c2c2', '#eb2f96', '#faad14', '#2f54eb']
  const renderTrend = (g, idx) => {
    const d = data[g]
    // 桶汇总（每桶一行，跨 provider 合并）
    const perBucket = new Map()
    for (const bk of d.bucketKeys) perBucket.set(bk, [])
    for (const c of d.cells) {
      if (c.total <= 0) continue
      const arr = perBucket.get(c.bucketKey)
      if (arr !== undefined) arr.push(c)
    }
    const bucketRows = []
    const bucketTotals = []
    for (const [bk, cells] of perBucket) {
      const merged = mergeBuckets(cells)
      bucketTotals.push({ bk, total: merged.total })
      if (cells.length > 0) bucketRows.push(line([esc(bk)], merged))
    }
    bucketRows.reverse()
    bucketTotals.reverse()

    // 柱状图（只画总量，不分色 —— 分色会让图例吃掉半屏，且总量才是"趋势"要看的）
    const bars = bucketTotals.slice(0, 31)
    const maxT = Math.max(1, ...bars.map((b) => b.total))
    const chartH = 150
    const barW = bars.length > 0 ? Math.max(6, Math.min(40, Math.floor(720 / bars.length) - 6)) : 20
    let x = 40
    let svg = ''
    for (const b of bars) {
      const h = Math.max(1, Math.round((b.total / maxT) * (chartH - 24)))
      const y = chartH - h
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${PALETTE[idx % PALETTE.length]}"><title>${esc(b.bk)}: ${fmtM(b.total)} M</title></rect>`
      svg += `<text x="${x + barW / 2}" y="${chartH + 13}" font-size="9" text-anchor="middle" fill="#8a8f99">${esc(b.bk.slice(-5))}</text>`
      if (bars.length <= 16) {
        svg += `<text x="${x + barW / 2}" y="${y - 4}" font-size="9" text-anchor="middle" fill="#555">${(b.total / MILLION).toFixed(1)}</text>`
      }
      x += barW + 6
    }
    const svgW = Math.max(760, x + 20)
    const yearNote = g === 'yearly' && d.range.latest !== null
      ? `<div class="note">当年统计截至 ${esc(dayKey(d.range.latest))}（并非完整年度）</div>`
      : ''
    return `<section class="view${idx === 0 ? ' on' : ''}" data-view="${g}">
  <div class="row"><h2>${GRAN_LABEL[g]}趋势</h2>${yearNote}</div>
  <div class="chartWrap"><svg viewBox="0 0 ${svgW} ${chartH + 24}" width="100%" height="${chartH + 24}">
    <line x1="30" y1="${chartH}" x2="${svgW - 10}" y2="${chartH}" stroke="#e5e7eb"/>${svg}
  </svg></div>
  ${table(['时间桶', ...SUM_HEADS], bucketRows, '该粒度暂无用量')}
</section>`
  }

  // ── 7. 明细（跨桶 Top 100，按合计降序）──
  const detailCells = data.daily.cells.filter((c) => c.total > 0).sort((a, b) => b.total - a.total)
  const DETAIL_MAX = 100
  const detailRows = detailCells.slice(0, DETAIL_MAX).map((c) => {
    const kn = keyNameOf(c.keyId)
    return line(
      [esc(c.bucketKey), esc(c.provider), esc(c.model), esc(kn.label), esc(KIND_LABEL[c.kind] ?? c.kind)],
      c,
    )
  })

  // ── #228：CSV 导出 ──
  //
  // 明细表只显示 Top 100（控制体积），但"要看全部"是合理需求。
  // 做法：把**全部**明细压成一个紧凑数组内嵌进 HTML，点按钮时用 JS 生成 CSV 下载。
  //
  // 为什么用数组而不是直接拼 CSV 字符串：
  //   · 数组 + JSON.stringify 比手写 CSV 转义更不容易错（引号/逗号/换行）；
  //   · 体积也更小（约 40 KB 对 498 条）。
  // 为什么放内嵌而不是另开一个下载接口：
  //   报告是自包含单文件（可以发给别人、离线打开），多一个接口就多一个失效点。
  const csvData = detailCells.map((c) => {
    const kn = keyNameOf(c.keyId)
    return [
      c.bucketKey,
      c.provider,
      c.model,
      kn.label,
      KIND_LABEL[c.kind] ?? c.kind,
      c.inMiss ?? 0,
      c.inHit ?? 0,
      c.cacheWrite ?? 0,
      c.out ?? 0,
      c.total ?? 0,
      c.hitRate === null || c.hitRate === undefined ? '' : (c.hitRate * 100).toFixed(1),
      c.calls ?? 0,
      c.failed ?? 0,
    ]
  })
  // ⚠ 不能只替换精确的 `</script>`：HTML 结束标签允许 `</script >`、
  // `</script/>`、`</SCRIPT\t>` 等变体，正则 /<\/script>/gi 一个都挡不住。
  // csvData 里含 Key label / provider / model 名等自由文本，注入
  // `</script ><img src=x onerror=...>` 就能提前闭合脚本并在打开报告的人
  // 机器上执行 —— 报告是「自包含单文件、可以发给别人」的，属存储型 XSS。
  // 把所有 `<` 转义成 \u003c：JSON 解析后仍是原字符，但 HTML 解析器
  // 再也看不到任何 `<`，无论后面跟什么。
  const csvJson = JSON.stringify(csvData).replace(/</g, '\\u003c')

  const rangeText = data.daily.range.latest === null
    ? '<b>账本为空</b>'
    : `${esc(dayKey(data.daily.range.earliest))} ~ ${esc(dayKey(data.daily.range.latest))}`

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LANtern · Token 用量报告</title>
<style>
:root{--fg:#1a1a1a;--fg2:#555;--fg3:#8a8f99;--bd:#e5e7eb;--bd2:#eef0f3;--bg:#fff;--accent:#1677ff;--ok:#389e0d}
@media (prefers-color-scheme:dark){:root{--fg:#e8eaed;--fg2:#b8bcc4;--fg3:#8a8f99;--bd:#3c4043;--bd2:#2a2d31;--bg:#1f1f1f}}
*{box-sizing:border-box}
body{margin:0;padding:24px 28px 60px;font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg);max-width:1400px}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:15px;margin:26px 0 8px}
.sub{color:var(--fg2);font-size:12.5px;margin-bottom:18px}
.cards{display:flex;gap:10px;flex-wrap:wrap}
.card{border:1px solid var(--bd2);border-radius:12px;padding:10px 14px;min-width:150px;flex:1 1 150px}
.card .k{font-size:11.5px;color:var(--fg3)}
.card .v{font-size:19px;font-weight:640;margin-top:2px}
.card .v small{font-size:11px;font-weight:400;color:var(--fg3)}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}
th{text-align:left;font-weight:600;color:var(--fg2);border-bottom:1px solid var(--bd);padding:6px 8px;white-space:nowrap}
th.r,td.r{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace}
td{padding:5px 8px;border-bottom:1px solid var(--bd2)}
tr:hover td{background:color-mix(in srgb,var(--accent) 4%,transparent)}
.fp{color:var(--fg3);font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.empty{color:var(--fg3);text-align:center;padding:18px}
/* #234：已下线模型的视觉降级（历史流水，不代表现在在用） */
.dead{color:var(--fg3);font-size:11px}
tr.deadRow td{color:var(--fg3)}
tr.deadRow td b{color:var(--fg3)}
.note{color:var(--fg3);font-size:12px}
.row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.chartWrap{border:1px solid var(--bd2);border-radius:12px;padding:10px 12px;margin-top:6px}
.tabs{display:flex;gap:6px;margin:22px 0 0;flex-wrap:wrap}
.tabs button{border:1px solid var(--bd);background:transparent;color:var(--fg2);border-radius:8px;padding:5px 14px;cursor:pointer;font:inherit;font-size:13px}
.tabs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
/* #228：CSV 下载按钮 —— 与 tabs 同一套视觉语言，避免多一套配色 */
.dl{border:1px solid var(--bd);background:transparent;color:var(--accent);border-radius:8px;padding:5px 14px;cursor:pointer;font:inherit;font-size:13px}
.dl:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.view{display:none}.view.on{display:block}
footer{margin-top:30px;color:var(--fg3);font-size:11.5px;border-top:1px solid var(--bd2);padding-top:12px}
footer ul{margin:6px 0 0;padding-left:18px}
</style></head>
<body>
<h1>LANtern · Token 用量报告</h1>
<div class="sub">
  统计范围：<b>经由本插件的调用</b>（不含本机 DSH 自身对话）·
  生成：${esc(new Date(nowMs).toLocaleString())} · 时区：${esc(tzName)} ·
  账本行数：${t.lines} · 数据区间：${rangeText}
</div>

<div class="cards">${cards}</div>

<h2>按模型（本月）</h2>
${table(['上游', '模型', ...SUM_HEADS], modelRows, '本月暂无调用')}

<h2>按上游 / Provider（本月）</h2>
${table(['上游', ...SUM_HEADS], provRows, '本月暂无调用')}

<h2>按 API Key（本月）</h2>
${table(['Key 名称', '指纹', ...SUM_HEADS], keyRows, '本月暂无调用')}

<h2>按调用类型（本月）</h2>
${table(['类型', ...SUM_HEADS], kindRows, '本月暂无调用')}

<div class="tabs" role="tablist">
  ${views.map((g, i) => `<button role="tab" data-g="${g}" aria-pressed="${i === 0}">${GRAN_LABEL[g]}</button>`).join('')}
</div>
${views.map(renderTrend).join('\n')}

<h2>明细（按合计降序 · 前 ${DETAIL_MAX} 条）</h2>
<div class="note">跨全部历史，展示消耗最高的 ${Math.min(DETAIL_MAX, detailCells.length)} 条${
  detailCells.length > DETAIL_MAX ? `（共 ${detailCells.length} 条有消耗的记录，其余从略）` : ''
}。<b>点「下载 CSV」可拿到全部 ${detailCells.length} 条</b>，再用表格软件分析。</div>
<div class="row" style="margin:8px 0 2px">
  <button class="dl" id="csvBtn" type="button">下载 CSV（全部 ${detailCells.length} 条）</button>
  <button class="dl" id="pngBtn" type="button">下载当前趋势图为 PNG</button>
</div>
${table(['时间桶', '上游', '模型', 'API Key', '类型', ...SUM_HEADS], detailRows, '暂无有消耗的记录')}

<footer>
  口径说明
  <ul>
    <li>单位 <b>M token</b> = 1,000,000 tokens，保留 3 位小数；柱状图悬停可见精确值。</li>
    <li><b>未命中</b> = 首次输入（DSH <code>inputTokens</code>）；<b>命中</b> = 缓存命中输入（<code>cacheReadTokens</code>）。</li>
    <li><b>合计</b> = 未命中 + 命中 + 缓存写 + 输出（与 DSH 官方"互斥计数"口径一致）。</li>
    <li><b>推理 token 已包含在输出内</b>，不重复计入合计。</li>
    <li>命中率 = 命中 ÷（未命中 + 命中）；分组为<b>加权</b>而非行平均；<code>—</code> 表示该来源未提供缓存数据（不是 0%）。</li>
    <li>周按 <b>ISO 8601</b>（周一起算）；当年视图为"截至今日"，并非完整年度。</li>
    <li>失败请求<b>不计入</b> token 合计，但计入失败次数。</li>
  </ul>
</footer>

<script>
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tabs button'));
  var views=[].slice.call(document.querySelectorAll('.view'));
  function show(g){
    tabs.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.g===g));});
    views.forEach(function(v){v.classList.toggle('on',v.dataset.view===g);});
  }
  tabs.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.g);});});
  if(tabs.length) show(tabs[0].dataset.g);

  // #228：CSV 导出
  var ROWS = ${csvJson};
  var HEADS = ['时间桶','上游','模型','API Key','类型','输入(未命中)','输入(命中)','缓存写','输出','合计','命中率%','请求数','失败数'];
  function cell(v){
    var s = v === null || v === undefined ? '' : String(v);
    // RFC4180：含逗号/引号/换行就必须加引号，内部引号翻倍
    return /[",\\n\\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var btn = document.getElementById('csvBtn');
  if (btn) btn.addEventListener('click', function(){
    var out = [HEADS.join(',')];
    for (var i = 0; i < ROWS.length; i += 1) out.push(ROWS[i].map(cell).join(','));
    // 加 BOM：Excel 打开 UTF-8 CSV 不乱码的唯一稳妥办法
    var blob = new Blob(['\\ufeff' + out.join('\\r\\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lantern-usage-' + new Date().toISOString().slice(0,10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });

  // #228：把当前激活的趋势图（SVG）导出成 PNG。
  // 为什么要做：SVG 直接插进 PPT/文档常丢样式，PNG 才是"能贴的地方都能用"。
  // 实现：把 SVG 序列化 → 画到 canvas（2x 缩放保证清晰）→ toDataURL 下载。
  // 注意两点：
  //   · SVG 必须带 xmlns，否则 drawImage 会静默失败；
  //   · 背景要手动填充白色 —— canvas 默认透明，贴到深色背景上会看不清。
  var pngBtn = document.getElementById('pngBtn');
  if (pngBtn) pngBtn.addEventListener('click', function(){
    var view = document.querySelector('.view.on');
    var svg = view ? view.querySelector('svg') : null;
    if (!svg) { alert('没有可导出的图。'); return; }
    var rect = svg.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width || 800));
    var h = Math.max(1, Math.round(rect.height || 180));
    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    var src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    var img = new Image();
    img.onload = function(){
      var scale = 2;
      var canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      var a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'lantern-trend-' + (view.dataset.view || 'chart') + '-' + new Date().toISOString().slice(0,10) + '.png';
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ a.remove(); }, 0);
    };
    img.onerror = function(){ alert('导出 PNG 失败：浏览器不支持把 SVG 画进 canvas。'); };
    img.src = src;
  });
})();
</script>
</body></html>`
}

/**
 * 报告目录里按时间排序的文件列表（新的在前）。
 * @returns 文件路径数组。
 */
export function listReports() {
  try {
    return readdirSync(PATHS.reports)
      .filter((n) => n.endsWith('.html'))
      .map((n) => join(PATHS.reports, n))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs
        } catch {
          return 0
        }
      })
  } catch {
    return []
  }
}

/**
 * 滚动清理旧报告（只保留最近 keep 份）。
 * @param keep - 保留份数。
 * @returns 删除的份数。
 */
export function pruneReports(keep = 20) {
  // keep 必须是正整数，否则"保留 0 份" = 把全部历史报告删光。
  // 早先 keep=0 / 负数 / NaN 一路走到 `files.slice(Math.max(0, keep))`：
  // keep=0 → slice(0) → 从头删到底；NaN → Math.max(0,NaN)=NaN → slice(NaN)=全部。
  // 而调用方（writeReport / rpc）拿到的仍是 { path, reused:false }，
  // 报告刚生成就被自己删掉，还把之前二十份一起带走。
  const n = Number(keep)
  const safeKeep = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20
  const files = listReports()
  let removed = 0
  for (const f of files.slice(safeKeep)) {
    try {
      unlinkSync(f)
      removed += 1
    } catch {
      /* 单个失败不影响其余 */
    }
  }
  return removed
}

/**
 * 写出一份报告，并按需要回收旧报告（含"一分钟内复用同一份"）。
 *
 * @param options - `{ keyLabels, reuseWithinMs, keep, nowMs }`。
 * @returns `{ path, reused, summary }`。
 */
export async function writeReport({ keyLabels = new Map(), reuseWithinMs = 60_000, keep = 20, nowMs = Date.now(), liveNames } = {}) {
  mkdirSync(PATHS.reports, { recursive: true })
  // 一分钟内重复点击 → 复用同一份（不重复生成、不重复弹窗）
  if (reuseWithinMs > 0) {
    const latest = listReports()[0]
    if (latest !== undefined) {
      try {
        const age = nowMs - statSync(latest).mtimeMs
        if (age < reuseWithinMs) {
          return { path: latest, reused: true }
        }
      } catch {
        /* 忽略，继续生成新的 */
      }
    }
  }
  const html = await buildReportHtml({ keyLabels, nowMs, liveNames })
  const d = new Date(nowMs)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  // 时间戳只到秒：同一秒内生成两份会拼出同一个文件名。
  // Windows 上 writeFileSync 直接覆盖（不报错），于是第一份被静默吞掉，
  // 而两个调用方都收到自己的 path —— 谁也不知道只剩一份。
  // 退让式找第一个空位，宁可名字难看也不丢历史。
  let file = join(PATHS.reports, `usage-${stamp}.html`)
  for (let i = 1; existsSync(file); i += 1) {
    file = join(PATHS.reports, `usage-${stamp}-${i}.html`)
    if (i > 1000) break
  }
  writeFileSync(file, html, 'utf8')
  pruneReports(keep)
  return { path: file, reused: false }
}

/**
 * 账本是否存在且非空。
 * @returns 是否为空。
 */
export function ledgerIsEmpty() {
  try {
    return statSync(PATHS.usage).size === 0
  } catch {
    return !existsSync(PATHS.usage)
  }
}
