/**
 * dsh-lantern — 协议翻译层（Host 半部内部模块）。
 *
 * 两个方向：
 * 1. **入站**：OpenAI `/v1/chat/completions` 请求体 → DSH `Message[]` + `ToolSchema[]`
 * 2. **出站**：DSH `StreamChunk` → OpenAI SSE 帧 / 非流式聚合响应
 *
 * 口径依据（已查实）：
 * - `dsh-llm/lib/types/types.d.ts` 的 `TokenUsage`：计数**互斥**，
 *   `inputTokens` 不含缓存（adapter 已从 provider 的 prompt_tokens 里减掉缓存命中）；
 * - `StreamChunk` 联合：block-start / text-delta / reasoning-delta / tool-call-delta /
 *   block-end / usage / finish。
 *
 * @module dsh-lantern/protocol
 */
import { randomUUID } from 'node:crypto'
import { rankOf, CONTRACT_LEVELS, toContractLevel } from './effort-contract.js'
// #214：工具标记的形态表集中到 call-contract.js，供流式/非流式两条路径共用。
// 这里直接复用它的检测函数，避免"两份正则各自演化"（那正是两条路径
// 行为不一致的老根源）。
import { detectLeakedToolMarkup } from './call-contract.js'

/** 一次 Chat Completions 请求的最大消息条数。 */
export const MAX_MESSAGES = 500
/** 单条文本消息长度上限（字节）。 */
export const MAX_TEXT_BYTES = 512 * 1024

/**
 * 按 UTF-8 字节数上限裁一段文本，且**不切开多字节字符**。
 *
 * 原来的 `text.slice(0, MAX_TEXT_BYTES)` 是按 UTF-16 码元裁的：
 * 常量名说字节、代码做码元，中文与 emoji 场景的实际上限是标称值的 1.5–3 倍；
 * 更糟的是切在代理对中间会留下孤立代理项（非法 UTF-16），下游序列化会变成
 * U+FFFD，用户看到的是消息尾部凭空多出一堆问号。
 *
 * @param text - 原文。
 * @param maxBytes - 字节上限。
 * @returns 裁好的文本（未超限时原样返回）。
 */
export function clampUtf8(text, maxBytes) {
  const source = String(text ?? '')
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source
  // 先按字节粗裁，再向前退到合法字符边界。
  let cut = Math.max(0, Math.floor(maxBytes))
  const buf = Buffer.from(source, 'utf8').subarray(0, cut)
  // subarray 可能停在半个字符上：toString 会把残缺字节变成 U+FFFD，
  // 所以退到最后一个完整的起始字节。
  let end = buf.length
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1
  if (end > 0 && buf[end - 1] >= 0xc0) end -= 1
  return buf.subarray(0, end).toString('utf8')
}

/**
 * 校验 Chat Completions 请求体的**结构性**必填项。
 *
 * 与 `parseChatRequest` 分工：解析函数负责"尽力翻译"（宽容），这个函数负责
 * "根本不成立的请求要挡住"（严格）。两者分开是因为解析还要服务内部复用
 * （例如 DSH 自己构造的请求体），而校验只用于**对外入口**。
 *
 * 为什么必须挡：实测 `messages` 缺失 / `messages: 42` / `messages: []` /
 * `messages: [null]` 全都被解析成空消息列表，转发给上游后返回
 * `200 { content: null }`。对客户端来说这比报错更糟——它把"请求根本没带内容"
 * 伪装成"模型无话可说"，调用方会把它当成正常回复记进上下文。
 *
 * 与另两条通道对齐：Anthropic 通道（`validateAnthropicRequest`）早就这样挡，
 * Responses 通道缺省 `input` 也挡；只有 chat 放行了，属于历史遗漏。
 *
 * @param body - 已 JSON.parse 的请求体。
 * @returns 错误描述；通过时返回 undefined。
 */
export function validateChatRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return '请求体必须是 JSON 对象'
  if (typeof body.model !== 'string' || body.model.trim().length === 0) return '缺少 model 字段'
  if (!Array.isArray(body.messages)) return '缺少 messages 字段（必须是数组）'
  if (body.messages.length === 0) return 'messages 不能为空数组（至少要有 1 条消息）'
  // 逐条检查形状：上游对 `{role:'user'}` 缺 content、`content:42` 都表现不一，
  // 有的回 400 有的当空串。网关先挡住，错误码就统一了。
  for (const [index, message] of body.messages.entries()) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return `messages[${index}] 必须是对象`
    }
    if (typeof message.role !== 'string' || message.role.length === 0) {
      return `messages[${index}].role 必须是非空字符串`
    }
    // content 允许 null（assistant 只带 tool_calls 时 OpenAI 就是这个形状），
    // 但不允许数字/布尔这种"看起来像内容、其实不是"的类型。
    const content = message.content
    if (content !== undefined && content !== null && typeof content !== 'string' && !Array.isArray(content)) {
      return `messages[${index}].content 必须是字符串、分片数组或 null`
    }
  }
  return undefined
}

/**
 * 校验 Responses 请求体里"必须有内容"这一条。
 *
 * `input` 缺省已经被 `parseResponsesRequest` 挡住，但 `input: []` 会一路
 * 翻译成空消息列表（与 chat 的空 messages 是同一个坑）。
 *
 * @param body - 已 JSON.parse 的请求体。
 * @returns 错误描述；通过时返回 undefined。
 */
export function validateResponsesRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return '请求体必须是 JSON 对象'
  if (typeof body.model !== 'string' || body.model.trim().length === 0) return '缺少 model 字段'
  if (body.input === undefined || body.input === null) return '缺少 input 字段'
  if (Array.isArray(body.input) && body.input.length === 0) {
    return 'input 不能为空数组（至少要有 1 条消息或 1 段文本）'
  }
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) {
    return 'input 必须是字符串或数组'
  }
  return undefined
}

/**
 * 把 OpenAI 的 content（字符串或分片数组）拍平成文本 + 图片引用收集。
 * @param content - OpenAI 的 content 字段。
 * @param images - 收集到的图片 data URL（就地追加）。
 * @returns 文本内容。
 */
