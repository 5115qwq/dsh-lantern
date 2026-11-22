/**
 * dsh-lantern — 鉴权层（Host 半部内部模块）。
 *
 * 设计要点（设计方案 §8、§11.5.6.3、§11.5.6.3a）：
 * 1. **只存哈希**：`data/keys.json` 内绝无明文 key，只存 sha256 + 尾部指纹；
 * 2. **明文只显示一次**：生成时返回，之后无法再查看；
 * 3. **服务端不依赖前缀**：校验只算 sha256 比对，故切换 `format` 不会让旧 key 失效；
 * 4. **`timingSafeEqual` 先比长度**：不等长入参会抛错，必须处理
 *    （否则"key 打错"会变成 500 而不是 401）；
 * 5. **默认无匿名放行**：没有任何 key 时，拒绝一切局域网请求。
 *
 * key 格式（默认 `sk`，对齐 DeepSeek / 硅基流动 / OpenAI）：
 *   sk-<43 位 base64url>        总长 46
 *   sk-<32 位十六进制>          sk-hex，与 DeepSeek 完全同构
 *   sk-lantern-<43 位 base64url> sk-lantern，抗密钥扫描误报
 *
 * @module dsh-lantern/auth
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readJson, writeJson, PATHS } from './storage.js'

/** key 格式预设。 */
export const KEY_FORMATS = Object.freeze({
  /** 默认：`sk-` + 43 位 base64url（与主流 provider 同形态）。 */
  sk: { prefix: 'sk-', kind: 'base64url', length: 43 },
  /** 与 DeepSeek 完全同构：`sk-` + 32 位十六进制。 */
  'sk-hex': { prefix: 'sk-', kind: 'hex', length: 32 },
  /** 带品牌段，抗密钥扫描误报。 */
  'sk-lantern': { prefix: 'sk-lantern-', kind: 'base64url', length: 43 },
})

/** 当前默认格式。 */
export const DEFAULT_FORMAT = 'sk'

/**
 * 生成一个 base64url 字符串（无填充）。
 * @param bytes - 随机字节数。
 * @returns URL 安全的 base64 字符串。
 */
function base64url(bytes) {
  return randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 按指定格式生成一个明文 key。
 *
 * 未知 format **不会**在这里静默回退：回退会造成「明文是 sk- 形态、记录里却写着
 * 一个不存在的格式名」的分裂，之后 `rotate()` 会把这个非法值一路传下去，
 * 而 `KEY_FORMATS[bad]` 永远取不到，问题永远藏着。所以先用
 * {@link normalizeFormat} 把格式名收敛成合法值，调用方记录收敛后的那个名字。
 *
 * @param format - `sk` | `sk-hex` | `sk-lantern`。
 * @returns 明文 key。
 */
export function generateKey(format = DEFAULT_FORMAT) {
  const preset = KEY_FORMATS[normalizeFormat(format)]
  if (preset.kind === 'hex') {
    // 32 位十六进制 = 16 字节 = 128 bit 熵（与 DeepSeek 同构）
    return `${preset.prefix}${randomBytes(Math.ceil(preset.length / 2)).toString('hex').slice(0, preset.length)}`
  }
  // base64url：32 字节 = 256 bit 熵；无填充时正好 43 字符
  const body = base64url(32)
  return `${preset.prefix}${preset.length === body.length ? body : body.slice(0, preset.length)}`
}

/**
 * 把任意输入收敛成一个真实存在的 key 格式名。
 *
 * @param format - 候选格式名（可能是配置里手写的旧值、空串、非字符串）。
 * @returns `KEY_FORMATS` 的某个键，绝不会是未知值。
 */
export function normalizeFormat(format) {
  return typeof format === 'string' && Object.prototype.hasOwnProperty.call(KEY_FORMATS, format)
    ? format
    : DEFAULT_FORMAT
}

/**
 * 单个 Key 专属限额的合法范围。
 *
 * 为什么要钳：这些值直接参与限流判定，而 `perKeyRpm: 0` 的含义是
 * 「每分钟允许 0 次」——不是「不限」，于是这个 key 每个请求都 429，
 * 但面板上显示的是一个空/零的数字，看起来像"没设置"。同理负数进 `Math.floor`
 * 之后会让令牌桶算出负容量。既然全局 limits 早就用 `clampInt` 钳过，
 * 专属限额没理由留一个能把自己锁死的口子。
 */
const KEY_LIMIT_RANGES = Object.freeze({
  perKeyRpm: [1, 100000, 100],
  perKeyTpm: [100, 10000000, 80000],
  maxConcurrent: [1, 64, 8],
})

/**
 * 把一份 Key 专属限额收敛成安全值。
 *
 * - `null` / 非对象 → `null`（表示"跟随全局"，这是合法语义，不是错误）；
 * - 已知字段钳进范围（`0`、负数、`NaN`、字符串数字都按"未填"处理用默认值）；
 * - 未知字段丢弃（不把用户手填的垃圾一路写进磁盘）。
 *
 * @param limits - 面板提交的原始值。
 * @returns 收敛后的对象或 `null`。
 */
export function sanitizeKeyLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) return null
  const out = {}
  for (const [field, [min, max, fallback]] of Object.entries(KEY_LIMIT_RANGES)) {
    const raw = limits[field]
    if (raw === undefined || raw === null) continue
    const num = Number(raw)
    // 0 与负数都视为「没填」：用户想表达的通常是"不限"，但 0 在这里是"禁死"。
    // 想不限就该留空（null），面板文案也是这么写的。
    out[field] = Number.isFinite(num) && num > 0 ? Math.min(max, Math.max(min, Math.round(num))) : fallback
  }
  return Object.keys(out).length === 0 ? null : out
}

