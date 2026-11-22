/**
 * dsh-lantern — 消息构造（Host 半部内部模块）。
 *
 * 把协议层解析出的纯数据，用 DSH 官方工厂函数实例化为 `Message[]`。
 *
 * 为什么用官方工厂而不是手写对象：`Message` 带 brand 类型与冻结语义
 * （`createUserMessage` / `createAssistantMessage` / `createSystemMessage` /
 * `createToolResultMessage`），手写对象会在装配或后续处理中出问题。
 *
 * 图片：`ImageBlock.attachment` 必须是本机 attachments 服务可解析的 durable ref，
 * 因此必须走 `ctx.attachments.saveImages()`（设计文档 §7.5.1b）。
 *
 * @module dsh-lantern/messages
 */
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { parseDataUrl, renderJsonModeInstruction, renderToolChoiceInstruction } from './protocol.js'

/** 系统提示的归属插件名（用于 source 标记）。 */
const PLUGIN_ID = 'dsh-lantern'

/**
 * 把协议层解析出的 turns 转成 DSH Message[]。
 *
 * @param parsed - `parseChatRequest()` 的返回值。
 * @param attachments - 可选的 attachments 服务（用于图片落引用）。
 * @param options - `{ allowImage, ledger }`：
 *   `allowImage` 是网关开关（§7.5 档 A/B）；
 *   `ledger` 是附件账本（P8）——**传入时图片经账本写入**，从而能被安全回收；
 *   不传则退回直接 `saveImages()`（无回收，仅用于无账本场景）。
 * @returns `{ messages, imageRefs, warnings, degraded }`。
 */
