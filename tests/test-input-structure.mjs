#!/usr/bin/env node
/**
 * 入参结构校验单测。
 *
 * 背景（真实缺陷）：`messages: []` / `messages: 42` / `messages` 缺省 全部被放行，
 * 上游回 `200 { content: null }`。客户端把它当成"模型无话可说"记进上下文，
 * 比报错更糟。Anthropic 通道早就挡住了，chat / responses 是遗漏。
 *
 * 这里验三件事：
 *   1. 校验器本身对每种畸形都给得出理由（且理由是给**调用方**看的）
 *   2. 三条通道的**判定口径一致**（同一个畸形在三处都是 400，不是一处 400 一处 200）
 *   3. 合法请求一个都不能误伤（宽容度不能被这次收紧破坏）
 */
import { validateChatRequest, validateResponsesRequest } from '../lib/protocol.js'
import { validateAnthropicRequest } from '../lib/anthropic.js'

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) {
    pass += 1
    console.log('  ✓ ' + name)
  } else {
    fail += 1
    console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra))
  }
}

const ok = (v) => v === undefined
const no = (v) => typeof v === 'string' && v.length > 0

console.log('\n【U1 chat：必须挡住的结构性问题】')
{
  check('U1a 缺 messages', no(validateChatRequest({ model: 'm' })), validateChatRequest({ model: 'm' }))
  check('U1b messages 非数组', no(validateChatRequest({ model: 'm', messages: 'x' })))
  check('U1c messages=数字', no(validateChatRequest({ model: 'm', messages: 42 })))
  check('U1d messages=null', no(validateChatRequest({ model: 'm', messages: null })))
  check('U1e messages=[]', no(validateChatRequest({ model: 'm', messages: [] })), validateChatRequest({ model: 'm', messages: [] }))
  check('U1f messages=[null]', no(validateChatRequest({ model: 'm', messages: [null] })))
  check('U1g messages=[{}]', no(validateChatRequest({ model: 'm', messages: [{}] })))
  check('U1h messages=[{role:1}]', no(validateChatRequest({ model: 'm', messages: [{ role: 1 }] })))
  check('U1i messages=[{role:""}]', no(validateChatRequest({ model: 'm', messages: [{ role: '' }] })))
  check('U1j content=数字', no(validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 42 }] })), validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 42 }] }))
  check('U1k content=布尔', no(validateChatRequest({ model: 'm', messages: [{ role: 'user', content: true }] })))
  check('U1l 缺 model', no(validateChatRequest({ messages: [{ role: 'user', content: 'x' }] })))
  check('U1m model=空串', no(validateChatRequest({ model: '', messages: [{ role: 'user', content: 'x' }] })))
  check('U1n model=纯空格', no(validateChatRequest({ model: '   ', messages: [{ role: 'user', content: 'x' }] })))
  check('U1o body=null', no(validateChatRequest(null)))
  check('U1p body=数组', no(validateChatRequest([])))
  check('U1q body=字符串', no(validateChatRequest('x')))
  // 错误里的下标要指向真正出错的那条，而不是笼统说"messages 有问题"
  const idx = validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'ok' }, { role: 'user', content: 1 }] })
  check('U1r 报错指向出错的下标', typeof idx === 'string' && idx.includes('[1]'), idx)
}