function flattenContent(content, images) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) images.push(url)
    }
  }
  return parts.join('\n')
}

/**
 * 解析一个 data URL 图片。
 * @param dataUrl - 形如 `data:image/png;base64,....`。
 * @returns `{ mediaType, data }`，非图片或格式不支持时返回 undefined。
 */
export function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl).trim())
  if (!match) return undefined
  return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
}

/**
 * 把 OpenAI 的 tools 定义转成 DSH 的 ToolSchema。
 * @param tools - OpenAI tools 数组。
 * @returns DSH ToolSchema 数组（无效项跳过）。
 */
export function toToolSchemas(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = tool.type === 'function' ? tool.function : tool
    if (fn === null || typeof fn !== 'object') continue
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters !== null && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把 OpenAI 请求体转成中立的「待构造消息」描述。
 *
 * 这里**不直接构造 DSH Message**（那需要 message.js 的工厂函数与 brand 类型），
 * 而是产出与 DSH 结构等价的纯数据，由调用方用官方工厂函数实例化。
 *
 * @param body - OpenAI 请求体（已 JSON.parse）。
 * @returns `{ system, turns, images, toolSchemas, warnings }`。
 */
export function parseChatRequest(body) {
  const warnings = []
  const images = []
  const turns = []
  let system

  const rawMessages = Array.isArray(body?.messages) ? body.messages : []
  // ⚠ 超限时必须**从尾部保留**（第十轮 #109）。
  //
  // 原来写的是 `slice(0, MAX_MESSAGES)` —— 丢掉的是数组**末尾**的消息，
  // 而对话里最新的用户提问恰好在那里。505 条的会话会被截成"只有前 500 条"，
  // 模型看不到最新一句，于是回答一个早就过时的提问。
  // 用户视角是"模型答非所问"，排查方向会完全跑偏（去查模型、查 prompt），
  // 而不是想到"我的对话被截断了"。
  //
  // system/developer 由下面的循环单独抽出（不进 turns），所以这里**只需保尾部**，
  // 不必为它们预留名额。同理 anthropic.js 也是这个处理。
  const truncated = rawMessages.length > MAX_MESSAGES
  const keptMessages = truncated ? rawMessages.slice(-MAX_MESSAGES) : rawMessages
  if (truncated) {
    warnings.push(`messages 条数超过上限 ${MAX_MESSAGES}，已保留最近 ${MAX_MESSAGES} 条（丢弃最早的 ${rawMessages.length - MAX_MESSAGES} 条）`)
  }

  for (const message of keptMessages) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role

    if (role === 'system' || role === 'developer') {
      const text = flattenContent(message.content, images)
      system = system === undefined ? text : `${system}\n\n${text}`
      continue
    }

    if (role === 'user') {
      const text = flattenContent(message.content, images)
      if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        warnings.push('存在超长消息，已按上限截断')
      }
      turns.push({ role: 'user', text: clampUtf8(text, MAX_TEXT_BYTES) })
      continue
    }

    if (role === 'assistant') {
      const text = flattenContent(message.content, images)
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      turns.push({
        role: 'assistant',
        text,
        toolCalls: toolCalls
          .filter((c) => c !== null && typeof c === 'object')
          .map((c, index) => ({
            id: typeof c.id === 'string' && c.id.length > 0 ? c.id : `call_${index}`,
            name: typeof c.function?.name === 'string' ? c.function.name : '',
            arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : '{}',
          })),
      })
      continue
    }

    if (role === 'tool') {
      turns.push({
        role: 'tool',
        callId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        text: typeof message.content === 'string' ? message.content : flattenContent(message.content, []),
      })
      continue
    }

    warnings.push(`忽略了不支持的消息角色：${String(role)}`)
  }

  return {
    system,
    turns,
    images,
    toolSchemas: toToolSchemas(body?.tools),
    // 保留原始 tool_choice，交给 buildMessages 渲染成 system 指令（#120）。
    // 注意它**仍然**在 GATEWAY_DROPPED_PARAMS 里 —— 因为这不是协议级透传，
    // 只是近似。响应头同时标 soft，让客户端知道必要时该自己重试。
    toolChoice: body?.tool_choice,
    jsonMode: parseResponseFormat(body?.response_format),
    warnings,
  }
}

/**
 * 解析 OpenAI 的 `response_format`。
 *
 * 为什么必须解析而不是"看到就放行"：DSH 的 GenerateOptions 没有这个字段
 * （已核实），所以该参数**不可能**被原样透传给上游。若网关收下它、
 * 过了能力闸门、然后什么都不做，那就是标准的**静默忽略**——
 * 客户端以为拿到了"保证是 JSON"的输出，实际拿到的是普通文本。
 *
 * 因此在网关侧用**系统提示约束**兑现这个承诺：告诉模型"只输出 JSON"，
 * 并可选地给出 schema。这不能 100% 保证上游遵守（提示词不是硬约束），
 * 所以出站侧仍要靠客户端解析兜底；但这是本机条件下唯一诚实的实现。
 *
 * @param raw - OpenAI `response_format` 字段。
 * @returns `{ type: 'json_object' | 'json_schema', schema?, name? }`，无则 undefined。
 */
export function parseResponseFormat(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const type = raw.type
  if (type === 'json_object') return { type: 'json_object' }
  if (type === 'json_schema') {
    const spec = raw.json_schema
    if (spec === null || typeof spec !== 'object') return { type: 'json_object' }
    return {
      type: 'json_schema',
      name: typeof spec.name === 'string' ? spec.name : undefined,
      schema: spec.schema !== null && typeof spec.schema === 'object' ? spec.schema : undefined,
    }
  }
  // text / 未知类型：不施加约束（OpenAI 里 `{type:'text'}` 就是"不要 JSON 约束"）
  return undefined
}

/**
 * 把 JSON 模式约束渲染成一段系统提示。
 *
 * @param jsonMode - `parseResponseFormat()` 的返回值。
 * @returns 可直接拼到 system 后面的文本；无约束时返回 undefined。
 */