/**
 * 计算 key 的 sha256（十六进制）。
 * @param plaintext - 明文 key。
 * @returns 64 字符十六进制摘要。
 */
export function hashKey(plaintext) {
  return createHash('sha256').update(String(plaintext), 'utf8').digest('hex')
}

/**
 * 显示用**指纹**：从 `sha256` 派生的 8 位十六进制，形如 `1f3c9a02`。
 *
 * ⚠ 语义说明（"指纹"是**派生**，不是另行分配的编号）：
 * 指纹必须能由原数据**确定性重算**，因此这里直接从已有的 `sha256` 取前 8 位 ——
 * 与 TLS 证书指纹、SSH 主机密钥指纹同一种思路。
 *
 * 为什么不再从明文截取（原 `head`/`tail` 方案已删除）：
 * 1. **前缀污染**：`sk-lantern-` 长 11 字符，`slice(0,8)` 全落在固定前缀里，
 *    指纹退化成常量（实测空间仅 64 种）；
 * 2. **必须占满列宽**：`head…tail` 共 8 字符且内容不可控，
 *    在 ~390px 的表格里会挤压「创建时间 / 最近使用」等列（截图已证实）；
 * 3. **无法重算**：一旦改为独立字段就得维护去重表，且算法变更后旧记录永远对不上。
 *
 * `sha256` 每条记录都有、与密钥一一对应，因此**零新增字段、零迁移、随时可重算**。
 *
 * 碰撞概率（生日问题，空间 16^8 = 4.29e9）：
 * - 10 个 Key：约 1.0e-8（1 亿分之一）
 * - 20 个 Key：约 4.4e-8（2300 万分之一）
 * - 50 个 Key：约 2.8e-7（350 万分之一）
 * 日常（几十个 Key）几乎不会相同；且即便相同，列表另有**标签**列可区分。
 *
 * @param record - key 记录（需含 `sha256`）。
 * @returns 8 位十六进制指纹；无 `sha256` 时返回 `—`。
 */
export function fingerprintOf(record) {
  const hash = String(record?.sha256 ?? '')
  if (hash.length < 8) return '—'
  return hash.slice(0, 8)
}

/**
 * 定时安全比较两个字符串（先比长度）。
 * `timingSafeEqual` 对不等长入参会抛错，这里显式处理。
 * @param a - 一侧字符串。
 * @param b - 另一侧字符串。
 * @returns 是否相等。
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Key 仓库：加载 / 生成 / 校验 / 增删改 / 轮换。
 * 全部落在 `data/keys.json`（只存哈希）。
 */
