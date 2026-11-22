/**
 * 自定义模型（虚拟模型名）的纯函数层。
 *
 * 为什么单独成文件：Host 半部（lib/index.js）要拿它做请求解析，
 * 管理通道（lib/rpc.js）要拿它做增删改，两边**必须用同一份规范化逻辑**，
 * 否则会出现「面板上看着合法、请求时却解析不出来」的自相矛盾。
 *
 * 本文件不依赖任何 DSH 服务，也不做 I/O —— 只做形状校验与规范化。
 *
 * @module dsh-lantern/custom-models
 */

// 对外四档契约：把管理员写的私有词（xhigh / light / off …）统一收敛成四档。
// 依赖方向是「custom-models → effort-contract」，不反向 ——
// effort-contract 是纯常量与纯函数，不依赖任何业务模块，不会形成环。
import { CONTRACT_LEVELS, toContractLevel } from './effort-contract.js'

/**
 * 单个后端「多久没吐出第一个字就算超时」的默认值。
 *
 * 为什么是 30 秒：多个后端串起来时，用户真正在意的是「多久能看到第一个字」。
 * 排在前面的后端如果挂死，30 秒足够判断它不会马上回话；再长就等于让用户
 * 盯着一个空屏等一分钟，比直接换后端更糟。
 *
 * 这个值只是默认值——每个自定义模型可以各自覆盖（面板上的输入框就改它）。
 */
export const DEFAULT_BACKEND_TIMEOUT_MS = 30000

/** 超时时间的合法区间。0 是合法特例（= 不设超时）；1–999 收敛为默认值，避免手滑填成秒。 */
export const MIN_BACKEND_TIMEOUT_MS = 1000
export const MAX_BACKEND_TIMEOUT_MS = 600000

/**
 * 整条链最多再重试几次。
 *
 * 默认 2：用户要的是「报错也要及时衔接」——上游偶发的 5xx、限流、连接被掐断
 * 往往补一次就好，若默认 0 就等于第一次抖动就直接把请求甩给下一个后端，
 * 明明排在前面的后端更好也被绕过。同时上限锁在 5，避免重试变成对上游的刷量。
 */
export const DEFAULT_BACKEND_RETRIES = 2

/** 重试次数的合法区间：0–5。用户会填 5，但不允许无限重试——那是在替对方刷上游。 */
export const MIN_BACKEND_RETRIES = 0
export const MAX_BACKEND_RETRIES = 5

/**
 * 把任意输入收敛成合法的超时毫秒数。
 *
 * 空值 / 非数字 / 越界都退回默认值，而不是报错：这类字段是「调优参数」，
 * 不是业务约束。为了一个填错的数字拒绝保存整个模型，用户会莫名其妙。
 *
 * @param value - 原始输入。
 * @returns 合法毫秒数。
 */
export function normalizeTimeoutMs(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BACKEND_TIMEOUT_MS
  const rounded = Math.round(n)
  // 0 是显式选择"不设超时"（后端已知很慢时用），必须原样保留；
  // 1–999 则几乎肯定是把秒当毫秒填了，退回默认比照单执行更安全。
  if (rounded === 0) return 0
  if (rounded < MIN_BACKEND_TIMEOUT_MS) return DEFAULT_BACKEND_TIMEOUT_MS
  if (rounded > MAX_BACKEND_TIMEOUT_MS) return MAX_BACKEND_TIMEOUT_MS
  return rounded
}

/**
 * 把任意输入收敛成合法的重试次数。
 * @param value - 原始输入。
 * @returns 0–5 的整数。
 */
export function normalizeRetries(value) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BACKEND_RETRIES
  const rounded = Math.floor(n)
  if (rounded < MIN_BACKEND_RETRIES) return DEFAULT_BACKEND_RETRIES
  if (rounded > MAX_BACKEND_RETRIES) return MAX_BACKEND_RETRIES
  return rounded
}

/**
 * 把任意输入收敛成"该模型允许的推理档位"列表（第十轮 #118）。
 *
 * ## 为什么需要这个字段
 *
 * 用户反馈："推理等级并不能设置、不能自定义"——当时确实如此：
 * 自定义模型的白名单只有 display / bindings / enabled / timeoutMs / retries，
 * 管理员**没有任何地方**规定"这个模型只允许 minimal/low"或"默认用 high"。
 * 唯一能影响档位的办法是去 provider 页逐条改能力覆盖，而那改的是"支不支持推理"，
 * 不是"开放哪几档"。
 *
 * ## 语义（三条，缺一条就会变成假开关）
 *
 * - `reasoningEfforts`：**白名单**。非空时只允许这些契约档；
 *   调用方传了不在列表里的档 → 400 并给 allowed。空/缺省 = 不限制（跟随上游）。
 * - `defaultReasoningEffort`：调用方**完全不传**时用这一档。
 *   有了它，"这条模型默认就是 high"才配得出来；缺省 = 不干预（用上游默认）。
 * - 两者都会被 `toContractLevel` 归一，所以管理员写 `xhigh` 也能落成 `high`。
 *
 * @param value - 原始输入（数组或逗号分隔字符串）。
 * @returns 去重后的契约档数组（保持 CONTRACT_LEVELS 顺序）；无效输入返回 []。
 */
export function normalizeReasoningEfforts(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : []
  const levels = new Set()
  for (const item of raw) {
    const lv = toContractLevel(item)
    if (lv !== undefined) levels.add(lv)
  }
  // 按契约的强弱顺序输出，便于面板稳定显示、也便于人工核对
  return CONTRACT_LEVELS.filter((lv) => levels.has(lv))
}