export function renderJsonModeInstruction(jsonMode) {
  if (jsonMode === undefined) return undefined
  const base =
    '输出格式要求：你的整条回答必须是一个合法的 JSON 值，' +
    '不要包含任何解释文字、前后缀、markdown 代码块或注释。'
  if (jsonMode.type === 'json_schema' && jsonMode.schema !== undefined) {
    const name = jsonMode.name === undefined ? '' : `（结构名：${jsonMode.name}）`
    return `${base}${name}必须符合以下 JSON Schema：\n${JSON.stringify(jsonMode.schema)}`
  }
  return base
}

/**
 * 把 `tool_choice` 渲染成一段系统提示（第十一轮 #120）。
 *
 * ## 为什么需要这一层
 *
 * DSH 的 `GenerateOptions` 里没有 `toolChoice` 字段（第七轮已全树核实），
 * 所以网关只能"丢弃并如实报告"。但丢弃的代价比想象中大：
 *
 *   · `required` —— agent 框架靠它**逼**模型走工具链。不生效时模型爱调不调，
 *     表现就是用户说的"变纯文本模型了、完全不像原有的效果"。
 *   · `{type:'function', function:{name}}` —— 指定必须调某个工具。
 *   · `none` —— 禁止调工具（想让模型先说话的场景）。
 *
 * 这三种意图都很明确，用一段 system 指令**能近似表达**。
 * 它与 `jsonMode` 走同一套机制（那边已经有先例，也被验证有效）。
 *
 * ## 诚实性
 *
 * 这是**软约束**（模型可以不听），不是协议级强制。所以：
 *   · 响应头仍会标 `X-Lantern-Tool-Choice: soft`；
 *   · `X-Lantern-Dropped-Params` 里仍保留 `tool_choice` 这个名字 ——
 *     但语义从"完全丢弃"变成"已用 system 近似，非协议级"。
 *
 * @param toolChoice - 客户端原始 `tool_choice`。
 * @param toolSchemas - 已解析的工具定义（用来点出工具名，避免空列表时瞎说）。
 * @returns 可直接拼到 system 后面的文本；不需要时返回 undefined。
 */
export function renderToolChoiceInstruction(toolChoice, toolSchemas) {
  if (toolChoice === undefined || toolChoice === null) return undefined
  const names = Array.isArray(toolSchemas) ? toolSchemas.map((t) => t?.name).filter((n) => typeof n === 'string') : []

  if (toolChoice === 'none') {
    return '工具调用要求：本轮**不要调用任何工具**，直接用自然语言回答。'
  }
  if (toolChoice === 'required' || toolChoice === 'any') {
    // ── 第十八轮 #186：`required` 的措辞必须带上「完成条件」（死循环根因）──
    //
    // 原来只有一句"本轮**必须调用工具**，不要只给文字说明"。
    // 而 buildMessages 会把它拼进 system、system 又拼进**第一条 user 消息**，
    // 于是这句话**贯穿整个对话历史、永久生效**。
    //
    // 实测后果（`LOOP-REPRO.mjs`）：
    //   deepseek-v4.1-flash 第1轮 [run_command, run_command]
    //                       第2轮 [run_command]
    //                       第3轮 [run_command]  ← 与上轮完全相同，死循环
    //   glm / hy4 / Seed       同样连续 4 轮都在调 run_command，从不停手
    //
    // 用户侧表现：`已搜索 7 次文件，执行 15 条命令` → `已搜索 17 次，执行 52 条`
    // → `已搜索 11 次，执行 21 条` …… 永远在同一个动作上打转。
    //
    // 根因不是模型笨，而是它**被系统性告知"永远不能只用文字回答"**。
    // 一旦工具真的返回了结果、它本该总结作答，却仍然"必须调用工具"。
    //
    // 修法：把"必须调工具"限定为**完成任务的必要条件**，并显式给出
    // **收手条件**（工具已经给出足够信息时就用文字回答）。
    // 这样既保留了 required 的"别偷懒直接说"语义，又不会让它无限循环。
    const hint = names.length > 0 ? `（可用工具：${names.join('、')}）` : ''
    return '工具调用要求：优先调用工具来获取真实信息，不要凭空猜测或只给文字说明。'
      + hint
      + '\n**收手条件：一旦工具结果已经足以回答问题，就立即停止调用工具、直接用文字给出最终回答。'
      + '切勿对同一个工具、同样的参数反复调用。**'
  }
  if (toolChoice === 'auto') return undefined

  if (typeof toolChoice === 'object') {
    const fn = toolChoice.function ?? toolChoice
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (name !== undefined) {
      return `工具调用要求：本轮**必须调用 \`${name}\` 这个工具**来完成任务，不要改用别的工具，也不要只给文字说明。`
        + '\n**收手条件：该工具返回结果后，立即用文字给出最终回答，不要重复调用同一个工具。**'
    }
  }
  return undefined
}

/**
 * 网关**根本无法兑现**的 OpenAI 参数（与"模型不支持"是两件事）。
 *
 * ⚠ 为什么必须单独列出：DSH 的 `GenerateOptions` 只有
 * `provider/model/reasoningEffort?/messages/system?/tools?/toolHistory?/temperature?/maxTokens?/stop?/signal?/sessionId?/purpose?`
 * 这几项（已核实）。其余 OpenAI 参数**没有任何透传路径**——
 * 客户端填了 `top_p: 0.1` 却拿到默认分布的回答，这不是"上游不听话"，
 * 而是网关把它丢了却不说。设计文档的铁律是「降级永远可见，不可静默」，
 * 所以这里如实列出来，由调用方写进 `X-Lantern-Dropped-Params` 响应头。
 *
 * 与 `CapabilityResolver.enforce()` 的 `ignored` 分工：
 * - `X-Lantern-Ignored-Params`：**模型**不支持该能力（能力三态判定），换个模型就能用；
 * - `X-Lantern-Dropped-Params`：**网关**没有该参数的通道（换模型也没用）。
 * 两者混在一起会让排障方向完全反掉。
 */