export class KeyStore {
  /**
   * @param config - 返回当前配置的函数（读取 auth.format 等）。
   */
  constructor(config) {
    this.config = config
    /** @type {Array<object>} */
    this.records = []
    this.loaded = false
  }

  /** 从磁盘载入（不存在则视为空）。 */
  async load() {
    const doc = await readJson(PATHS.keys, { version: 1, keys: [] })
    this.records = Array.isArray(doc?.keys) ? doc.keys : []
    this.loaded = true
    return this.records
  }

  /** 原子写回磁盘。 */
  async persist() {
    await writeJson(PATHS.keys, { version: 1, keys: this.records })
  }

  /** 对外的安全视图：不含明文（列表页不需要，明文走 reveal）。 */
  list() {
    return this.records.map((r) => ({
      id: r.id,
      label: r.label,
      fingerprint: fingerprintOf(r),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      enabled: r.enabled !== false,
      limits: r.limits ?? null,
      // #227：让界面能区分「新 Key（可查看明文）」与「旧版本建的（明文没存）」。
      // 只给布尔，不给明文本身 —— 列表一次返回全部明文会让明文长期躺在 DOM 里。
      hasPlaintext: typeof r.plaintext === 'string' && r.plaintext.length > 0,
    }))
  }

  /**
   * #227：取回某个 Key 的明文（面板「查看」按钮）。
   *
   * ## 为什么现在允许查看（设计变更）
   *
   * 原设计只存 sha256，明文生成后即不可得。用户实测反馈：
   *   「现在只能生成的时候看一次复制一次太蠢了，但凡我忘了就没办法了」
   * 而唯一的补救手段是「重新生成」—— 也就是换个 Key，客户端得重新配置。
   * 反复忘记就要反复换，实际体验比"明文落盘"的代价更糟。
   *
   * 权衡：本插件的 `data/` 目录本来就在本机（能读它的人也能改 config、
   * 也能看到所有上游凭证），把网关自己的 Key 明文放进去**不增加新的信任边界**。
   * 所以改成存明文 + 随时可查看。
   *
   * 仍然守住两条：
   *   · 明文**不进** `list()`（列表页不长期持有）；
   *   · 明文**不进**日志与响应头。
   *
   * @param id - Key 的 id。
   * @returns 明文；旧版本创建的 Key（当时没存明文）返回 `undefined`。
   */
  reveal(id) {
    const rec = this.records.find((r) => r.id === id)
    if (rec === undefined) return undefined
    if (typeof rec.plaintext !== 'string' || rec.plaintext.length === 0) return undefined
    return rec.plaintext
  }

  /** 当前是否一个可用 key 都没有（用于"默认拒绝一切"判定）。 */
  get isEmpty() {
    // #227：Key 生成即永久，不再有过期概念（原 expiresAt 逻辑已移除）。
    return this.records.filter((r) => r.enabled !== false).length === 0
  }

  /**
   * 生成一个新 key。**生成即永久**（#227：不再有过期时间）。
   * @param options - 标签与专属限额。
   * @returns `{ record, plaintext }`。
   */
  async create({ label = '', limits = null, format = undefined } = {}) {
    const cfg = this.config()
    // 收敛成"真实存在的格式名"，并把它写进记录 —— 否则明文形态与记录里的名字会分裂
    const useFormat = normalizeFormat(format ?? cfg?.auth?.format)
    const plaintext = generateKey(useFormat)
    const record = {
      id: `key_${randomUUID().slice(0, 8)}`,
      label: String(label || '未命名'),
      sha256: hashKey(plaintext),
      // #227：同时保存明文，供面板随时查看/复制。
      // 鉴权仍走 `sha256`（verify 只比哈希），明文只用于显示 ——
      // 这样即使明文被误改，也不会绕开鉴权逻辑。
      plaintext,
      // 不再存 `head`/`tail`：它们只服务于旧的显示指纹，属于可从 `sha256`
      // 重算的冗余数据（已确认不参与鉴权、不对外暴露）。指纹现由 `fingerprintOf()`
      // 直接取 `sha256` 前 8 位得出 —— 零冗余、零迁移、随时可重算。
      format: useFormat,
      createdAt: Date.now(),
      lastUsedAt: null,
      enabled: true,
      limits: sanitizeKeyLimits(limits),
    }
    this.records.push(record)
    await this.persist()
    // ⚠ 这里**不能**把 sha256 抹成 undefined 再返回：调用方（rpc `keys/create`）
    // 会拿它去算 `fingerprintOf()`，抹掉之后指纹恒为 `—`，于是「刚生成的 key 在
    // 列表里对不上号」。
    return { record: { ...record }, plaintext }
  }

