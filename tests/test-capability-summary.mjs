/**
 * test-capability-summary.mjs — 展示侧必须和执行侧同一套语义。
 *
 * 背景（真实缺陷，两轮）：
 *   第一轮：执行侧改成「按请求要的能力筛档」，展示侧还报全体交集 →
 *          目录说 tools=unknown，请求却能 200，接口自相矛盾。
 *   第二轮（更严重）：光加 capabilitiesByBackend 不够。客户端（DSH 自己就是）
 *          读的是**顶层** capabilities.tools，看到 unknown 就干脆不启用工具 ——
 *          于是"能带工具"永远没机会被验证，接口把自己的能力藏死了。
 *
 * 所以顶层必须按执行侧的真实语义归并：
 *   任一档 supported → supported（执行侧会筛链）
 *   全 unsupported   → unsupported
 *   其余（无证据）    → unknown
 *
 * 数值型仍取最小（真保守下界：说小不说大，客户端按小值规划不会溢出）。
 *
 * 断言跑的是真实源码函数（new Function 提取），不是复制品。
 */
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const SRC = `${LANTERN_DIR}/lib/index.js`
const src = readFileSync(SRC, 'utf8')

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + extra)) }
}

const grab = (name) => {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('没找到函数 ' + name)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// 从 effort-contract.js 取真实实现注入（脚手架 eval 看不到外部作用域）
const { describeChainLevels } = await import('../lib/effort-contract.js')

const factory = new Function(
  'describeChainLevels',
  grab('mergeReasoningCell') + '\n' + grab('intersectCapabilityViews') + '\n' + grab('summarizeCapabilities') + '\n' + grab('capabilityNoteOf')
  + '\nreturn { intersectCapabilityViews, summarizeCapabilities, capabilityNoteOf }',
)
const {  summarizeCapabilities, capabilityNoteOf, intersectCapabilityViews } = factory(describeChainLevels)

const cell = (value, source = 'declared') => ({ value, source })
const view = (over) => ({
  text: cell('supported'),
  image: cell('unknown'),
  reasoning: cell('unknown'),
  streaming: cell('supported'),
  tools: cell('unknown'),
  parallelTools: cell('unknown'),
  jsonMode: cell('unknown'),
  temperature: cell('unknown'),
  stop: cell('unknown'),
  contextWindow: cell(1000000, 'dsh'),
  maxOutputTokens: cell(64000, 'dsh'),
  ...over,
})

const plans = [
  { provider: 'trae', model: 'glm-5.3' },
  { provider: 'xdpool', model: 'glm-5.3' },
  { provider: 'codearts', model: 'glm-5.3' },
]

console.log('\n【U1 顶层按并集归并（这是修掉"藏死自己能力"的关键）】')
{
  const views = [view({ tools: cell('supported') }), view({ tools: cell('unknown') }), view({})]
  const { merged } = summarizeCapabilities(plans, views, false)
  check('U1a 一档支持 → 顶层 supported', merged.tools.value === 'supported', String(merged.tools?.value))
  check('U1b source 指向那个支持的档', typeof merged.tools.source === 'string' && merged.tools.source !== 'union', String(merged.tools?.source))
}
{
  const views = [view({ tools: cell('unsupported') }), view({ tools: cell('unsupported') })]
  const { merged } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U1c 全部 unsupported → unsupported（确实没人行）', merged.tools.value === 'unsupported', String(merged.tools?.value))
}
{
  const views = [view({}), view({})]
  const { merged } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U1d 全无证据 → unknown（不谎称 unupported）', merged.tools.value === 'unknown', String(merged.tools?.value))
}
{
  // unsupported + unknown、没有 supported → unknown。报 unsupported 是在断言"确定不行"，
  // 而我们只是"有的档没证据"。
  const views = [view({ tools: cell('unsupported') }), view({ tools: cell('unknown') })]
  const { merged } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U1e unsupported + unknown → unknown（不为未知扣帽子）', merged.tools.value === 'unknown', String(merged.tools?.value))
}

console.log('\n【U2 有的档 describe 抛错时不能因此把能力判死】')
{
  const views = [view({ tools: cell('supported') }), undefined, null]
  const { merged, byBackend } = summarizeCapabilities(plans, views, false)
  check('U2a 缺失档不影响顶层', merged.tools.value === 'supported', String(merged.tools?.value))
  check('U2b byBackend 只列能查到的档', byBackend.length === 1, String(byBackend.length))
}

console.log('\n【U3 逐档能力要说真话】')
{
  const views = [
    view({ tools: cell('supported') }),
    view({ tools: cell('supported'), image: cell('unsupported') }),
    view({ tools: cell('unknown') }),
  ]
  const { byBackend } = summarizeCapabilities(plans, views, false)
  check('U3a 三档都在', byBackend.length === 3, String(byBackend.length))
  check('U3b 第一档点名 provider', byBackend[0].backend === 'glm-5.3@trae', byBackend[0].backend)
  check('U3c 第二档确实报了 image=unsupported', byBackend[1].image === 'unsupported', String(byBackend[1].image))
  check('U3d 第三档 tools=unknown 没被粉饰', byBackend[2].tools === 'unknown', String(byBackend[2].tools))
  check('U3e 数值能力也带出来', byBackend[0].contextWindow === 1000000, String(byBackend[0].contextWindow))
}

console.log('\n【U4 脱敏时不能泄露 provider 名】')
{
  const views = [view({ tools: cell('supported') }), view({})]
  const { byBackend } = summarizeCapabilities(plans, views, true)
  check('U4a 用序号代替 provider', byBackend[0].backend === '#1' && byBackend[1].backend === '#2', JSON.stringify(byBackend.map((r) => r.backend)))
  check('U4b 全文不含 trae/xdpool', JSON.stringify(byBackend).includes('trae') === false && JSON.stringify(byBackend).includes('xdpool') === false, '')
  check('U4c 档数仍然给出', byBackend.length === 2, String(byBackend.length))
}

console.log('\n【U5 数值型取最大值（#147 改向：对外能力不得低于任一可用档）】')
{
  const views = [view({ contextWindow: cell(1000000) }), view({ contextWindow: cell(128000) })]
  const { merged } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U5a 上下文窗口取最大', merged.contextWindow.value === 1000000, String(merged.contextWindow?.value))
  check('U5b 不再被最小档拖低', merged.contextWindow.value !== 128000, '')
}

console.log('\n【U6 capabilityNote 只提示"部分支持"，不提示"可信"】')
{
  const views = [view({ tools: cell('supported') }), view({}), view({})]
  const { merged, byBackend } = summarizeCapabilities(plans, views, false)
  const note = capabilityNoteOf(merged, byBackend)
  check('U6a 部分支持 → 给说明', typeof note === 'string' && note.includes('tools'), String(note))
  check('U6b 说明点名了排查入口', note.includes('capabilitiesByBackend'), String(note))
  check('U6c 说明措辞是"部分"不是"保守下界"', note.includes('部分'), String(note))
}
{
  // 全部支持 → 无歧义，不该多嘴
  const views = [view({ tools: cell('supported') }), view({ tools: cell('supported') })]
  const { merged, byBackend } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U6d 全支持时不给说明', capabilityNoteOf(merged, byBackend) === undefined, String(capabilityNoteOf(merged, byBackend)))
}
{
  // 全都不支持 → 无歧义（就是不行），不需要解释筛链
  const views = [view({ tools: cell('unsupported') }), view({ tools: cell('unsupported') })]
  const { merged, byBackend } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U6e 全不支持时不给说明', capabilityNoteOf(merged, byBackend) === undefined, String(capabilityNoteOf(merged, byBackend)))
}
{
  // 全无证据 → 无歧义（不知道就是不知道）
  const views = [view({}), view({})]
  const { merged, byBackend } = summarizeCapabilities(plans.slice(0, 2), views, false)
  check('U6f 全无证据时不给说明', capabilityNoteOf(merged, byBackend) === undefined, String(capabilityNoteOf(merged, byBackend)))
}

console.log('\n【U7 边界不炸】')
{
  check('U7a 空 plans', summarizeCapabilities([], [], false).byBackend.length === 0, '')
  const r = summarizeCapabilities(plans, [undefined, null, view({})], false)
  check('U7b describe 抛错的档被跳过', r.byBackend.length === 1, String(r.byBackend.length))
  check('U7c undefined plans 不炸', summarizeCapabilities(undefined, undefined, false).byBackend.length === 0, '')
  check('U7d merged 为 undefined 时 note 不炸', capabilityNoteOf(undefined, []) === undefined, '')
  check('U7e intersectCapabilityViews(undefined) 不炸', intersectCapabilityViews(undefined) === undefined, '')
}

console.log('\n【U8 交集函数本身没被改坏（它仍是执行侧的保守合并工具）】')
{
  const a = view({ tools: cell('supported'), contextWindow: cell(200000) })
  const b = view({ tools: cell('unsupported'), contextWindow: cell(128000) })
  const m = intersectCapabilityViews([a, b])
  check('U8a 三态取最差', m.tools.value === 'unsupported', String(m.tools?.value))
  check('U8b 数值取最大（#147）', m.contextWindow.value === 200000, String(m.contextWindow?.value))
  check('U8c 单档原样返回', intersectCapabilityViews([a]) === a, '')
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