export const GATEWAY_DROPPED_PARAMS = Object.freeze([
  'n',
  'top_p',
  // `tool_choice`：DSH 整棵依赖树里**一个 toolChoice 字段都没有**（已全树核实，
  // 连 pi-ai / deepseek 两个 adapter 都只消费 options.tools，不消费调用策略）。
  // 早先 chat 通道连"丢"都没报——客户端传 `tool_choice:'required'` 以为强制调工具，
  // 实际模型想调就调、想说话就说话，而响应里没有任何提示。这是最坏的一种失真：
  // 参数看起来被接受了。现在如实进 Dropped-Params。
  'tool_choice',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'user',
  'parallel_tool_calls',
  'service_tier',
  'metadata',
  'store',
  'stream_options',
])

/**
 * 把 OpenAI 的 `reasoning_effort` 映射成 DSH 的 `ReasoningEffortId`。
 *
 * ⚠ 这里曾经**只用于能力闸门判定、从未下发给上游**：客户端传
 * `reasoning_effort:'high'`，闸门放行后这个字段就被丢了，模型照样按
 * 自己的默认档位思考。用户以为调高了推理强度，实际什么也没变——
 * 又一次静默失真。
 *
 * 三态处理（每一态都必须可解释）：
 * 1. 没传 → `{}`（不干预，用 provider 默认）；
 * 2. 传了且在 `caps.reasoning.efforts` 里 → 下发该档位；
 * 3. 传了但**不在**声明列表里 → 返回 `{ error }`，由调用方 400 拒绝
 *    （静默改成相近档位就是替用户做决定；直接透传非法 Branded 值又会让上游
 *    抛出一个与本网关无关的错）。
 *
 * ⚠ 列表为空但能力被标为 supported（人工 override）时**不校验**，
 * 原样下发——那是管理员显式声明"我担保它支持"，网关不该反过来猜。
 *
 * @param caps - 能力视图（`CapabilityResolver.describe()` 的结果）。
 * @param requested - 客户端给的 `reasoning_effort`（可能是数字或任意类型）。
 * @returns `{ value }` / `{ error: { message, efforts } }` / `{}`。
 */
export function resolveReasoningEffort(caps, requested) {
  if (requested === undefined || requested === null) return {}
  const raw = typeof requested === 'string' ? requested.trim() : String(requested)
  if (raw.length === 0) return {}
  const cap = caps?.reasoning
  const efforts = Array.isArray(cap?.efforts) ? cap.efforts.filter((e) => typeof e === 'string') : []
  if (efforts.length === 0) return { value: raw }
  const hit = efforts.find((e) => e === raw) ?? efforts.find((e) => e.toLowerCase() === raw.toLowerCase())
  if (hit === undefined) {
    return {
      error: {
        message: `reasoning_effort「${raw}」不在该模型声明的推理档位里。可选值：${efforts.join(' / ')}`,
        efforts,
      },
    }
  }
  return { value: hit }
}

/**
 * 从一份真实词表里挑出**最强**的那一档。
 *
 * ⚠ 为什么不能写 `efforts[efforts.length - 1]`：那只在"DSH 权威列表"下成立。
 * 多绑定模型的 `efforts` 是各档词表的**并集**，按"首次出现顺序"拼出来
 * （见 index.js 的 `mergeReasoningCell`），既不是升序也不是降序 ——
 * 本机实测 `hy4` 是 `["high","low","medium","xhigh","max"]`，末档碰巧是 max；
 * 但某家若声明成 `["none","low","high"]`，末档就是 high，看着没事；
 * 而 `["high","none"]` 这种顺序下末档是 `none` —— "要开思考"被映射成"关掉思考"。
 * 这类错误不会报错，只会让用户觉得"调了没反应"。
 *
 * @param {string[]} efforts - 词表（可含任意私有词）。
 * @returns {string|undefined} 最强的一档；词表为空或全是认不出的词时为 undefined。
 */
export function highestEffortOf(efforts) {
  const list = Array.isArray(efforts) ? efforts.filter((e) => typeof e === 'string' && e.length > 0) : []
  let best
  let bestRank = -1
  for (const word of list) {
    const rank = rankOf(word)
    if (rank === undefined) continue
    if (rank > bestRank) { best = word; bestRank = rank }
  }
  // 全是不认识的词：只有唯一一个时才敢用（别无选择），否则不猜。
  if (best === undefined && list.length === 1) return list[0]
  return best
}

/**
 * 从一份真实词表里挑出**最弱**的那一档（"关掉思考"的首选）。
 *
 * @param {string[]} efforts - 词表。
 * @returns {string|undefined}
 */
export function lowestEffortOf(efforts) {
  const list = Array.isArray(efforts) ? efforts.filter((e) => typeof e === 'string' && e.length > 0) : []
  let best
  let bestRank = Number.POSITIVE_INFINITY
  for (const word of list) {
    const rank = rankOf(word)
    if (rank === undefined) continue
    if (rank < bestRank) { best = word; bestRank = rank }
  }
  if (best === undefined && list.length === 1) return list[0]
  return best
}

/**
 * 把 Anthropic 的 `thinking` 映射成 DSH 的推理档位。
 *
 * Anthropic 的表达是"开/关 + 思考预算 token"，DSH 的表达是"档位 id"——
 * 两者**不等价**，所以这里只做能力上诚实的映射，映射不了的部分如实报进
 * `dropped`，绝不假装 `budget_tokens` 生效了。
 *
 * - `{type:'disabled'}` → 优先 `off`（档位里有时），否则不下发并记为 dropped；
 * - `{type:'enabled'}` → 优先 `defaultEffort`，否则取声明列表的**最后一档**
 *   （DSH 的列表按低→高排列），并记 `budget_tokens` 为 dropped
 *   （预算值本身没有对应字段，说"我按你的预算调了"就是撒谎）；
 * - 其它形态（含 `type:'auto'` 一类非官方值）→ 不下发，记 dropped。
 *
 * @param caps - 能力视图。
 * @param thinking - Anthropic 请求体的 `thinking`。
 * @returns `{ value?, dropped: string[], note? }`。
 */
