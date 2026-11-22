/**
 * dsh-lantern — 统一调用契约（第十轮）。
 *
 * ## 这一层要回答的问题
 *
 * 你问过两件事：
 *   1. 「外面统一设置推理等级，然后按对照表来」—— 见 `effort-contract.js`；
 *   2. 「其他各个模型的能力、调用参数差异也可以这样控吧？」
 *
 * 第二个问题的答案是"能，但只有一半能"。把三类差异分开看：
 *
 * | 类型 | 例子 | 能不能用同一套对照表控 |
 * |---|---|---|
 * | **枚举型**（有真实词表） | 推理档位、图片质量、响应格式 | ✅ 能 —— 和推理档完全同构 |
 * | **能力型**（有/没有） | tools、图片输入、JSON 模式 | ⚠️ 不能"映射"，只能"筛链/标注"（已由能力闸门做了） |
 * | **标量型**（连续数值） | temperature、top_p、max_tokens | ❌ 不能映射，只能"封顶 + 如实标注" |
 *
 * 这一层把 **枚举型** 统一成一个通用结构：`CONTRACT`。
 * 推理档位只是它的第一个实例，不是特例。
 *
 * ## 为什么标量型不能映射
 *
 * `temperature: 0.7` 在 A 家是"正常"，在 B 家可能是"很发散"。没有对照表能表达这件事，
 * 因为上游从不告诉你它的温度刻度。强行归一（比如"0.7 → 0.5"）就是替用户做决定，
 * 而他看到的仍然是 0.7 —— 那是最坏的一种静默失真。所以标量只能：
 *   · 封顶（不放大，只压小到安全区）；
 *   · 不支持的模型 → 不发，并写 `X-Lantern-Ignored-Params`。
 *
 * ## 为什么能力型不能映射
 *
 * "这个模型不支持 tools"没有"更接近的支持"可言。要么筛掉，要么如实拒绝。
 * 能力闸门（`enforceCapabilityGate`）做的就是这件事，这里的 `SUM_*` 只是给它
 * 提供一份**统一的词汇表**，避免三条协议各写一套。
 *
 * @module dsh-lantern/call-contract
 */
import { CONTRACT_LEVELS, rankOf, toContractLevel } from './effort-contract.js'

/**
 * 一张「枚举型」契约的通用结构。
 *
 * @typedef {object} EnumContract
 * @property {string} id            - 契约标识（进响应头用）。
 * @property {string[]} levels      - 对外档位（顺序即强弱）。
 * @property {string} defaultLevel  - 未指定时用哪一档。
 * @property {(level: string) => number|undefined} rankOf - 档位强弱序。
 */

/**
 * 已实现的枚举型契约清单。
 *
 * ⚠ 只有**真的在网关里接线**的才列进来。写在这里却没人读 = 假开关
 * （第七轮踩过：`capabilities.profiles` 曾经"写了但没人读"）。
 */
export const ENUM_CONTRACTS = Object.freeze({
  /** 推理档位：唯一一个今天全链路打通的契约。 */
  reasoning: Object.freeze({
    id: 'reasoning',
    levels: CONTRACT_LEVELS,
    defaultLevel: 'medium',
    headerPrefix: 'X-Lantern-Effort',
  }),
})

/**
 * 「标量型」参数的安全区间与语义说明。
 *
 * 这张表的用途只有两个：**封顶**（防止天文数字打挂上游）和**如实标注**。
 * 它**不**做归一化 —— 见文件头「为什么标量型不能映射」。
 *
 * `min` / `max` 取各家交集的**并集下界**：宁宽勿窄，因为收窄等于替用户改值。
 * 真正的"这家到底支持什么"由能力档案（三态）决定，不在这里。
 */
export const SCALAR_LIMITS = Object.freeze({
  temperature: Object.freeze({ min: 0, max: 2, unit: '', note: '0-2 是 OpenAI 官方口径；超出直接钳到边界' }),
  top_p: Object.freeze({ min: 0, max: 1, unit: '', note: '0-1；本网关无通道，一律进 Dropped-Params' }),
  max_tokens: Object.freeze({ min: 1, max: 1_000_000, unit: 'tokens', note: '必须是正整数；再受 limits.maxTokensCap 二次封顶' }),
  stop: Object.freeze({ min: 0, max: 4, unit: 'items', note: '多数上游只收 4 条；多出的会 truncate 并如实标注' }),
})

/**
 * 「能力型」参数：只有支持/不支持两态，没有中间档。
 *
 * 与 `capabilities.js` 的 KEYS 保持一致 —— 这里只是把它按"能不能被契约化"分组。
 */
export const CAPABILITY_PARAMS = Object.freeze([
  'tools',
  'parallelTools',
  'jsonMode',
  'image',
  'temperature',
  'stop',
])

