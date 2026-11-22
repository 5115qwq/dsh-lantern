// 验证流式 tool_calls 的 delta 结构符合 OpenAI 规范（第十八轮 #185）。
//
// 规范：id / type / function.name 只在**该调用第一帧**出现；
// 后续帧只给 function.arguments 增量，客户端靠 index 归并。
//
// 违反后果（实测）：
//   · 严格客户端按帧建出 N 个调用，每个 arguments 都是残片 → JSON 解析失败
//   · 所有工具执行飘红 → 模型以为没成功 → 无限重试死循环
import { readFileSync } from 'node:fs'

const KEY = (process.env.LANTERN_TEST_KEY ?? '').trim()

if (KEY.length === 0) {
  console.log('  SKIP: 未设置 LANTERN_TEST_KEY（这是在线测试，需要真实网关）')
  console.log('')
  console.log('════════ 0 passed / 0 failed (skipped) ════════')
  process.exit(0)
}
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + KEY }
const BASE = 'http://127.0.0.1:3080'
// 模型清单从网关现取，不依赖外部 caches 文件 —— 之前依赖
// ../model-list.json，那个文件在清理临时产物时被删了，导致本测试整块崩掉
// （0 passed / 0 failed / exit=1），回归项数无端少了。
const MODELS_LIST = await (await fetch(BASE + '/v1/models', { headers: H })).json().catch(() => null)
const MODEL = MODELS_LIST?.data?.[0]?.id
if (typeof MODEL !== 'string') {
  console.log('无法从网关取到模型清单，跳过本测试')
  process.exit(0)
}

const TOOL = {
  type: 'function',
  function: {
    name: 'web_search', description: '搜索网页',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 200))) }
}

console.log('=== 流式 tool_calls delta 规范检查 ===')
console.log('模型: ' + MODEL)

const r = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST', headers: H,
  body: JSON.stringify({
    model: MODEL, stream: true, max_tokens: 500,
    tools: [TOOL], tool_choice: 'auto',
    messages: [{ role: 'user', content: '用 web_search 搜索"今天新闻"，必须调用工具。' }],
  }),
  signal: AbortSignal.timeout(180_000),
}).catch(() => null)

if (r === null || r.status !== 200) {
  console.log('  无法获取流（status=' + r?.status + '），跳过')
  process.exit(0)
}

const reader = r.body.getReader()
const dec = new TextDecoder()
let buf = ''
const frames = []
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const p = line.slice(5).trim()
    if (p === '[DONE]') continue
    try {
      const j = JSON.parse(p)
      const tc = j.choices?.[0]?.delta?.tool_calls
      if (Array.isArray(tc)) for (const c of tc) frames.push(c)
    } catch { /* */ }
  }
}

console.log('  收到 ' + frames.length + ' 个 tool_call delta 帧\n')

// 按 index 分组
const byIndex = new Map()
for (const f of frames) {
  const i = f.index ?? 0
  if (!byIndex.has(i)) byIndex.set(i, [])
  byIndex.get(i).push(f)
}

t('至少有一个 tool_call', frames.length > 0, { frames: frames.length })

for (const [idx, list] of byIndex) {
  const first = list[0]
  const rest = list.slice(1)

  // 第一帧必须有 id / type / name
  t(`index=${idx} 首帧有 id`, typeof first.id === 'string' && first.id.length > 0, first.id)
  t(`index=${idx} 首帧有 name`, typeof first.function?.name === 'string' && first.function.name.length > 0, first.function?.name)

  // 后续帧**不应**重复 id（允许带，但更不能带错的）
  const dupIds = rest.filter((f) => f.id !== undefined && f.id !== first.id)
  t(`index=${idx} 后续帧 id 一致或省略`, dupIds.length === 0, { dupIds: dupIds.length })

  // 关键：后续帧不该再带 name（带了会让客户端误以为是新调用）
  const withName = rest.filter((f) => f.function?.name !== undefined && f.function.name.length > 0)
  t(`index=${idx} 后续帧不带 name`, withName.length === 0, { count: withName.length, sample: withName[0]?.function?.name })

  // 拼起来的 arguments 必须是合法 JSON
  const args = list.map((f) => f.function?.arguments ?? '').join('')
  let parsed = null
  try { parsed = JSON.parse(args) } catch { /* */ }
  t(`index=${idx} 拼接后的 arguments 是合法 JSON`, parsed !== null, { args: args.slice(0, 80) })
  if (parsed !== null) t(`index=${idx} arguments 含 query 字段`, typeof parsed.query === 'string', parsed)
}

console.log(`\n═══ ${pass} passed / ${fail} failed ═══`)
process.exitCode = fail > 0 ? 1 : 0