export function resolveAnthropicThinking(caps, thinking) {
  const dropped = []
  if (thinking === undefined || thinking === null) return { dropped }
  if (typeof thinking !== 'object') return { dropped: ['thinking'] }
  const cap = caps?.reasoning
  const efforts = Array.isArray(cap?.efforts) ? cap.efforts.filter((e) => typeof e === 'string') : []
  const type = thinking.type

  if (type === 'disabled') {
    if (efforts.length === 0) return { dropped: ['thinking'] }
    // 「关掉思考」只在真的存在关闭档时才做得到。
    // 注意这里**不**退而求其次去选最弱的档：`low` 仍然在思考，
    // 把它当成"已关闭"就是对用户的静默失真。宁可如实报 dropped + note。
    //
    // ⚠ 必须按**强度**匹配，不能按字面匹配 `'off'`（第十轮 #110）。
    //
    // 本机 5 个模型的词表**没有一个**含 `off` —— 它们用的是 `none`
    // （Qwen 的 `[none,low,medium,high,xhigh]`、glm 的 `[...none...]`）。
    // 按字面匹配 `off` 的结果是：永远匹配不上 → 永远报"未能生效"，
    // 而 `index.js` 那边却硬编码了 `'minimal'` 契约档照常下发 ——
    // 同一个响应里同时出现三句互相矛盾的话：
    //   X-Lantern-Thinking-Note: 该模型没有可关闭推理的档位…未能生效
    //   X-Lantern-Effort-Served: none
    //   X-Lantern-Dropped-Params: thinking
    // 而响应体里**确实**返回了 thinking 块 —— 思考根本没关。
    //
    // `off` 与 `none` 是同一档的两种叫法（rank 都是 0），换名字不算降级。
    // 判据改用 rankOf === 0，两条路径就自洽了。
    const off = efforts.find((e) => rankOf(e) === 0)
    if (off === undefined) {
      // 这个模型真的没有"关闭"档（最弱也还在思考）：不下发，并如实说明没做到
      return { dropped: ['thinking'], note: '该模型没有可关闭推理的档位，thinking.type=disabled 未能生效' }
    }
    return { value: off, dropped }
  }

  if (type === 'enabled') {
    if (thinking.budget_tokens !== undefined) dropped.push('thinking.budget_tokens')
    if (efforts.length === 0) {
      return { dropped, note: '该模型未声明推理档位，thinking 未能映射（DSH 的 GenerateOptions 无 budget_tokens 通道）' }
    }
    // 优先级：声明的 defaultEffort（它才是这家真实的默认）→ 词表里最强的档。
    // 旧代码的兜底是 `efforts[efforts.length - 1]`，那是靠数组位置猜"最高"，
    // 在"各档并集"这种非有序列表上会挑到最低档（见 highestEffortOf 的注释）。
    const preferred = typeof cap?.defaultEffort === 'string' ? cap.defaultEffort : undefined
    const chosen = preferred !== undefined && efforts.includes(preferred)
      ? preferred
      : highestEffortOf(efforts)
    if (chosen === undefined) {
      return { dropped, note: '该模型的推理档位里没有可识别的强弱关系，thinking 未能映射' }
    }
    return { value: chosen, dropped }
  }

  return { dropped: ['thinking'], note: `不支持的 thinking.type：${String(type)}` }
}

/**
 * Anthropic 协议里网关**没有通道**的参数。
 *
 * DSH 的 `GenerateOptions` 是 OpenAI 口径的统一抽象，Anthropic 专有的
 * `top_k` / `metadata` / `service_tier` / `tool_choice` / `mcp_servers` / `container`
 * 在它里面**没有任何对应字段**。同样必须显式披露，不能静默。
 *
 * `thinking` 不在此列：它有映射路径（见 `resolveAnthropicThinking()`），
 * 映射不上时由调用方单独标注。
 */
export const ANTHROPIC_DROPPED_PARAMS = Object.freeze([
  'top_k',
  'metadata',
  'service_tier',
  'tool_choice',
  'mcp_servers',
  'container',
])

/**
 * 找出本次 Anthropic 请求里被网关**丢弃**的参数名。
 *
 * @param body - Anthropic 请求体（已 JSON.parse）。
 * @returns 参数名数组；未出现则为空数组。
 */
export function describeAnthropicDroppedParams(body) {
  if (body === null || typeof body !== 'object') return []
  return ANTHROPIC_DROPPED_PARAMS.filter((key) => body[key] !== undefined)
}

/**
 * 找出本次请求里被网关**丢弃**的参数名。
 *
 * @param body - OpenAI 请求体（已 JSON.parse）。
 * @returns 参数名数组（按 GATEWAY_DROPPED_PARAMS 顺序；未出现则为空数组）。
 */
export function describeDroppedParams(body) {
  if (body === null || typeof body !== 'object') return []
  return GATEWAY_DROPPED_PARAMS.filter((key) => body[key] !== undefined)
}

/**
 * 把 DSH 的 TokenUsage 转成 OpenAI usage 口径。
 *
 * ⚠ 官方语义：计数**互斥**，`billed input = inputTokens + cacheReadTokens + cacheWriteTokens`。
 * 而 OpenAI 的 `prompt_tokens` 是**总量**（含缓存）→ 必须相加。
 *
 * @param usage - DSH TokenUsage。
 * @returns OpenAI usage 对象。
 */
export function toOpenAiUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const cached = usage.cacheReadTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  const prompt = (usage.inputTokens ?? 0) + cached + written
  const completion = usage.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(cached > 0 || written > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cached,
            ...(written > 0 ? { cache_write_tokens: written } : {}),
          },
        }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  }
}

/** 把 DSH finish 原因映射为 OpenAI 的 finish_reason。 */
const FINISH_MAP = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  'max-tokens': 'length',
  aborted: 'stop',
  error: 'stop',
}

