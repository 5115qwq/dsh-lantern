/**
 * dsh-lantern — OpenAI Responses 协议翻译层（/v1/responses）。
 *
 * 职责与 anthropic.js 同构：只做协议差异，转发/闸门/记账全部复用
 * index.js 的公共链路（限流、读体、模型解析、能力闸门、图片闸门、
 * 并发闸门、附件账本、用量记账、负能力学习）。
 *
 * 入站：Responses 请求体 → 内部消息口径（与 Chat Completions 同构产物）。
 * 出站：DSH StreamChunk → Responses SSE 事件 / 非流式聚合响应。
 *
 * 支持的 Responses 子集（覆盖主流客户端 Codex CLI / OpenAI SDK 的默认路径）：
 * - input：字符串 或 分片数组（text / input_text / image_url / input_image）
 * - instructions → system 消息（置于最前）
 * - tools（function 类型）
 * - temperature / max_output_tokens（max_output_tokens 映射 maxTokens）
 * - reasoning.effort → DSH reasoningEffort（档位是否存在由能力档案判定）
 * - text.format（json_schema/json_object）→ jsonMode（拼进 system 约束）
 * - stream（SSE 事件序列见 ResponsesStreamTranslator）
 *
 * 明确**没有落地通道**、只记 dropped 的：top_p、tool_choice、metadata、store、
 * parallel_tool_calls、truncation、previous_response_id。
 * DSH 的 GenerateOptions 里没有前两项（全树核实），塞进去只会静默消失；
 * 宁可少一个参数，也不能让客户端以为它生效了。
 *
 * @module dsh-lantern/responses
 */
import { randomUUID } from 'node:crypto'
import { parseResponseFormat } from './protocol.js'

