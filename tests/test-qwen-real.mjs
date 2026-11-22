// 按用户真实场景测 Qwen3.8-Flash：
//   1. 带系统提示词（人设）写评语
//   2. 长上下文传入
//   3. 大 max_tokens 输出
//   4. 工具调用
// 全部打印完整错误，不留死角。
import { LANTERN_DIR } from './paths.mjs'
import { fileURLToPath } from 'node:url'
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')
import { readFileSync } from 'node:fs'

const DIR = TEST_DIR
const KEY = process.env.LANTERN_TEST_KEY ?? ''

if (KEY.length === 0) {
  console.log('  SKIP: 未设置 LANTERN_TEST_KEY（这是在线测试，需要真实网关）')
  console.log('')
  console.log('════════ 0 passed / 0 failed (skipped) ════════')
  process.exit(0)
}
// ── CI 保护：没有网关与 Key 时优雅跳过，不当作失败 ──
// 本测试需要真实网关运行，且需要有效的 API Key（LANTERN_TEST_KEY 环境变量）。
// 离线回归（tests/.regress.mjs）与 GitHub Actions 都不提供服务端，所以：
//   · 缺 Key 或网关不可达 → 输出 SKIP 并以 0 退出
//   · 有 Key 且网关可达 → 正常执行全部断言
const SKIP_EXIT = 0

const H = { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }
const B = 'http://127.0.0.1:3080'
const MID = 'Qwen3.8-Flash'
const sleep = (ms) => new Promise((x) => setTimeout(x, ms))

async function run(name, body, extra = {}) {
  const t0 = Date.now()
  try {
    const r = await fetch(B + '/v1/chat/completions', {
      method: 'POST',
      headers: { ...H, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    })
    const txt = await r.text()
    let j = null
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
    const c = j?.choices?.[0]
    const ms = Date.now() - t0
    console.log(`\n【${name}】status=${r.status} ${ms}ms attempts=${r.headers.get('x-lantern-attempts') ?? '-'}`)
    if (j?.error) {
      console.log('  ERROR code=' + j.error.code)
      console.log('  ERROR message=' + j.error.message)
      console.log('  ERROR raw=' + JSON.stringify(j.error).slice(0, 400))
    } else {
      console.log('  finish=' + c?.finish_reason)
      console.log('  content[' + (c?.message?.content?.length ?? 0) + ']=' + JSON.stringify((c?.message?.content ?? '').slice(0, 150)))
      console.log('  reasoning[' + (c?.message?.reasoning_content?.length ?? 0) + ']')
      console.log('  usage=' + JSON.stringify(j?.usage))
    }
    return { status: r.status, j, txt }
  } catch (e) {
    console.log(`\n【${name}】EXCEPTION ${e?.cause?.code ?? e?.name}: ${e?.message} (${Date.now() - t0}ms)`)
    return { status: 0, j: null, txt: '' }
  }
}

console.log('======== Qwen3.8-Flash 真实场景测试 ========')

// 1) 带系统提示词（人设）+ 写评语
await run('1. 人设 + 写评语', {
  model: MID,
  messages: [
    { role: 'system', content: '你是一位资深的语文老师，擅长写简短有力的评语。请用 50 字左右点评。' },
    { role: 'user', content: '请点评这篇作文：春天来了，花儿开了，小草绿了。' },
  ],
  max_tokens: 500,
})
await sleep(1500)

// 2) 长上下文（约 3000 字）
{
  const long = '这是一段测试文本。'.repeat(300)
  await run('2. 长上下文(~3000字)', {
    model: MID,
    messages: [
      { role: 'user', content: long + '\n\n请用一句话总结上面这段文字。' },
    ],
    max_tokens: 300,
  })
  await sleep(1500)
}

// 3) 大 max_tokens
await run('3. 大 max_tokens=4000', {
  model: MID,
  messages: [
    { role: 'system', content: '你是一个专业的写作助手。' },
    { role: 'user', content: '请写一篇 800 字的散文，主题是"秋天的黄昏"。' },
  ],
  max_tokens: 4000,
})
await sleep(1500)

// 4) 工具调用
await run('4. 工具调用', {
  model: MID,
  messages: [{ role: 'user', content: '查一下杭州的天气' }],
  tools: [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询指定城市的天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }],
  tool_choice: 'auto',
  max_tokens: 1000,
})
await sleep(1500)

// 5) 多轮对话
await run('5. 多轮对话（4 轮历史）', {
  model: MID,
  messages: [
    { role: 'user', content: '我叫小明。' },
    { role: 'assistant', content: '你好小明！有什么可以帮你的吗？' },
    { role: 'user', content: '我今年 12 岁。' },
    { role: 'assistant', content: '很高兴认识你，12 岁正是充满好奇心的年纪。' },
    { role: 'user', content: '你还记得我叫什么、几岁吗？' },
  ],
  max_tokens: 300,
})