/**
 * 把 DSH 的 finish 原因转成 OpenAI 的 finish_reason。
 * @param reason - DSH FinishReason。
 * @returns OpenAI finish_reason 字符串。
 */
export function toFinishReason(reason) {
  return FINISH_MAP[reason?.kind] ?? 'stop'
}

/**
 * 流式翻译器：把 DSH StreamChunk 序列转成 OpenAI SSE 帧。
 *
 * 用法：
 * ```js
 * const tr = new OpenAiStreamTranslator({ id, model, includeUsage: true })
 * for await (const chunk of ctx.llm.stream(...)) {
 *   for (const frame of tr.push(chunk)) res.write(frame)
 * }
 * for (const frame of tr.end()) res.write(frame)
 * ```
 */
export class OpenAiStreamTranslator {
  /**
   * @param options - 响应 id、公开模型名、是否在末尾带 usage。
   */
  constructor({ id, model, includeUsage = true, created = Math.floor(Date.now() / 1000), sanitize }) {
    this.id = id
    this.model = model
    this.created = created
    this.includeUsage = includeUsage
    this.started = false
    // #175：是否已经产出过实质内容（text / reasoning / tool-call）。
    // keepalive() 用它决定"还要不要发空帧"——出过内容之后再发就是噪音。
    this.hasContent = false
    this.usage = undefined
    this.finishReason = 'stop'
    this.toolIndexes = new Map()
    this.nextToolIndex = 0
    this.errorFrame = undefined
    // 可选脱敏钩子：把 `{message, code}` 换成对外版本。
    // 流式帧一旦发出就改不了 HTTP 状态码，所以这里必须和错误体走同一套判据，
    // 否则会出现"非流式藏得好好的、流式却把上游原文吐出去"的分叉。
    this.sanitize = typeof sanitize === 'function' ? sanitize : undefined
  }