/** 生成一个 Responses 风格的响应 id。 */
export function newResponseId() {
  return `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * 把 Responses 的 input（字符串或分片数组）拍平成文本 + 图片引用收集。
 * 兼容两种分片写法：Chat 风格（type: 'text' / 'image_url'）与
 * Responses 专属（type: 'input_text' / 'input_image'）。
 */
function flattenResponsesContent(content, images) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' || part.type === 'input_text') {
      if (typeof part.text === 'string') parts.push(part.text)
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) images.push(url)
    } else if (part.type === 'input_image') {
      // Responses 形状：{type:'input_image', image_url:'data:...'}（字符串直挂）
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) images.push(url)
    }
  }
  return parts.join('\n')
}

/**
 * Responses 的 `text.format` → Chat 的 `response_format` 形状。
 *
 * 两者语义相同但**嵌套不同**：Responses 把结构名与 schema 直接放在 format 上
 * （`{ type:'json_schema', name, schema, strict }`），Chat 则包在 `json_schema`
 * 子对象里（`{ type:'json_schema', json_schema:{ name, schema, strict } }`）。
 * `parseResponseFormat` 只认后者；形状不对时它会把 json_schema 降级成
 * json_object —— 不报错，只是 schema 整段消失，模型拿到的是"随便给个 JSON"。
 * 这个降级是静默的，所以在这里显式归一化。
 *
 * @param fmt - Responses `body.text.format`。
 * @returns Chat 形状的 `response_format`，无约束时 undefined。
 */
function toChatResponseFormat(fmt) {
  if (fmt === null || typeof fmt !== 'object') return undefined
  if (fmt.type !== 'json_schema') return fmt
  // 已经是 Chat 形状（带 json_schema 子对象）就原样交给解析器
  if (fmt.json_schema !== null && typeof fmt.json_schema === 'object') return fmt
  const spec = {}
  if (typeof fmt.name === 'string') spec.name = fmt.name
  if (fmt.schema !== null && typeof fmt.schema === 'object') spec.schema = fmt.schema
  if (typeof fmt.strict === 'boolean') spec.strict = fmt.strict
  return { type: 'json_schema', json_schema: spec }
}

/**
 * 解析 Responses 请求体 → 内部口径。
 *
 * @param body - Responses 请求体。
 * @returns `{ system, turns, images, toolSchemas, stream, model, temperature, maxOutputTokens, jsonMode, reasoningEffort, dropped, warnings }`
 *   turns：role/text/toolCalls 口径，供 messages.js 拼 DSH 消息；
 *   toolSchemas：与 parseChatRequest 同构的工具数组（Responses 的 function
 *     工具形状与 Chat 兼容）。
 *   dropped：这台机器**没有落地通道**的字段（top_p / tool_choice / store …），
 *     调用方须写进 X-Lantern-Dropped-Params —— 静默丢弃是最坏的降级。
 * @throws Error 参数非法时（message 为中文用户向文案）。
 */
export function parseResponsesRequest(body) {
  if (body === null || typeof body !== 'object') throw new Error('请求体不是合法 JSON 对象')
  if (typeof body.model !== 'string' || body.model.length === 0) throw new Error('缺少 model 字段')

  const images = []
  const messages = []

  // instructions → system（置于消息列表最前）
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  // input：字符串 / 分片数组 / 消息数组
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    let sawUser = false
    for (const item of body.input) {
      if (item === null || typeof item !== 'object') continue
      // 消息形状：{role, content} 或 {type:'message', role, content}
      // 顶层 function_call 条目（不带 role）：历史助手轮的工具调用
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: typeof item.call_id === 'string' ? item.call_id : 'call_0',
            type: 'function',
            function: { name: typeof item.name === 'string' ? item.name : '', arguments: typeof item.arguments === 'string' ? item.arguments : '{}' },
          }],
        })
        continue
      }
      const role = typeof item.role === 'string' ? item.role : item.type === 'function_call_output' ? 'tool' : undefined
      if (role === undefined) continue
      if (role === 'user') sawUser = true
      if (role === 'tool') {
        // Responses 的 function_call_output：{type:'function_call_output', call_id, output}
        const text = typeof item.output === 'string' ? item.output
          : Array.isArray(item.content)
            ? flattenResponsesContent(item.content, images)
            : ''
        messages.push({ role: 'tool', tool_call_id: typeof item.call_id === 'string' ? item.call_id : '', content: text })
        continue
      }
      if (role === 'assistant') {
        // assistant 消息可能带 tool_calls（Responses 形状：function_call 分片）
        if (Array.isArray(item.content)) {
          const text = flattenResponsesContent(item.content.filter((p) => p && (p.type === 'text' || p.type === 'output_text')), images)
          const calls = item.content
            .filter((p) => p && (p.type === 'function_call'))
            .map((p, index) => ({
              id: typeof p.call_id === 'string' ? p.call_id : `call_${index}`,
              type: 'function',
              function: { name: p.name ?? '', arguments: p.arguments ?? '{}' },
            }))
          messages.push({
            role: 'assistant',
            content: text.length > 0 ? text : null,
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          })
        } else {
          messages.push({ role: 'assistant', content: typeof item.content === 'string' ? item.content : '' })
        }
        continue
      }
      // system / developer / user
      const text = typeof item.content === 'string' ? item.content : flattenResponsesContent(item.content, images)
      messages.push({ role: role === 'developer' ? 'system' : role, content: text })
    }
    if (!sawUser && messages.every((m) => m.role !== 'user')) {
      // 整段没有 user 消息也照发（有的客户端用 developer 消息开场）
    }
  } else if (body.input !== undefined) {
    throw new Error('input 必须是字符串或数组')
  } else {
    throw new Error('缺少 input 字段')
  }

  // tools：Responses 的 function 工具形状与 Chat 兼容（{type:'function', function:{...}}）
  // Responses 原生工具是扁平形状 {type:'function', name, parameters}；兼容 chat 双包 {function:{...}}。
  // 统一收敛成 DSH 引擎吃的 {name, description, parameters}（与 protocol.js toToolSchemas 同构）。
  const toolSchemas = (() => {
    if (!Array.isArray(body.tools)) return undefined
    const out = []
    for (const tool of body.tools) {
      if (tool === null || typeof tool !== 'object') continue
      const fn = tool.type === 'function' && tool.function && typeof tool.function === 'object' ? tool.function : tool
      if (typeof fn.name !== 'string' || fn.name.length === 0) continue
      out.push({
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters !== null && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
      })
    }
    return out.length > 0 ? out : undefined
  })()

  // text.format → jsonMode（走 buildMessages 的系统提示约束，和 chat 的
  // response_format 同一条路）。这里曾经自己手写一份等价逻辑、还另外塞了一个
  // responseFormat 进 GenerateOptions —— 而 DSH 整棵依赖树里没有 responseFormat
  // 这个字段（已全树核实），那份下发是纯装饰：约束真正生效靠的就是 jsonMode
  // 拼进 system 这一条路。
  //
  // ⚠ 形状差异：Responses 的 `text.format` 把 name/schema 放在**顶层**
  // （`{type:'json_schema', name, schema, strict}`），Chat 的 `response_format`
  // 把它们包在 `json_schema` 里。直接喂给 parseResponseFormat 会把 json_schema
  // 降级成 json_object（schema 整段丢失），所以先归一化形状。
  const responseFormat = parseResponseFormat(toChatResponseFormat(body.text?.format))

  // reasoning.effort → DSH reasoningEffort 档位。
  // 这里曾经硬编码白名单 low/medium/high，把 xhigh / max / minimal / off 四种
  // 合法档位静默吞掉：客户端传 xhigh 时网关一个字都不说，模型按默认档跑，
  // 用户以为"最高推理已开启"。档位是否存在应该由能力档案判定（各后端词表不同），
  // 校验统一交给下游 resolveReasoningEffort —— 它拿得到该模型的 efforts 列表，
  // 也能在越界时给出 400 + allowed 清单。这里只做类型收窄。
  const reasoningEffort = typeof body.reasoning?.effort === 'string' && body.reasoning.effort.length > 0
    ? body.reasoning.effort
    : undefined

  const dropped = []
  if (body.store !== undefined) dropped.push('store')
  if (body.metadata !== undefined) dropped.push('metadata')
  if (body.parallel_tool_calls !== undefined) dropped.push('parallel_tool_calls')
  if (body.truncation !== undefined) dropped.push('truncation')
  if (body.previous_response_id !== undefined) dropped.push('previous_response_id')
  // top_p 与 tool_choice 在这台机器上没有落地通道：DSH 的 GenerateOptions 既没有
  // topP 也没有 toolChoice（全树 0 命中，两个 adapter 只消费 tools 本身，不消费
  // 调用策略）。早先它们被当成真实字段塞进 options 静默消失，客户端以为生效。
  // 现在如实记进 dropped，由调用方写进 X-Lantern-Dropped-Params。
  if (body.top_p !== undefined) dropped.push('top_p')
  if (body.tool_choice !== undefined) dropped.push('tool_choice')

  // 转成 parseChatRequest 同构形状（buildMessages 只认 system/turns/images/jsonMode）
  const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content ?? '')).filter((s0) => s0.length > 0).join('\n\n') || undefined
  const turns = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') turns.push({ role: 'user', text: String(m.content ?? '') })
    else if (m.role === 'assistant') {
      turns.push({
        role: 'assistant',
        text: String(m.content ?? ''),
        toolCalls: Array.isArray(m.tool_calls) ? m.tool_calls : [],
      })
    } else if (m.role === 'tool') {
      turns.push({ role: 'tool', callId: m.tool_call_id ?? '', text: String(m.content ?? '') })
    }
  }
  // max_output_tokens 与 chat 的 max_tokens 是同一个东西（都映射到 maxTokens）。
  // 这里也必须先判正负：负数流到上游后，有的后端钳掉、有的原样报错，
  // 同一个畸形请求因此表现不一致（chat 通道已在 index.js 里对齐同一条规则）。
  if (body.max_output_tokens !== undefined) {
    if (
      typeof body.max_output_tokens !== 'number'
      || !Number.isSafeInteger(body.max_output_tokens)
      || body.max_output_tokens <= 0
    ) {
      throw new Error('max_output_tokens 必须是正整数')
    }
  }

  return {
    system,
    turns,
    images,
    toolSchemas,
    stream: body.stream === true,
    model: body.model,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxOutputTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    jsonMode: responseFormat,
    reasoningEffort,
    dropped,
    warnings: [],
  }
}

/**
 * 把 DSH 的互斥计数折算成账单口径的输入 token。
 *
 * DSH 的 `inputTokens` 与 `cacheReadTokens` / `cacheWriteTokens` 是**互斥**的
 * （见 protocol.js 里 toOpenAiUsage 的注释：billed input = 三者之和）。
 * chat 与 anthropic 两条通道都求和了，只有 responses 直接把 inputTokens 当
 * prompt_tokens —— 命中前缀缓存的长上下文请求会被系统性少算，命中率越高偏差越大，
 * 面板里的成本报表对这条通道失真。
 *
 * ⚠ 字段名必须与 DSH 的 `TokenUsage` **逐字一致**（第十轮 #106）。
 *
 * 上一版写的是 `usage.cachedInputTokens` —— 这个字段在 DSH 里**不存在**。
 * 已在 asar 里核实（`dsh-llm/lib/typert.host.js` 的 interface 声明）：
 *
 *   export interface TokenUsage {
 *     inputTokens: number
 *     outputTokens: number
 *     totalTokens?: number
 *     cacheReadTokens?: number      ← 缓存命中叫这个
 *     cacheWriteTokens?: number
 *     reasoningTokens?: number
 *   }
 *
 * 两个 adapter 的写入侧也印证了：`cache_read_input_tokens → cacheReadTokens`、
 * `cacheRead → cacheReadTokens`。
 *
 * 后果：`Number(undefined)` 是 `NaN`、`Number.isFinite(NaN)` 为 false，
 * 于是缓存部分被**整块丢掉**。实测同一段 600 KB 输入：chat 报
 * `prompt_tokens=65540`（含 cached 65406），responses 报 `input_tokens=134`，
 * 而同一响应 `total_tokens=76838` —— input+output 与 total 直接对不上。
 *
 * @param usage - DSH usage 块。
 * @returns 计费口径的输入 token 数（无 usage 时 undefined）。
 */
function billedInputOf(usage) {
  if (usage === undefined || usage === null) return undefined
  const base = Number(usage.inputTokens)
  if (!Number.isFinite(base)) return undefined
  const cached = Number(usage.cacheReadTokens)
  const written = Number(usage.cacheWriteTokens)
  return base + (Number.isFinite(cached) ? cached : 0) + (Number.isFinite(written) ? written : 0)
}

/** Responses 形状的 usage（字段名与 Chat 相同，直接透传 OpenAI 口径）。 */
function toResponsesUsage(usage) {
  if (usage === undefined) return undefined
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    input_tokens_details: usage.prompt_tokens_details,
    output_tokens: usage.completion_tokens ?? 0,
    output_tokens_details: usage.completion_tokens_details,
    total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  }
}

/** OpenAI finish_reason → Responses status。 */
function toResponseStatus(finishReason) {
  if (finishReason === 'length') return 'incomplete'
  if (finishReason === 'content_filter') return 'incomplete'
  return 'completed'
}

/**
 * 流式翻译器：DSH StreamChunk → Responses SSE 事件。
 *
 * 事件序列（与 OpenAI 官方 /v1/responses 对齐的子集）：
 *   response.created → response.output_item.added(message)
 *   → response.output_text.delta ×N → response.output_text.done
 *   → response.output_item.done → response.completed / response.failed / response.incomplete
 *
 * 错误处理纪律与 OpenAiStreamTranslator 相同：SSE 状态码已定 200，
 * 上游错误必须显式发 response.failed 事件，绝不把故障伪装成空回答。
 */
export class ResponsesStreamTranslator {
  /**
   * @param options - `{ id, model, sanitize }`。
   */
  constructor({ id, model, sanitize }) {
    this.id = id
    this.model = model
    this.started = false
    this.textDone = false
    this.usage = undefined
    this.finishReason = 'stop'
    this.failure = undefined
    this.sanitize = typeof sanitize === 'function' ? sanitize : undefined
    this.text = ''
    // 推理与工具调用也要累计：终态 response.completed 里的 output 是"这次回答最终长什么样"
    // 的权威快照。只累计 text 会让"只想不说话"或"只调工具"的回答在终态里彻底消失，
    // 客户端据此判断「模型什么都没做」，而增量事件里明明发过 reasoning / function_call。
    this.reasoning = ''
    /** @type {Map<number, {id?:string,name?:string,args:string}>} */
    this.tools = new Map()
  }

  #event(name, data) {
    return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`
  }

  #safeFailure(failure) {
    const raw = { message: failure?.message ?? '上游模型调用失败', code: failure?.code ?? 'upstream_error' }
    const safe = this.sanitize === undefined ? raw : this.sanitize(raw)
    return { message: safe?.message ?? '上游模型调用失败', code: safe?.code ?? 'upstream_error' }
  }

  #created() {
    if (this.started) return []
    this.started = true
    return [
      this.#event('response.created', {
        response: { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: this.model },
      }),
      this.#event('response.output_item.added', {
        output_index: 0,
        item: { type: 'message', id: 'msg_0', role: 'assistant', status: 'in_progress', content: [] },
      }),
    ]
  }

  /**
   * 送入一个 DSH chunk，返回要写出的事件数组。
   * @param chunk - DSH StreamChunk。
   */
  push(chunk) {
    const events = [...this.#created()]
    switch (chunk?.type) {
      case 'text-delta':
        if (chunk.text) {
          this.text += chunk.text
          events.push(this.#event('response.output_text.delta', { item_id: 'msg_0', output_index: 0, content_index: 0, delta: chunk.text }))
        }
        break
      case 'reasoning-delta':
        // Responses 有官方 reasoning 摘要事件；把 DSH 的推理增量映射过去（尽力而为）
        if (chunk.text) {
          this.reasoning += chunk.text
          events.push(this.#event('response.reasoning_summary_text.delta', { item_id: 'rs_0', output_index: 0, summary_index: 0, delta: chunk.text }))
        }
        break
      case 'tool-call-delta': {
        // Responses 的 function_call 增量事件（尽力而为映射；主流客户端主要用非流式聚合）
        const current = this.tools.get(chunk.index ?? 0) ?? { args: '' }
        if (chunk.id !== undefined) current.id = chunk.id
        if (chunk.name !== undefined) current.name = chunk.name
        current.args += chunk.argumentsDelta ?? ''
        this.tools.set(chunk.index ?? 0, current)
        events.push(this.#event('response.function_call_arguments.delta', { item_id: chunk.id ?? 'fc_0', output_index: 0, delta: chunk.argumentsDelta ?? '' }))
        break
      }
      case 'usage':
        this.usage = toResponsesUsage({ prompt_tokens: billedInputOf(chunk.usage), completion_tokens: chunk.usage?.outputTokens, total_tokens: chunk.usage?.totalTokens, prompt_tokens_details: chunk.usage?.cacheReadTokens !== undefined ? { cached_tokens: chunk.usage.cacheReadTokens } : undefined, completion_tokens_details: chunk.usage?.reasoningTokens !== undefined ? { reasoning_tokens: chunk.usage.reasoningTokens } : undefined })
        break
      case 'finish':
        this.finishReason = chunk.reason?.kind === 'max-tokens' ? 'length' : chunk.reason?.kind === 'error' ? 'error' : 'stop'
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        break
      default:
        break
    }
    return events
  }

  /**
   * 结束流：收尾事件（正常 / 失败 / 截断）。
   * @returns 事件数组。
   */
  end() {
    const events = [...this.#created()]
    if (!this.textDone) {
      events.push(this.#event('response.output_text.done', { item_id: 'msg_0', output_index: 0, content_index: 0, text: this.text ?? '' }))
      this.textDone = true
    }
    const status = this.failure !== undefined ? 'failed' : toResponseStatus(this.finishReason)
    // 增量事件里也能拿到正文，但 output_item.done 是"这一项最终长什么样"的权威快照。
    // 用 buildOutputItems 取同一条路径，避免增量与会话快照说法不一致。
    const doneItems = buildOutputItems(this.text ?? '', this.reasoning ?? '', this.tools)
    events.push(this.#event('response.output_item.done', {
      output_index: 0,
      item: doneItems[doneItems.length - 1],
    }))
    const base = {
      id: this.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      // 这里早先写死 `output: []`：流式路径的终态响应体里永远没有正文。
      // 客户端若只读 `response.completed.response`（不用增量事件拼），拿到的就是空回答——
      // 同一句回答在 stream=false 时有内容、stream=true 时没有，属于最容易被当成
      // 「网关坏了」的分叉。与非流式共用 buildOutputItems，两边不再各写一份。
      output: buildOutputItems(this.text ?? '', this.reasoning ?? '', this.tools),
      output_text: this.text ?? '',
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    }
    if (this.failure !== undefined) {
      const safe = this.#safeFailure(this.failure)
      events.push(this.#event('response.failed', { response: { ...base, error: { code: safe.code, message: safe.message } } }))
    } else if (status === 'incomplete') {
      events.push(this.#event('response.incomplete', { response: { ...base, incomplete_details: { reason: 'max_output_tokens' } } }))
    } else {
      // 别在这里再写一次 `output: []`：base 已经带了 buildOutputItems 的结果，
      // 覆盖回空数组正是上一个版本"流式有事件、终态没内容"的根因。
      events.push(this.#event('response.completed', { response: base }))
    }
    return events
  }

  /** 记录累计文本（供 output_text.done 用）。ResponsesStreamTranslator.push 的 text-delta 分支负责累计。 */
  markFailed(failure) {
    this.failure = failure
  }
}

/**
 * 拼 Responses 的 `output` 数组。
 *
 * 流式收尾事件与非流式响应体必须**共用同一份**拼装逻辑：
 * 两处各写一遍的结果是本轮实测到的真实分叉——非流式修好了 `text`，
 * 流式的 `response.completed` 里还挂着 `output: []`，
 * 于是同一句回答在 stream=false 时有内容、stream=true 时是空的。
 *
 * @param text 正文。
 * @param reasoning 推理内容（可空）。
 * @param tools Map<index, {id, name, args}>（可空）。
 * @returns output 数组。
 */
function buildOutputItems(text, reasoning, tools) {
  const output = []
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    output.push({ type: 'reasoning', id: 'rs_0', summary: [{ type: 'summary_text', text: reasoning }] })
  }
  const content = []
  // 有工具调用且没正文时不塞空 output_text：客户端会把它当成"模型说了空白"，
  // 而真实意图是"模型只调工具"。
  if (text.length > 0 || tools.size === 0) {
    content.push({ type: 'output_text', text, annotations: [] })
  }
  output.push({ type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content })
  for (const [, value] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
    output.push({ type: 'function_call', id: value.id ?? 'fc_0', call_id: value.id ?? 'call_0', name: value.name ?? '', arguments: value.args || '{}' })
  }
  return output
}

/**
 * 非流式聚合器：DSH chunk 序列 → Responses 完整响应体。
 */
export class ResponsesAggregator {
  constructor({ id, model }) {
    this.id = id
    this.model = model
    this.text = ''
    this.reasoning = ''
    this.tools = new Map()
    this.usage = undefined
    this.finishReason = 'stop'
    this.failure = undefined
  }

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
        this.usage = {
          prompt_tokens: billedInputOf(chunk.usage) ?? 0,
          completion_tokens: chunk.usage?.outputTokens ?? 0,
          total_tokens: chunk.usage?.totalTokens ?? ((chunk.usage?.inputTokens ?? 0) + (chunk.usage?.outputTokens ?? 0)),
        }
        break
      case 'finish':
        this.finishReason = chunk.reason?.kind === 'max-tokens' ? 'length' : chunk.reason?.kind === 'error' ? 'error' : 'stop'
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        break
      default:
        break
    }
  }

  /**
   * 这次调用有没有产出（文本 / 推理 / 工具调用任一）。
   *
   * ⚠ **推理也算产出**，但 `end()` 会把"只有推理没有正文"的处理做个标记：
   * OpenAI 兼容客户端只读 `content`，高推理档位吃光预算时会看到 `content:null`。
   * 这不是后端故障（换哪个后端都一样会先思考），所以**不能**判成空产出去重试，
   * 只能如实标注。
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

  end() {
    const output = buildOutputItems(this.text, this.reasoning, this.tools)
    const status = this.failure !== undefined ? 'failed' : toResponseStatus(this.finishReason)
    return {
      id: this.id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output,
      // 顶层 output_text：严格说这是 OpenAI SDK 在客户端**算出来的**便利属性，
      // 不是服务端 JSON 字段。但现实里大量客户端（Codex CLI、各种 shell 脚本、
      // 手写 fetch 的调用方）直接读 `body.output_text`。官方服务端也会返回它，
      // 缺了它这些客户端拿到的是 undefined，表现为「调用成功但内容为空」——
      // 而正文其实好端端地躺在 output[].content[].text 里。
      // 多返一个字段没有任何兼容风险，漏返却会让整条通道看起来是坏的。
      output_text: this.text,
      ...(this.usage === undefined ? {} : { usage: toResponsesUsage(this.usage) }),
      ...(this.failure !== undefined ? { error: { code: this.failure.code ?? 'upstream_error', message: this.failure.message ?? '上游模型调用失败' } } : {}),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    }
  }
}