/**
 * 把一个标量参数钳到安全区间。
 *
 * @param {string} name - `SCALAR_LIMITS` 的键。
 * @param {unknown} value - 客户端给的值。
 * @param {{ cap?: number }} [opts] - `cap` 是额外的上界（如 `limits.maxTokensCap`）。
 * @returns {{ ok: true, value: number, clamped: boolean } | { ok: false, reason: string }}
 */
export function clampScalar(name, value, opts = {}) {
  const spec = SCALAR_LIMITS[name]
  if (spec === undefined) return { ok: false, reason: `unknown scalar "${name}"` }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: `${name} must be a finite number` }
  }
  const upper = typeof opts.cap === 'number' && Number.isFinite(opts.cap) && opts.cap > 0
    ? Math.min(spec.max, opts.cap)
    : spec.max
  const clampedValue = Math.min(upper, Math.max(spec.min, value))
  return { ok: true, value: clampedValue, clamped: clampedValue !== value }
}

/**
 * 截断 `stop` 序列数组到安全条数，并报告丢了哪些。
 *
 * `stop` 不是数值、不能"钳"，只能截断。丢掉的部分必须能被调用方知道
 * （否则它以为四条都在生效，实际只有前两条）。
 *
 * @param {unknown} value - 客户端给的 `stop`。
 * @returns {{ value: string[]|undefined, dropped: string[] }}
 */
export function clipStopSequences(value) {
  if (!Array.isArray(value)) return { value: undefined, dropped: [] }
  const cleaned = value.filter((s) => typeof s === 'string' && s.length > 0)
  const limit = SCALAR_LIMITS.stop.max
  if (cleaned.length <= limit) return { value: cleaned.length > 0 ? cleaned : undefined, dropped: [] }
  return { value: cleaned.slice(0, limit), dropped: cleaned.slice(limit) }
}

/**
 * 生成一份「本次请求用到的契约」快照（给响应头与诊断导出用）。
 *
 * 只报**真的生效了**的东西：`reasoning` 报了档位，其余字段只在非默认时出现。
 * 全量回显（把每个参数都列一遍）会让头变长而不增加信息 —— 用户能从请求体
 * 自己看出来。
 *
 * @param {{ reasoning?: { contract?: string, word?: string, mode?: string } }} input
 * @returns {Record<string,string>}
 */
export function describeContracts(input) {
  const out = {}
  const r = input?.reasoning
  if (r?.contract !== undefined) out['X-Lantern-Effort-Contract'] = r.contract
  if (r?.word !== undefined) out['X-Lantern-Effort-Served'] = r.word
  if (typeof r?.mode === 'string' && r.mode !== 'native') out['X-Lantern-Effort-Mode'] = r.mode
  return out
}

/**
 * 判断一个档位词是否**强于**另一个（用于"用户要更强"的判断）。
 *
 * 认不出强弱时返回 `undefined`，而不是 `false` —— 后者会把"不知道"
 * 静默当成"不强于"，导致升级逻辑不触发也不报错。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean|undefined}
 */
export function isStrongerThan(a, b) {
  const ra = rankOf(toContractLevel(a))
  const rb = rankOf(toContractLevel(b))
  if (ra === undefined || rb === undefined) return undefined
  return ra > rb
}

/**
 * 工具调用被渲染成**文本标记**的已知形态（#214）。
 *
 * 某些后端不支持结构化 `tool_calls`，于是把调用意图当正文吐出来，
 * 典型是 `<｜｜DSML｜｜ invoke name="...">`。客户端拿到这种正文
 * 会以为模型在胡说八道，而模型其实是想调工具。
 *
 * 这里集中一份模式表，供**两条路径共用**：
 *   · 非流式：`protocol.js` 的 `leakedToolMarkup()`（历史实现，保留）
 *   · 流式：`index.js` 在零产出/收尾时用它检查累积正文（#214 新增）
 *
 * 之前只有非流式会检测，流式路径把标记原样流给客户端、不做任何标注 ——
 * 同一个后端的行为在"流式/非流式"下不一致，排障时极难理解。
 *
 * ⚠ 宁可漏报也不误报：误报会让正常回答被标成异常。
 */
export const LEAKED_TOOL_MARKUP_PATTERNS = Object.freeze([
  /<｜｜\s*DSML\s*｜｜/,
  /<\|tool[_-]?call\|>/i,
  /<\|function[_-]?call\|>/i,
  /<\/?tool[_-]?calls?>/i,
  /<function_call>/i,
])

/**
 * 在一段文本里检测"工具调用被渲染成文本标记"。
 *
 * @param text - 要检查的正文（流式路径传累积的 resumeText）。
 * @returns 命中的标记片段，或 `undefined`（正常）。
 */
export function detectLeakedToolMarkup(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  for (const re of LEAKED_TOOL_MARKUP_PATTERNS) {
    const m = re.exec(text)
    if (m !== null) return m[0]
  }
  return undefined
}