export async function buildMessages(parsed, attachments, options = {}) {
  const { allowImage = false, ledger } = options
  const warnings = [...(parsed.warnings ?? [])]
  const imageRefs = []
  let degraded = false

  const messages = []

  // 1) system：DSH 用独立的系统消息承载
  //
  // `response_format` 在这里**落地为系统提示约束**（见 protocol.js 的说明）：
  // DSH 的 GenerateOptions 没有该字段，收下不透传就是静默忽略。
  // 所以把"必须输出 JSON / 符合这个 schema"写成给模型的指令，
  // 与用户的 system 合并成同一条消息（分成两条会让模型分不清优先级）。
  const jsonInstruction = renderJsonModeInstruction(parsed.jsonMode)
  // `tool_choice` 落地为系统提示约束（第十一轮 #120）。
  //
  // DSH 的 GenerateOptions 里确实没有 toolChoice 字段（第七轮全树核实过），
  // 所以原来它被丢进 Dropped-Params —— "诚实"，但代价很大：
  //   · 客户端传 `required`（强制调工具）→ 模型爱调不调；
  //   · 传 `{function:{name:'x'}}`（指定工具）→ 模型可能去调别的；
  //   · 传 `none`（禁止调工具）→ 模型照样可能吐 tool_calls。
  //
  // 用户的反馈正是这个："感觉有很多限制、完全不像模型原有的效果"。
  // agent 框架很多靠 `required` 逼模型走工具链，一旦不生效，表现就是
  // "模型变笨了、只会纯文本"。
  //
  // 折中：**用 system 指令近似**（与 jsonMode 同一套机制，已有先例）。
  // 不精确 —— 它是"强烈要求"而不是协议级约束 —— 但比静默丢弃强得多。
  // 同时在响应头里仍然如实标 `tool_choice=soft`（见 index.js），
  // 让客户端知道这是软约束、必要时自行重试。
  const toolChoiceInstruction = renderToolChoiceInstruction(parsed.toolChoice, parsed.toolSchemas)
  const systemParts = []
  if (typeof parsed.system === 'string' && parsed.system.length > 0) systemParts.push(parsed.system)
  if (jsonInstruction !== undefined) systemParts.push(jsonInstruction)
  if (toolChoiceInstruction !== undefined) systemParts.push(toolChoiceInstruction)

  // ── system 降级：合并进第一条 user 消息（第十四轮 #155）──
  //
  // 实测 `hy4`：只要有**非空 system**，上游就在 ~100ms 内返回空
  // （正文、推理、工具全空），5 次重试全空；把 system 去掉/留空则完全正常。
  // 探针数据：
  //   有 system + 评语  → 92ms   empty_completion
  //   无 system + 评语  → 10.2s  正常 43 字
  //   有 system + "你好" → 210ms  empty_completion
  //   空 system         → 3.0s   正常 18 字
  //
  // 这说明该上游的模板不接受独立的 system role。网关无法改变上游，
  // 但可以**换一种表达方式**：把 system 文本拼到第一条 user 消息前面。
  // 语义上弱一点（不再是"系统级"约束），但比"直接给用户一个空回答"强得多。
  //
  // 由调用方在**检测到空回答后**用 `mergeSystemIntoUser: true` 再试一次，
  // 默认 false —— 不能默认降级，那会让所有模型的 system 语义都变弱。
  const mergeSystem = options.mergeSystemIntoUser === true
  let mergedSystemPrefix
  if (systemParts.length > 0) {
    if (mergeSystem) {
      mergedSystemPrefix = systemParts.join('\n\n')
    } else {
      // ── #230：system 的两个坑，都在这一行上 ──
      //
      // 用户实测「性能测试」报 `content.some is not a function`。
      //
      // 排查结论：
      //   1. **content 就应该是字符串** —— DSH 内核自己全是
      //      `createSystemMessage(rendered)` / `createSystemMessage(text)`
      //      单参数调用（见 app.asar 里 @deepseek-ai/dsh-agent-loop 的用法）。
      //      我一度以为是"必须传内容块数组"，那是错的：内核的
      //      `createSystemMessage` 收的就是 string。
      //   2. **第二个参数（provider）不该乱传** —— dsh-llm 的 stub 签名是
      //      `createSystemMessage(t, p) => { content: t, provider: p }`，
      //      这里原来传的是 `PLUGIN_ID`（'dsh-lantern'），那是一个**不存在的
      //      provider id**。内核组装请求时会按 message.provider 找归属，
      //      找不到就可能把 content 变成 undefined，随后 `.some()` 直接 TypeError。
      //
      // 所以：只传 content，把 provider 交给内核自己决定（与内核自身用法一致）。
      messages.push(createSystemMessage(systemParts.join('\n\n')))
    }
  }
  void mergedSystemPrefix // 在 user 分支里使用（见下）

  // 2) 图片：先统一落成本机 durable 引用（一次批量提交，失败不留半截）
  /** @type {Map<string, object>} dataUrl -> attachment ref */
  const imageCache = new Map()
  if (parsed.images.length > 0) {
    if (!allowImage) {
      // 档 A：明确拒绝而不是静默丢弃（§6.5.1 铁律 3）
      throw Object.assign(new Error('网关未开启图片输入（allowImageInput: false）'), {
        lanternCode: 'image_not_allowed',
      })
    }
    if (attachments === undefined) {
      throw Object.assign(new Error('本机附件服务不可用，无法处理图片输入'), {
        lanternCode: 'attachments_unavailable',
      })
    }
    const pending = []
    for (const url of parsed.images) {
      if (imageCache.has(url)) continue
      const decoded = parseDataUrl(url)
      if (decoded === undefined) {
        warnings.push('忽略了不受支持的图片格式（仅支持 data:image/png|jpeg|webp|gif;base64）')
        degraded = true
        continue
      }
      pending.push({ url, decoded })
    }
    if (pending.length > 0) {
      const payload = pending.map((p) => ({ data: p.decoded.data, mediaType: p.decoded.mediaType }))
      // P8：优先走账本（区分新建/复用，只回收自己新建的）
      const refs = ledger !== undefined ? await ledger.save(payload) : await attachments.saveImages(payload)
      for (const [index, item] of pending.entries()) {
        const ref = refs[index]
        if (ref === undefined) continue
        imageCache.set(item.url, ref)
        imageRefs.push(ref)
      }
    }
  }

  // 3) 逐轮构造
  //
  // callId → 工具名 映射：`tool` 轮只有 callId，但 #183 的文本回述形态
  // 需要工具名（"我调用了 get_weather，返回…"）。名称来自前面的 assistant 轮。
  const callNameById = new Map()
  for (const turn of parsed.turns) {
    for (const call of turn?.toolCalls ?? []) {
      if (typeof call?.id === 'string' && typeof call?.name === 'string') {
        callNameById.set(call.id, call.name)
      }
    }
  }

  for (const turn of parsed.turns) {
    if (turn.role === 'user') {
      const content = []
      // system 降级模式（#155）：把 system 文本拼到**第一条** user 消息前面，
      // 用完即清空，后续 user 轮不再重复。
      let text = turn.text
      if (mergedSystemPrefix !== undefined) {
        text = text.length > 0 ? mergedSystemPrefix + '\n\n' + text : mergedSystemPrefix
        mergedSystemPrefix = undefined
      }
      if (text.length > 0) content.push({ type: 'text', text })
      // 用户消息携带图片（本插件把图片挂在当轮 user 消息上）
      for (const url of parsed.images) {
        const ref = imageCache.get(url)
        if (ref !== undefined) content.push({ type: 'image', attachment: ref })
      }
      // #177 回滚：`createUserMessage(input)` 接收**对象** `{ content: [...] }`，
      // 不是数组。上一轮改成数组导致 `content is not iterable`。
      // 正确的消息形状由内核 `createUserMessage({ content, source? })` 定义。
      messages.push(createUserMessage({ content }))
      // 图片只挂第一轮，避免重复注入（协议层未区分轮次，保守处理）
      parsed.images.length = 0
      continue
    }

    // ⚠ 兜底：请求里**一条 user 消息都没有**时（纯 assistant 续写、
    // assistant→tool 续跑），上面的 user 分支一个都不会进，parsed.images 里的
    // 图片一张都挂不到任何消息上——但 imageRefs 已经登记进账本、degraded 仍是
    // false，表现为"图静默丢了，账本却记着用了图"。
    // 这里在遇到第一条非 user 轮时先造一条只带图片的 user 消息，把它挂上去。
    if (parsed.images.length > 0) {
      const loneContent = parsed.images
        .map((url) => imageCache.get(url))
        .filter((ref) => ref !== undefined)
        .map((ref) => ({ type: 'image', attachment: ref }))
      // #177 回滚：对象形状（见上）
      if (loneContent.length > 0) messages.push(createUserMessage({ content: loneContent }))
      parsed.images.length = 0
    }

    if (turn.role === 'assistant') {
      const content = []
      if (turn.text.length > 0) content.push({ type: 'text', text: turn.text })
      for (const call of turn.toolCalls ?? []) {
        content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })
      }
      messages.push(
        createAssistantMessage({
          content,
          source: { kind: 'model', provider: PLUGIN_ID, model: 'lantern' },
        }),
      )
      continue
    }

    if (turn.role === 'tool') {
      // ── 工具结果的两种形态（第十七轮 #183）──
      //
      // 标准形态是 `role:'tool'` 消息（配 `toolCallId`）。但**部分中转上游
      // 根本不接受 role:'tool'**：实测 `Qwen-3.8-Flash` / `GPT-6-Luna`
      // 在拿到工具结果后**一律返回空**（`empty_completion`），三种改法都试过：
      //
      //   role:'tool' 标准形状          → 空 ❌
      //   assistant 带 content 说明     → 空 ❌
      //   把结果写成普通 user 文本        → 「杭州天气多云，气温22℃。」✅
      //
      // 所以 `toolResultAsText: true` 时改用**文本回述**形态：
      // 助手说明"我调用了 X，得到 Y"，再用一条 user 轮请它据此作答。
      // 语义弱一点（不再走协议级工具回传），但比返回空回答强得多。
      if (options.toolResultAsText === true) {
        // callId → 工具名 的映射来自前面的 assistant 轮（它的 toolCalls 里带 name）。
        // 拿不到就退回 'tool'，只是措辞略含糊，不影响功能。
        const callName = callNameById.get(turn.callId) ?? 'tool'
        messages.push(
          createAssistantMessage({
            content: [{
              type: 'text',
              text: `我调用了工具 ${callName}，返回结果：${turn.text}`,
            }],
            source: { kind: 'model', provider: PLUGIN_ID, model: 'lantern' },
          }),
        )
        messages.push(
          createUserMessage({
            content: [{ type: 'text', text: '根据上面的工具返回结果，请直接回答我最初的问题。' }],
          }),
        )
      } else {
        // ── #187 死循环的真正根因：工具结果对不上工具调用 ──
        //
        // `createToolResultMessage({ callId })` 在不同版本的内核里产出的字段名不同：
        //   · 实测运行时产出 `{ role:'tool', callId:'c1' }`      ← 没有 toolCallId
        //   · 而 pi-ai 的 toolResultOf() 读的是 `message.toolCallId`
        //   · DSH asar 里的源码也写的是 `toolCallId: input.callId`
        //
        // 于是 `toolNames.get(undefined)` → `toolName = 'unknown'`，
        // 上游收到的是一条**无法归属**的工具结果，直接被丢弃。
        //
        // 模型侧表现（实测，决定性证据）：
        //   历史里有 {role:'tool', content:'唯一结果：react 18.2.0'}
        //   问它"刚才工具返回了什么？"
        //   它答：**「刚才没有调用任何工具，因此没有工具返回内容可以复述」**
        //
        // 模型根本看不到工具结果 → 以为工具没执行 → **无限重试 → 死循环**
        // （用户截图：`已搜索 7 次文件` → `17 次` → `11 次`，永远打转）
        //
        // 修法：在产出的消息上**补齐 `toolCallId`**（保留原有字段，不动内核给的东西）。
        // 两个字段都写，无论内核/适配器读哪个都能拿到。
        const toolMsg = createToolResultMessage({
          callId: turn.callId,
          content: [{ type: 'text', text: turn.text }],
          isError: false,
        })
        messages.push(
          toolMsg.toolCallId === undefined
            ? { ...toolMsg, toolCallId: turn.callId, callId: turn.callId }
            : toolMsg,
        )
      }
    }
  }

  // ── 兜底：merge 模式下请求里**一条 user 轮都没有**（纯 assistant 续写、
  // assistant→tool 续跑），上面的 user 分支一个都不进，`mergedSystemPrefix`
  // 从头到尾没被消费 —— system 文本就这么**静默丢了**。
  //
  // 这与本插件铁律"降级永远可见"正面冲突：模型看到的内容比用户以为的少，
  // 而 `warnings` / `degraded` 一声不吭，表现就是"模型不听话了"。
  // （实测：merge=true + 只有 assistant 轮 → 消息里彻底没有 system 文本。）
  //
  // 处理方式与上面"只带图片的孤立 user 轮"一致：在**最前面**插一条只含
  // system 文本的 user 消息。位置放最前而不是最后，是为了保持
  // "system 语义在会话开头"的原始意图。
  if (mergedSystemPrefix !== undefined) {
    // #177 回滚：对象形状（见上）
    messages.unshift(
      createUserMessage({ content: [{ type: 'text', text: mergedSystemPrefix }] }),
    )
    mergedSystemPrefix = undefined
  }

  // ── 从历史重建工具定义（第十二轮 #140）──
  //
  // ⚠ 这是"工具引用有问题"的**真正根因**，之前两轮都没修到点子上。
  //
  // 事实：本函数原来只返回 `{ messages, imageRefs, warnings, degraded }`，
  // **从来没有 `tools` 字段**。而 index.js 的 `mergeToolSchemas(built, parsed)`
  // 一直在读 `built.tools` —— 读一个永远不存在的属性，于是：
  //   · 客户端只在第一轮发 `tools`、续轮不发（绝大多数 agent 框架都这样）；
  //   · 第二轮起 `parsed.toolSchemas` 是空，`built.tools` 也是空；
  //   · 合并结果 undefined → 根本不下发 tools 字段；
  //   · 模型看到的是"这个会话没有任何工具可用"，于是答"我没有天气工具"。
  //
  // 实测（修复前）：续轮请求里带完整 tool_calls + tool 结果，模型回
  //   "抱歉，我目前没有可用的天气查询工具（当前会话未提供任何天气类函数/工具接口）"。
  //
  // 现在：从历史里的 `toolCalls` 收集**出现过的工具名**，生成最小可用 schema。
  //
  // ── 边界：只有一个例外（第十六轮 #170，已回滚收紧条件）──
  //
  // 收紧成"必须显式声明要工具"是**错的**，它把 DSH 自己打挂了：
  //   · DSH 的 agent 循环续轮时**不重复发 tools**（内部自己管理），
  //     历史里有 `tool_calls` 与 `tool` 结果；
  //   · 收紧后网关不下发 tools → 模型看到"要我处理工具结果，但没有工具定义"
  //     → 返回 200 + 空正文；
  //   · 客户端侧报 `EMPTY_RESPONSE: returned a completed response with no content`，
  //     整轮对话中断（实测：手机端连续 3 次失败、重试到 2/5）。
  //
  // 所以恢复原本的"无条件重建"，只保留一个真正安全的例外：
  // **客户端显式 `tool_choice: 'none'`** —— 那是明确的"别调工具"，
  // 此时重建 tools 才是害它。
  //
  // 之前观察到的"deepseek/Seed 第 2 轮又返回 tool_calls"不是网关 bug：
  // 模型在拿到工具结果后仍想再查一次，是它自己的决策；真实 agent 框架
  // 会继续循环或在合适时机改用 `tool_choice:'none'` 收手。
  const declaredNoTools = parsed.toolChoice === 'none'
  const seenToolNames = new Set()
  const rebuiltTools = []
  // ── #187：`tool_choice:'none'` 也不能丢掉 tools 定义 ──
  //
  // 原来这里 `if (!declaredNoTools)` 会在客户端说"别调工具"时**完全不下发 tools**。
  // 但历史上已经有 `tool-call` 块和 `role:'tool'` 结果 —— kernel 的
  // `toolResultOf()` 要靠 `toolNames.get(toolCallId)` 填 `toolName`，
  // 而 `toolNames` 是从**本轮的 tools 定义**构建的。
  //
  // 没有 tools → `toolName='unknown'` → 上游把工具结果当成无法识别的消息丢掉。
  // 这与 #170 那次把 DSH 打挂的教训一致：**不要因为"客户端没要工具"就不给工具定义**。
  //
  // 现在的规则：
  //   · 历史里没有工具调用 → 不下发（干净的纯文本会话，别凭空塞 tools）
  //   · 历史里有工具调用 → 一律下发最小定义（让工具结果能被正确归属）
  //     `tool_choice:'none'` 的"别调工具"由 system 指令表达（renderToolChoiceInstruction）
  for (const turn of parsed.turns ?? []) {
    for (const call of turn?.toolCalls ?? []) {
      const name = typeof call?.name === 'string' ? call.name.trim() : ''
      if (name.length === 0 || seenToolNames.has(name)) continue
      seenToolNames.add(name)
      rebuiltTools.push({
        name,
        // 描述留空：历史里没有描述，编一个反而可能误导模型
        description: '',
        // ── parameters 必须是**可接受任意参数**的宽松 schema（#187）──
        //
        // 原来 `properties: {}` + `additionalProperties: true` 理论上允许任意字段，
        // 但部分中转上游看到空的 `properties` 会判定"这个工具不接受参数"，
        // 于是模型按历史重放调用时参数被清空 → 工具执行失败 → 模型重试 → 死循环。
        //
        // 这里显式声明一个占位属性并放开 additionalProperties，
        // 让任何参数名都能通过校验。历史里的真实参数在 `arguments` 里，不受影响。
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: true,
          // 注意：**不能**写 required: []，那会变成"所有参数都可选"，
          // 有些上游会因此拒绝带参数的调用。
        },
      })
    }
  }
  void declaredNoTools

  return {
    messages,
    imageRefs,
    warnings,
    degraded,
    // 只有真的从历史里找到工具时才挂这个字段；否则保持 undefined，
    // 让 mergeToolSchemas 走"本轮声明优先"的原路径。
    ...(rebuiltTools.length > 0 ? { tools: rebuiltTools } : {}),
  }
}

/**
 * 把 DSH 的事件级错误映射为对客户端友好的信息，并**先脱敏**。
 *
 * 脱敏红线（设计文档 §6.5.10-b）：上游错误可能回显 key / 邮箱 / 端点，
 * 原文照显前必须掩码。这里做的是"不改语义、只掩码"。
 *
 * @param message - 原始错误消息。
 * @returns 脱敏后的消息。
 */
export function maskSecrets(message) {
  return String(message ?? '')
    .replace(/\b(sk|npm|ghp|xoxb|glm|hf)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***')
}