/**
 * 把任意输入收敛成合法的默认推理档位。
 *
 * @param value - 原始输入。
 * @returns 契约档之一，或 undefined（表示"不干预，用上游默认"）。
 */
export function normalizeDefaultReasoningEffort(value) {
  const lv = toContractLevel(value)
  return lv === undefined ? undefined : lv
}

/**
 * 校验自定义模型名是否合法。
 *
 * 允许字母/数字/下划线/点/连字符/斜杠，长度 1–64。
 * 不允许 @：那是公开名 <model>@<provider> 的分隔符，
 * 自定义名一旦含 @ 就会和真实公开名撞车，解析顺序会变得不可预测。
 *
 * @param value - 待校验的名字。
 * @returns 是否合法。
 */
export function isValidCustomModelName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_./-]+$/.test(value)
}

/**
 * 把配置里的 customModels 规范化成可直接使用的条目数组。
 *
 * 只做形状容错，不做语义校验（绑定项是否还存在由调用时再判）——
 * 因为 provider 的生命周期独立于本插件：用户可能先建好自定义模型，
 * 隔天再装 provider。若创建时硬卡存在性，配置就会被无谓地卡死。
 *
 * @param list - 配置里的原始数组。
 * @returns 规范化后的条目（已过滤掉非法项）。
 */
export function normalizeCustomModels(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!isValidCustomModelName(name)) continue
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const bindings = Array.isArray(raw.bindings)
      ? raw.bindings
          .filter((b) => typeof b === 'string' && b.trim().length > 0)
          .map((b) => b.trim())
          .filter((b, i, arr) => arr.indexOf(b) === i)
      : []
    out.push({
      id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : 'cm_' + lower.replace(/[^a-z0-9]/g, '').slice(0, 16),
      name,
      display: typeof raw.display === 'string' && raw.display.length > 0 ? raw.display : name,
      bindings,
      enabled: raw.enabled !== false,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      // 调优参数：同时挂在条目上（运行时直接读，不必再回查全局配置）。
      // 用规范化函数而不是直接透传，是为了让手工改 config.json 写进来的
      // "30"（字符串）或 999999999 也能被收敛到可用范围。
      timeoutMs: normalizeTimeoutMs(raw.timeoutMs),
      retries: normalizeRetries(raw.retries),
      // 推理档位的按模型配置（第十轮 #118）。
      // attention: 这两个字段是**运维口径**，不是能力口径 ——
      //   · reasoningEfforts = 我允许对外暴露哪几档（白名单）
      //   · defaultReasoningEffort = 调用方不传时我替他选哪一档
      // 与 capabilities 里"这个模型支不支持推理"是两件事，不要混。
      reasoningEfforts: normalizeReasoningEfforts(raw.reasoningEfforts),
      ...(normalizeDefaultReasoningEffort(raw.defaultReasoningEffort) === undefined
        ? {}
        : { defaultReasoningEffort: normalizeDefaultReasoningEffort(raw.defaultReasoningEffort) }),
      // 把 system 提示词合并进第一条 user 消息（第十四轮 #155，第十七轮 #182 改默认值）。
      //
      // 有些上游的模板不接受独立的 system role：实测 `hy4` / `Qwen-3.8-Flash` /
      // `GPT-6-Luna` 只要见到非空 system 就**秒回空**（正文/推理/工具全空），
      // 而把 system 拼进 user 消息则完全正常。
      //
      // ⚠ 默认值从 false 改成 **true**（#182），理由：
      //   1. 这些中转上游（@deepai / @xdpool / @trae）几乎是同一套技术栈，
      //      "不支持独立 system"是**常态**而不是例外 —— 已踩过三批模型；
      //   2. `true` 在两种情况下都可用：不支持独立 system 的能正常回，
      //      支持的地方也照样接受"system 文本在 user 里的"形式；
      //   3. 而 `false` 一旦碰上不支持的上游就是**静默空回答**，
      //      用户看到的是"这个模型不能用"，排查成本极高。
      //
      // 代价：system 从"系统级约束"降级成"用户消息里的前置说明"，语义略弱。
      // 但这比返回空回答好得多 —— 空回答是彻底不可用。
      //
      // 仍然可以由运维按模型显式关掉（面板里的复选框），只是**不再默认关**。
      mergeSystemIntoUser: raw.mergeSystemIntoUser !== false,
      // 把工具结果改写成文本回述（第十七轮 #183）。
      //
      // 标准 OpenAI 用 `role:'tool'` 回传工具结果，但**部分中转上游不接受**
      // 这个 role：实测 `Qwen-3.8-Flash` / `GPT-6-Luna` 拿到 tool 消息后
      // 一律返回空（`empty_completion`），而把结果写成普通文本就完全正常。
      //
      // 默认 false：标准形状是更好的选择（协议级、支持并行工具），
      // 只有明确需要降级的模型才打开。
      toolResultAsText: raw.toolResultAsText === true,
    })
  }
  return out
}

/**
 * 在当前配置里按名字找一个自定义模型（大小写不敏感）。
 *
 * @param cfg - 当前配置。
 * @param name - 客户端传来的模型名。
 * @returns 命中的自定义模型条目，或 undefined。
 */
export function findCustomModel(cfg, name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const lower = name.toLowerCase()
  return normalizeCustomModels(cfg?.customModels).find((m) => m.name.toLowerCase() === lower && m.enabled)
}

/**
 * 生成一个在本配置内唯一的 id。
 * @param models - 现有条目。
 * @param name - 用于派生可读前缀的名字。
 * @returns id。
 */
export function uniqueCustomModelId(models, name) {
  const base = 'cm_' + String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  const taken = new Set(models.map((m) => m.id))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(base + '_' + n)) n += 1
  return base + '_' + n
}