  /**
   * 组一个**对外安全**的错误体。
   * @param failure - 原始失败 `{message, code}`。
   * @returns `{message, type, code}`。
   */
  #errorBodyOf(failure) {
    const raw = { message: failure?.message ?? '上游模型调用失败', code: failure?.code ?? 'upstream_error' }
    const safe = this.sanitize === undefined ? raw : this.sanitize(raw)
    return { message: safe?.message ?? '上游模型调用失败', type: 'upstream_error', code: safe?.code ?? 'upstream_error' }
  }

  /** 首帧：带上 role（OpenAI 客户端依赖它初始化消息）。 */
  #firstFrame() {
    if (this.started) return ''
    this.started = true
    return this.#frame({ role: 'assistant', content: '' })
  }

  /**
   * 「还在等」的保活帧（第十六轮 #175）。
   *
   * 与 `: ping` 注释帧的区别：
   *   · `: ping` 是 SSE **注释**，按规范解析器必须忽略 —— 客户端界面毫无反应；
   *   · 本方法发的是一个**合法的空 content 帧**，多数客户端收到后会刷新
   *     "正在输入"状态或重置空闲计时器。
   *
   * 为什么需要它：实测 `Seed-2.1-Pro` 在 `trae` 上游会先空白 **116 秒**，
   * 然后在 43ms 内吐完全部 2,890 字。那 116 秒里若只发注释帧，用户看到的是
   * 完全静止的界面，只能认为"卡死了"。
   *
   * ⚠ 只在**还没有任何实质内容**时调用（首次 `push()` 之前）。
   * 一旦出过 text/reasoning，再发空帧就是噪音，还可能打断客户端的打字机动画。
   *
   * @returns {string[]} 要写出的帧（可能为空）。
   */
  keepalive() {
    if (this.started === false) {
      // 还没发过首帧：连 role 一起发，顺便初始化客户端消息
      return [this.#firstFrame()]
    }
    if (this.hasContent === true) return []
    return [this.#frame({ content: '' })]
  }

  /** 标记已产出实质内容（供 keepalive 判断）。 */
  markContent() {
    this.hasContent = true
  }

  /**
   * 组一个 SSE 帧。
   * @param delta - choices[0].delta。
   * @param extra - 附加到 choices[0] 的字段。
   * @returns SSE 文本。
   */
  #frame(delta, extra = {}) {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, ...extra }],
    })}\n\n`
  }

  /**
   * 送入一个 DSH chunk，返回要写出的 SSE 帧（可能为空数组）。
   * @param chunk - DSH StreamChunk。
   * @returns SSE 帧数组。
   */
  push(chunk) {
    const frames = []
    const head = this.#firstFrame()
    if (head.length > 0) frames.push(head)

    // #175：任何实质内容到达 → 记下来，keepalive() 之后就不再发空帧
    if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta') {
      this.markContent()
    }

    switch (chunk?.type) {
      case 'text-delta':
        if (chunk.text) frames.push(this.#frame({ content: chunk.text }))
        break

      case 'reasoning-delta':
        // DeepSeek 惯例字段；非标但主流客户端认（设计文档 §6.1）
        if (chunk.text) frames.push(this.#frame({ reasoning_content: chunk.text }))
        break

      case 'tool-call-delta': {
        // 按 DSH 的 index 聚合，映射到 OpenAI 的连续 tool_calls 索引
        let index = this.toolIndexes.get(chunk.index)
        const isFirstOfThisCall = index === undefined
        if (isFirstOfThisCall) {
          index = this.nextToolIndex++
          this.toolIndexes.set(chunk.index, index)
        }
        // ── OpenAI 规范：id / type / name 只在**该调用第一帧**出现（第十八轮 #185）──
        //
        // 这是死循环的根因。原来每一帧都带完整 id + name + type，实测一帧流：
        //
        //   tour1 index=0 id="call_00_..." name="web_search" args=""
        //   tour2 index=0 id="call_00_..." name="web_search" args="{\""
        //   tour3 index=0 id="call_00_..." name="web_search" args="query"
        //   ...
        //
        // 拼起来 args 是正确的，但**每帧都声称自己是"一个完整的工具调用"**。
        // 于是：
        //   · 严格按规范解析的客户端会按帧建出 N 个调用，
        //     每个拿到的 arguments 都是残片（"query"、"今天"、"\""）→ JSON 解析失败
        //   · 所有工具执行都飘红（截图里的红色 X）
        //   · 模型看到"工具没成功"就重试 → **无限死循环**（"已搜索 14 次文件"刷屏）
        //
        // OpenAI 的 delta 语义：后续帧只给 `arguments` 增量，其余字段省略。
        // 客户端靠同一个 `index` 把它们拼回一个调用。
        const call = {
          index,
          ...(isFirstOfThisCall
            ? {
                ...(chunk.id ? { id: chunk.id } : { id: `call_${index}` }),
                type: 'function',
                function: {
                  ...(chunk.name !== undefined ? { name: chunk.name } : {}),
                  arguments: chunk.argumentsDelta ?? '',
                },
              }
            : {
                // 后续帧：只送增量参数。不带 id/type/name，
                // 让客户端凭 index 归并到同一个调用。
                function: { arguments: chunk.argumentsDelta ?? '' },
              }),
        }
        frames.push(this.#frame({ tool_calls: [call] }))
        break
      }

      case 'usage':
        this.usage = toOpenAiUsage(chunk.usage)
        break

      case 'finish':
        this.finishReason = toFinishReason(chunk.reason)
        if (chunk.reason?.kind === 'error') {
          this.errorFrame = { error: this.#errorBodyOf(chunk.reason.failure) }
        }
        break

      default:
        break
    }
    return frames
  }

  /**
   * 结束流。
   *
   * 分两种情况（**"如实"与"静默失真"的分界**）：
   *
   * 1. **正常结束**：`finish_reason` 帧 → `[DONE]`。
   * 2. **上游报错**（DSH 已感知的 `kind:'error'`）：先发一个带 `error` 对象的帧，
   *    再发 `[DONE]`。
   *
   * ⚠ 为什么必须带 `error` 对象：HTTP 状态码在首个 SSE 帧时**已发出**（只能是 200），
   * 中途出错无法改状态码。若只发一个 `finish_reason:"stop"` 就结束，客户端会看到
   * "200 + 空内容 + 正常结束"——把上游故障**伪装成正常空回答**。OpenAI 兼容客户端
   * 普遍识别 data 帧里的 `error` 字段，据此报错而不是当成功。
   *
   * 责任边界：只转发 **DSH 已感知**的错误；provider 自己的静默行为（静默截断、
   * 静默忽略参数）本插件不检测、不伪造，原样透传。
   *
   * @returns SSE 帧数组。
   */
  end() {
    const frames = []
    const head = this.#firstFrame()
    if (head.length > 0) frames.push(head)

    if (this.errorFrame !== undefined) {
      // 如实发出错误帧后收尾（仍发 [DONE]，让客户端正常结束读取循环）
      frames.push(`data: ${JSON.stringify(this.errorFrame)}\n\n`)
      frames.push('data: [DONE]\n\n')
      return frames
    }

    const tail = { finish_reason: this.finishReason }
    if (this.includeUsage && this.usage !== undefined) tail.usage = this.usage
    frames.push(this.#frame({}, tail))
    frames.push('data: [DONE]\n\n')
    return frames
  }

  /** 若上游报错，取出待发或已发的错误信息。 */
  get error() {
    return this.errorFrame
  }

  /**
   * 由**调用方**标记一个流式失败（例如 `for await` 抛出）。
   *
   * 用于兜住"错误不是以 finish chunk 形式到达"的情形——否则 `end()` 会走正常收尾，
   * 客户端只会看到 "200 + 正常结束 + 空内容"，即把上游故障伪装成正常空回答。
   *
   * @param failure - `{ message, code }`（可为 undefined，用通用文案）。
   */
  markFailed(failure) {
    this.errorFrame = { error: this.#errorBodyOf(failure) }
  }
}

/**
 * 非流式聚合器：把 DSH chunk 序列聚成一个完整响应体。
 */
export class OpenAiAggregator {
  /**
   * @param options - 响应 id 与公开模型名。
   */
  constructor({ id, model, created = Math.floor(Date.now() / 1000) }) {
    this.id = id
    this.model = model
    this.created = created
    this.text = ''
    this.reasoning = ''
    /** @type {Map<number, {id?:string,name?:string,args:string}>} */
    this.tools = new Map()
    this.usage = undefined
    this.finishReason = 'stop'
    this.failure = undefined
  }

  /**
   * 送入一个 chunk。
   * @param chunk - DSH StreamChunk。
   */
  push(chunk) {
    switch (chunk?.type) {
      case 'text-delta':
        this.text += chunk.text ?? ''
        break
      case 'reasoning-delta':
        this.reasoning += chunk.text ?? ''
        break
      case 'tool-call-delta': {
        const current = this.tools.get(chunk.index) ?? { args: '' }
        if (chunk.id) current.id = chunk.id
        if (chunk.name !== undefined) current.name = chunk.name
        current.args += chunk.argumentsDelta ?? ''
        this.tools.set(chunk.index, current)
        break
      }
      case 'usage':
        this.usage = toOpenAiUsage(chunk.usage)
        break
      case 'finish':
        this.finishReason = toFinishReason(chunk.reason)
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        break
      default:
        break
    }
  }

  /**
   * 这次调用有没有产出（文本 / 推理 / 工具调用任一）。
   *
   * 存在的理由：上游可能回一个"正常收尾、零内容"的流（限流静默、风控静默、
   * 上游适配器把失败吞成空 chunk）。把它当成功会同时骗两个人：
   * 客户端拿到 200 + content:null 以为模型无话可说；账本记 status:'ok'，
   * 面板上一切正常，故障完全没有痕迹。调用方据此决定是否重试/换后端。
   *
   * ⚠ **推理内容算产出，但由 `end()` 额外标出来**：
   * OpenAI 兼容客户端只读 `content`，`reasoning_content` 是非标字段。
   * 高推理档位把预算全花在思考上时（实测 `max_tokens:48` + `reasoning_effort:max`
   * → `content:null` / `reasoning_content` 1398 字），调用方看到的就是空回答。
   *
   * 这**不能**判成空产出去重试：换哪个后端都一样会先思考，
   * 重试只会把同样的预算再烧一遍。真正的原因是"预算不够"，不是"后端挂了"。
   * 所以这里保持语义不变，改由 `end()` 把 `finish_reason` 标成 `reasoning_only`。
   *
   * @returns 完全空白时 true。
   */
  isEmpty() {
    return this.text.length === 0 && this.reasoning.length === 0 && this.tools.size === 0
  }

  /**
   * 只出了推理、没有正文（预算被思考吃完的典型形态）。
   *
   * @returns 有推理但无正文且无工具调用时为 true。
   */
  isReasoningOnly() {
    return this.text.length === 0 && this.tools.size === 0 && this.reasoning.length > 0
  }

  /**
   * 正文里出现了**上游自己的工具调用标记**（第十一轮 #125）。
   *
   * ## 现象
   *
   * 某些后端（实测 glm-5.3 走某个 provider）不认 DSH 的 `tool-call` 内容块，
   * 于是把工具调用渲染成了**它自己的模板标记**，当成普通文本吐出来：
   *
   *     <｜｜DSML｜｜ calls>
   *     <｜｜DSML｜｜ invoke name="get_weather">
   *     ...
   *
   * 客户端拿到的是 `content` 里的一坨标记 + `tool_calls: []`（空）。
   * 于是 agent 框架认为"模型没调工具"，把这段标记当正文显示给用户 ——
   * 用户看到的就是"模型在胡说八道、工具完全没生效"。
   *
   * ## 网关能做什么（以及不能做什么）
   *
   * 不能：把标记解析回结构化 tool_calls —— 那是猜，各家标记格式不同且未公开，
   * 猜错会把"模型说了什么"变成"网关以为模型说了什么"。
   *
   * 能：**如实标注**。检测到这种形态时把 finish_reason 标成
   * `tool_markup_leaked`，并让响应头说明"后端不支持结构化工具调用，
   * 已把标记原样返回"。客户端据此可以：换模型、或自己解析标记、或提示用户。
   *
   * 这比静默返回一坨标记强得多 —— 静默才是最难查的。
   *
   * @returns 检测到的标记名，或 undefined（正常）。
   */
  leakedToolMarkup() {
    if (this.text.length === 0) return undefined
    // ── #214：模式表已移出本文件 ──
    //
    // 原来这里有 5 条内联正则。问题不是它们写错了，而是**只有这一条路径有**：
    // 流式路径完全没有检测，同一个后端在 stream=true / false 下行为不一致。
    //
    // 现在模式表在 `call-contract.js#LEAKED_TOOL_MARKUP_PATTERNS`，
    // 这个方法和流式路径都调 `detectLeakedToolMarkup()` —— 单一事实源。
    // 覆盖的形态（注释保留在这里，便于查"到底认哪些"）：
    //   DeepSeek 系  <｜｜DSML｜｜ ...>
    //   通用         <|tool_call|> / <function_call> / <tool▁calls>
    //   若各家还有别的，宁可漏报也不误报（误报会让正常回答被标成异常）
    return detectLeakedToolMarkup(this.text)
  }

  /**
   * 结束：产出完整 OpenAI ChatCompletion 响应体。
   * @returns 响应对象。
   */
  end() {
    const toolCalls = [...this.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value], index) => ({
        id: value.id ?? `call_${index}`,
        type: 'function',
        function: { name: value.name ?? '', arguments: value.args || '{}' },
      }))

    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.text.length > 0 ? this.text : null,
            ...(this.reasoning.length > 0 ? { reasoning_content: this.reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          // finish_reason 的**四态**（都要如实，别把异常伪装成正常）：
          //   · tool_markup_leaked —— 后端不支持结构化工具调用，把标记当文本吐了（#125）
          //   · reasoning_only     —— 只有推理、没有正文（预算被思考吃完）
          //   · empty_completion   —— **什么都没有**：正文空、推理空、无工具（#144）
          //   · 其它               —— 正常映射
          finish_reason: (() => {
            const leaked = this.leakedToolMarkup()
            if (leaked !== undefined && toolCalls.length === 0) return 'tool_markup_leaked'
            const noText = this.text.length === 0 && toolCalls.length === 0
            // ⚠ 顺序很重要：先判"彻底空"，再判"只有推理"。
            //
            // 实测（第十三轮）：`glm-5.3` 在 `reasoning_effort=max` + mt≥2000 时
            // 上游直接返回 **completion_tokens=0 / reasoning_tokens=0** —— 正文、
            // 推理、工具全空。而原来的判据要求 `reasoning.length > 0` 才算
            // reasoning_only，于是这种情况**落到了 `return this.finishReason`**，
            // 对外表现为 `finish_reason: "stop"` + `content: null`。
            //
            // 那是最坏的一种失真：调用方看到 "stop" 会认为模型正常答完了，
            // 只是"没说话"；实际是上游什么都没给。用户侧表现就是
            // "有响应但没内容，功能像坏了"。
            if (noText && this.reasoning.length === 0) return 'empty_completion'
            if (noText && this.reasoning.length > 0) return 'reasoning_only'
            return this.finishReason
          })(),
        },
      ],
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    }
  }
}

/**
 * 生成一个 OpenAI 风格的响应 id。
 * @returns 形如 `chatcmpl-xxxx` 的 id。
 */
export function newCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * 组一个 OpenAI 风格错误体（**绝不含上游原始错误里的敏感信息**，
 * 调用方负责先脱敏）。
 * @param message - 已脱敏的消息。
 * @param type - 错误类型。
 * @param code - 机器码。
 * @param extra - 附加字段（如 available 候选列表）。
 * @returns 错误响应对象。
 */
export function errorBody(message, type, code, extra = {}) {
  return { error: { message, type, code, ...extra } }
}
