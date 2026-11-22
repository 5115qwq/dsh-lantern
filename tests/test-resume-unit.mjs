// 提取 streamWithFailover 源码做隔离单测（逻辑复刻验证，不 import index.js 本体）
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'
// dsh-llm 打在 app.asar 内部，node 无法直接 import；
// 这两个工厂只是构造消息对象，这里用最小等价实现代替（字段形状与官方一致）。
const createAssistantMessage = (input) => ({ role: 'assistant', content: input?.content ?? [], ...(input ?? {}) })
const createUserMessage = (input) => ({ role: 'user', content: input?.content ?? [], ...(input ?? {}) })

const src = readFileSync(`${LANTERN_DIR}/lib/index.js`, 'utf8')
const start = src.indexOf('async function* streamWithFailover')
// 函数体到下一个顶级 function
const end = src.indexOf('\nfunction ', start + 100)
let fnSrc = src.slice(start, end)
// 依赖打桩：
const maskSecrets = (x) => x
const resolveTune = (t) => t ?? {}
const isSubstantiveChunk = (c) => c?.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0
const isRetryableFailure = () => false
const linkSignals = (outer) => ({ signal: outer ?? {}, abort() {}, dispose() {} })
const PLUGIN_ID = 'dsh-lantern'
// 求值成函数
const factory = new Function('maskSecrets','resolveTune','isSubstantiveChunk','isRetryableFailure','linkSignals','PLUGIN_ID','createAssistantMessage','createUserMessage',
  fnSrc + '\nreturn streamWithFailover')
const streamWithFailover = factory(maskSecrets, resolveTune, isSubstantiveChunk, isRetryableFailure, linkSignals, PLUGIN_ID, createAssistantMessage, createUserMessage)

// ── 场景1：第一后端半截断流，第二后端续写 ──
function makeStream(parts) {
  let i = 0
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of parts) {
        if (p.throw) throw Object.assign(new Error(p.throw), p.extra ?? {})
        else if (p.finishError) yield { type: 'finish', reason: { kind: 'error', failure: { message: p.finishError, code: 'upstream_error' } } }
        else yield p
      }
    }
  }
}
const sctx1 = { llm: { stream: (opts) => {
  // 记录收到的 messages 供断言
  calls.push(opts.messages)
  if (opts.provider === 'p1') return makeStream([{ type: 'text-delta', text: '前半段' }, { throw: 'boom mid-stream' }])
  return makeStream([{ type: 'text-delta', text: '后半段' }, { type: 'finish', reason: { kind: 'stop' } }])
} } }
const calls = []
const plans = [
  { binding: 'b1', provider: 'p1', model: 'm1' },
  { binding: 'b2', provider: 'p2', model: 'm2' },
]
const state = {}
const baseOptions = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
const chunks = []
let fo = { attempts: [] }
try {
  for await (const c of streamWithFailover(sctx1, { log: () => {} }, plans, baseOptions, fo, { timeoutMs: 0, retries: 0 })) chunks.push(c)
  console.log('S1 chunks:', JSON.stringify(chunks))
  console.log('S1 fo:', JSON.stringify({ resumed: fo.resumed, plan: fo.plan?.binding, failure: fo.failure }))
  console.log('S1 call2 messages:', JSON.stringify(calls[1]?.map(m => ({ role: m.role, texts: (m.content ?? []).filter(c => c.type === 'text').map(c => c.text.slice(0, 20)) })), null, 1))
} catch (e) {
  console.log('S1 THREW:', e.message, 'lanternCommittedFailure=', e.lanternCommittedFailure)
}
console.log('S1 attempts:', JSON.stringify(fo.attempts?.map(a => ({ b: a.binding, ok: a.ok, committed: a.committed, err: a.error?.slice(0, 30) }))))

// ── 场景2：错误 finish 帧断流（不是 throw）──
const calls2 = []
const sctx2 = { llm: { stream: (opts) => {
  calls2.push(opts.messages)
  if (opts.provider === 'p1') return makeStream([{ type: 'text-delta', text: 'AA' }, { finishError: 'upstream dropped' }])
  return makeStream([{ type: 'text-delta', text: 'BB' }, { type: 'finish', reason: { kind: 'stop' } }])
} } }
const chunks2 = []
let fo2 = { attempts: [] }
try {
  for await (const c of streamWithFailover(sctx2, { log: () => {} }, plans, baseOptions, fo2, { timeoutMs: 0, retries: 0 })) chunks2.push(c)
  console.log('S2 chunks:', JSON.stringify(chunks2), 'fo2:', JSON.stringify({ resumed: fo2.resumed, plan: fo2.plan?.binding }))
} catch (e) { console.log('S2 THREW:', e.message) }

// ── 场景3：无处续写（单 plan）→ 保持旧语义 throw ──
const sctx3 = { llm: { stream: () => makeStream([{ type: 'text-delta', text: 'X' }, { throw: 'boom' }]) } }
let fo3 = { attempts: [] }
try {
  for await (const c of streamWithFailover(sctx3, { log: () => {} }, [plans[0]], baseOptions, fo3, { timeoutMs: 0, retries: 0 })) console.log('S3 chunk', c)
  console.log('S3 NO THROW — BAD')
} catch (e) {
  console.log('S3 threw as expected:', e.message, 'committedFailure flag =', e.lanternCommittedFailure, 'fo3.failure =', JSON.stringify(fo3.failure))
}

// ── 场景4：正常流（无断流）不受影响 ──
const chunks4 = []
let fo4 = { attempts: [] }
const sctx4 = { llm: { stream: () => makeStream([{ type: 'text-delta', text: 'hello' }, { type: 'finish', reason: { kind: 'stop' } }]) } }
for await (const c of streamWithFailover(sctx4, { log: () => {} }, [plans[0]], baseOptions, fo4, { timeoutMs: 0, retries: 0 })) chunks4.push(c)
console.log('S4 normal:', JSON.stringify(chunks4), 'fo4.resumed =', fo4.resumed, 'fo4.plan?.binding =', fo4.plan?.binding)