  /**
   * 校验一个明文 key。
   * @param presented - 客户端提交的 key。
   * @returns 命中的记录，或 undefined。
   */
  verify(presented) {
    if (typeof presented !== 'string' || presented.length === 0) return undefined
    const digest = hashKey(presented)
    for (const record of this.records) {
      if (record.enabled === false) continue
      // 先做定时安全比较（长度一致的十六进制摘要）
      if (safeEqual(record.sha256, digest)) return record
    }
    return undefined
  }

  /**
   * 记录一次使用（只写时间戳，不记 IP，减少隐私面）。
   * @param record - 命中的记录。
   */
  async touch(record) {
    const target = this.records.find((r) => r.id === record.id)
    if (target === undefined) return
    target.lastUsedAt = Date.now()
    // 频率限制：最多每分钟落盘一次，避免每个请求都写磁盘
    const now = Date.now()
    if (this._lastTouchPersist === undefined || now - this._lastTouchPersist > 60_000) {
      this._lastTouchPersist = now
      await this.persist().catch(() => {})
    }
  }

  /**
   * 修改标签 / 启停 / 专属限额。
   * @param id - key id。
   * @param patch - 要改的字段。
   * @returns 是否命中。
   */
  async update(id, patch = {}) {
    const record = this.records.find((r) => r.id === id)
    if (record === undefined) return false
    if (typeof patch.label === 'string') record.label = patch.label
    if (typeof patch.enabled === 'boolean') record.enabled = patch.enabled
    // 专属限额必须钳过再落盘：全局 limits 走 rpc 的 clampInt，这里曾是一条裸通道，
    // 于是 `perKeyRpm: 0` 能被原样写进 keys.json，之后这个 key 每个请求都 429
    // —— 而 `??` 不会把 0 当成"未设置"，面板上又看不出是 0 还是空。
    if (patch.limits === null || (typeof patch.limits === 'object' && patch.limits !== undefined)) {
      record.limits = sanitizeKeyLimits(patch.limits)
    }
    await this.persist()
    return true
  }

  /**
   * 删除一个 key（不可恢复）。
   * @param id - key id。
   * @returns 是否命中。
   */
  async remove(id) {
    const before = this.records.length
    this.records = this.records.filter((r) => r.id !== id)
    if (this.records.length === before) return false
    await this.persist()
    return true
  }

  // #227：`rotate()`（轮换）已移除。
  //
  // 它的存在前提是"明文只存哈希、看不到" —— 忘了只能换一个。
  // 现在明文可随时查看，就不再需要"换 Key"这个动作：
  //   · 忘了 → 点「查看」复制即可，客户端配置完全不用改；
  //   · 想换 → 直接新建一个、删掉旧的（两步，且语义清晰，没有"过渡期"这种隐状态）。
  //
  // 保留它反而有害：过渡期意味着**同一时刻有两个有效 Key**，
  // 而列表里旧的那行会显示成"已失效"却仍能通过鉴权（或者反过来），
  // 这种"看得见的状态"和"实际能不能用"不一致，是排障时最难缠的一类。
}

/**
 * 从请求中提取 Bearer / x-api-key 凭据。
 * @param headers - Node 请求头（小写键）。
 * @returns 提交的 key，或 undefined。
 */
export function extractCredential(headers) {
  const auth = headers.authorization ?? headers.Authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const xApiKey = headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.trim().length > 0) return xApiKey.trim()
  return undefined
}