console.log('\n【U2 chat：合法请求一条都不能误伤】')
{
  const good = [
    [{ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, '最简'],
    [{ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] }, '带 system'],
    [{ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, '分片 content'],
    [{ model: 'm', messages: [{ role: 'assistant', content: null, tool_calls: [] }] }, 'assistant content=null（OpenAI 正规形状）'],
    [{ model: 'm', messages: [{ role: 'user', content: '' }] }, 'content 空串（用户发了个空消息，不是结构错）'],
    [{ model: 'm', messages: [{ role: 'tool', content: 'r', tool_call_id: 'c1' }] }, 'tool 消息'],
    [{ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [], temperature: 0.5 }, '带可选字段'],
    [{ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 100 }, '带 max_tokens'],
    [{ model: '  m  ', messages: [{ role: 'user', content: 'x' }] }, 'model 带空格（trim 后合法）'],
  ]
  for (const [body, name] of good) check('U2 ' + name, ok(validateChatRequest(body)), String(validateChatRequest(body)))
}

console.log('\n【U3 responses：与 chat 同口径】')
{
  check('U3a 缺 input', no(validateResponsesRequest({ model: 'm' })))
  check('U3b input=null', no(validateResponsesRequest({ model: 'm', input: null })))
  check('U3c input=[]', no(validateResponsesRequest({ model: 'm', input: [] })), validateResponsesRequest({ model: 'm', input: [] }))
  check('U3d input=数字', no(validateResponsesRequest({ model: 'm', input: 42 })))
  check('U3e 缺 model', no(validateResponsesRequest({ input: 'x' })))
  check('U3f input=字符串（合法）', ok(validateResponsesRequest({ model: 'm', input: 'x' })))
  check('U3g input=[消息]（合法）', ok(validateResponsesRequest({ model: 'm', input: [{ role: 'user', content: 'x' }] })))
  check('U3h 只有 instructions 没 input（不合法：没人说话）', no(validateResponsesRequest({ model: 'm', instructions: 'be nice' })))
}

console.log('\n【U4 anthropic：早就挡着，这次确认没被改坏】')
{
  check('U4a 缺 messages', no(validateAnthropicRequest({ model: 'm' })))
  check('U4b messages=[]', no(validateAnthropicRequest({ model: 'm', messages: [] })))
  check('U4c 缺 model', no(validateAnthropicRequest({ messages: [{ role: 'user', content: 'x' }] })))
  check('U4d 合法', ok(validateAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 })))
  check('U4e max_tokens=0', no(validateAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 0 })))
}

console.log('\n【U5 三通道口径一致：同一个畸形在三处都被拒】')
{
  // 空内容这种"看起来像请求、其实没人说话"的形态，三条通道必须都拒。
  const chatEmpty = validateChatRequest({ model: 'm', messages: [] })
  const respEmpty = validateResponsesRequest({ model: 'm', input: [] })
  const antEmpty = validateAnthropicRequest({ model: 'm', messages: [] })
  check('U5a 三通道都拒绝空内容', no(chatEmpty) && no(respEmpty) && no(antEmpty))
  // 缺 model
  const c = validateChatRequest({ messages: [{ role: 'user', content: 'x' }] })
  const r = validateResponsesRequest({ input: 'x' })
  const a = validateAnthropicRequest({ messages: [{ role: 'user', content: 'x' }] })
  check('U5b 三通道都拒绝缺 model', no(c) && no(r) && no(a))
  check('U5c 三处错误文案都提到 model', [c, r, a].every((m) => typeof m === 'string' && m.includes('model')), [c, r, a].join(' | '))
}

console.log('\n【U6 错误文案是给调用方看的】')
{
  const msgs = [
    validateChatRequest({ model: 'm', messages: [] }),
    validateResponsesRequest({ model: 'm', input: [] }),
    // 注意：`{role:'x'}` 是**合法**的——role 只要是字符串就放行，未知角色由解析层
    // 宽容忽略。要造真正被挡的，得用空 role。
    validateChatRequest({ model: 'm', messages: [{ role: '', content: 'x' }] }),
  ]
  // 不能出现内部实现词汇（函数名、栈痕迹）
  const banned = ['undefined', 'null is', 'TypeError', 'Cannot read', 'stack']
  // 注意：第三条断言的是 content 缺失而不是 role=未知——
  // role='x' 是**合法字符串**，解析层会把它当未知角色忽略（宽容），
  // 结构校验只管"role 得是字符串"。所以这里用 content=42 造一个真正越界的。
  const overflow = validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 42 }] })
  const all = [...msgs, overflow]
  for (const [i, m] of all.entries()) {
    check('U6' + i + ' 文案不含内部痕迹', typeof m === 'string' && banned.every((b) => !m.includes(b)), m)
  }
  check('U6d 空 messages 的文案说清"至少 1 条"', msgs[0].includes('1 条'), msgs[0])
  check('U6e 空 input 的文案说清"至少 1 条"', msgs[1].includes('1 条'), msgs[1])
  check('U6f content 类型错的文案点出下标与类型', overflow.includes('[0]') && overflow.includes('content'), overflow)
}

console.log('\n' + (fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `FAILED: ${pass} passed, ${fail} failed`))
process.exit(fail === 0 ? 0 : 1)
