// 能力闸门「按请求硬能力分组」单测（纯函数级：把 enforceCapabilityGate 提出来打桩跑）
//
// 语义（三态必须分开对待，这是本文件的重点）：
//   preferred = 请求要的每个硬能力都**确认支持** → 排最前
//   fallback  = 没有"确认不支持"、但也没全确认（含 unknown / 查询失败） → 排链尾候补
//   excluded  = 至少一个硬能力**确认不支持** → 本请求彻底不发
//
// 为什么 fallback 不能直接砍：unknown 是"我们没有它的数据"，不是"它不行"。
// 砍掉等于"没档案就不能干活"——当所有已确认支持的档同时挂掉时，本来可能能用的
// 档一次都没被试过，请求直接 503。（和"健康记忆不能禁用后端"同一条道理。）
//
// 为什么 excluded 必须真删：把它留在链尾，等前面全挂时它就会收到带 tools 的请求，
// 而它很可能**默默忽略 tools 返回纯文本** —— 客户端以为拿到了工具调用，实际被降级了。
// 静默降级比失败更坏。
//
//  T1  要 tools：2 支持 + 1 未知 → 放行，未知档留在链尾（不删），顺序不变
//  T1b 未知档排在确认支持的档之后（这是 fallback 的意义）
//  T2  Ineligible 头报"非首选档数"（未知 + 确认不支持）
//  T3  全未知 → 仍拒绝（不静默降级），且链不被砍
//  T4  不带硬能力 → 不过滤
//  T5  全支持 → 无 Ineligible 头
//  T6  普通模型走单模型 describe，不受影响
//  T7  有确认不支持的档时，若一档首选都没有，错误指 unsupported
//  T8  image 确认不支持的档被真删
//  T9  describe 抛错 → 视为未知，保留为候补而非砍掉
//  T10 拒绝必须指向真正缺证据的那项能力（不能连坐）
//  T11 软参数不缩链
//  T12 多硬能力：只有全确认的排首选，其余按配置顺序排候补
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}`
const src = readFileSync(P + '/lib/index.js', 'utf8')

const start = src.indexOf('async function enforceCapabilityGate')
const endMark = src.indexOf('\n/**\n * 网关级图片开关', start)
const fnSrc = src.slice(start, endMark === -1 ? src.length : endMark)

const VALUE = { supported: 'supported', unsupported: 'unsupported', unknown: 'unknown' }

// mergeReasoningCell 是 intersectCapabilityViews 的依赖，必须一起抽出来
const mergeStart = src.indexOf('function mergeReasoningCell')
const mergeEnd = src.indexOf('\n/**', mergeStart)
const mergeSrc = src.slice(mergeStart, mergeEnd)

const intersectStart = src.indexOf('function intersectCapabilityViews')
const intersectEnd = src.indexOf('\n/**', intersectStart)
const intersectSrc = src.slice(intersectStart, intersectEnd)

const cap = (value, source = 'test') => ({ value, source })
const view = (over = {}) => ({
  text: cap('supported'), image: cap('unsupported'), reasoning: cap('unknown'),
  streaming: cap('supported'), tools: cap('unknown'), parallelTools: cap('unknown'),
  jsonMode: cap('unknown'), temperature: cap('unknown'), stop: cap('unknown'),
  ...over,
})

// 简易 enforce 桩：与真实实现同语义（硬能力非 supported → 拒绝）
const mockEnforce = (caps, request) => {
  const check = (field, present) => {
    if (!present) return undefined
    const c = caps[field]
    const value = c?.value ?? 'unknown'
    return value === 'supported' ? undefined : { capability: field, value, source: c?.source ?? null }
  }
  const hard = [
    check('tools', request.hasTools === true),
    check('jsonMode', request.hasJsonMode === true),
    check('image', request.hasImage === true),
    check('reasoning', request.hasReasoningEffort === true),
  ].filter(Boolean)
  if (hard.length > 0) return { reject: { ...hard[0], label: hard[0].capability }, ignored: [], headers: {} }
  return { ignored: [], headers: {} }
}

const factory = new Function(
  'VALUE',
  'mapLevelToBackend',
  'isContractLevel',
  'rankOf',
  mergeSrc + '\n' + intersectSrc + '\n' + fnSrc + '\nreturn { enforceCapabilityGate, intersectCapabilityViews }',
)
// 第十轮：enforceCapabilityGate 的档位筛链改成「A 类契约词 → 映射放行 / B 类具体词 → 按 rank 相等匹配」。
// 这三个依赖必须一起注入，否则函数体里的自由变量会在**调用时**炸成 ReferenceError，
// 被它自己的 try/catch 吞掉 —— 表现为"筛链完全没生效"的假失败（交接文档坑 3 同型）。
// ⚠ rankOf 是第十轮 #104 才加的：漏了它，T18-T23 六条会全部假失败。
const effortContract = await import('file:///' + P + '/lib/effort-contract.js')
const mod = factory(
  VALUE,
  effortContract.mapLevelToBackend,
  effortContract.isContractLevel,
  effortContract.rankOf,
)

const mkGate = (describeMap) => {
  const deps = {
    capabilities: {
      describe: async (provider, model) => {
        const key = provider + '/' + model
        if (!(key in describeMap)) throw new Error('unknown backend ' + key)
        return describeMap[key]
      },
      enforce: mockEnforce,
    },
    directory: { list: () => [], isProviderLive: () => true },
    current: () => ({ masked: false }),
    log: () => {},
  }
  return { gate: mod.enforceCapabilityGate, deps }
}

let pass = 0
let fail = 0
const t = (name, ok, extra) => {
  if (ok) { pass += 1; console.log(name + ': PASS') }
  else { fail += 1; console.log(name + ': FAIL' + (extra ? '(' + extra + ')' : '')) }
}

const target = { custom: true, customName: 'glm-5.3', publicName: 'glm-5.3' }
const plansOf = (...names) => names.map((n) => {
  const [provider, model] = n.split('/')
  return { binding: `${model}@${provider}`, provider, model, publicName: model }
})

// T1/T1b/T2：2 确认支持 + 1 未知
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('supported') }),
    'xdpool/glm-5.3': view({ tools: cap('supported') }),
    'codearts/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('trae/glm-5.3', 'codearts/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T1 未知档保留为候补(不删)', r.enforceResult.reject === undefined && r.plans.length === 3, 'len=' + r.plans.length)
  t('T1b 未知档排到确认支持的后面',
    r.plans.map((p) => p.provider).join(',') === 'trae,xdpool,codearts',
    r.plans.map((p) => p.provider).join(','))
  t('T2 Ineligible 头报非首选档数',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === '1',
    JSON.stringify(r.enforceResult.headers))
}

// T3：全未知 → 仍拒绝，且链不砍
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('unknown') }),
    'xdpool/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T3 全未知仍拒绝',
    r.enforceResult.reject?.capability === 'tools' && r.enforceResult.reject.value === 'unknown',
    r.enforceResult.reject?.capability + '/' + r.enforceResult.reject?.value)
  t('T3b 全未知不砍链', r.plans.length === 2, 'len=' + r.plans.length)
}

// T4：不带硬能力 → 不过滤
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('supported') }),
    'codearts/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('trae/glm-5.3', 'codearts/glm-5.3')
  const r = await gate(deps, target, { hasTemperature: true }, plans)
  t('T4 无硬能力不过滤', r.plans.length === 2 && r.enforceResult.reject === undefined, 'len=' + r.plans.length)
}

// T5：全支持 → 无 Ineligible 头
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('supported') }),
    'xdpool/glm-5.3': view({ tools: cap('supported') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T5 全支持无 Ineligible 头', r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === undefined, JSON.stringify(r.enforceResult.headers))
}

// T6：普通模型不受影响
{
  const { gate, deps } = mkGate({ 'trae/glm-5.3': view({ tools: cap('supported') }) })
  const plain = { custom: false, provider: 'trae', model: 'glm-5.3', publicName: 'glm-5.3' }
  const r = await gate(deps, plain, { hasTools: true }, plansOf('trae/glm-5.3'))
  t('T6 普通模型走单模型 describe', r.enforceResult.reject === undefined && r.plans.length === 1, 'len=' + r.plans.length)
}

// T7：一档首选都没有、且含确认不支持 → 错误指 unsupported
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('unsupported') }),
    'xdpool/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T7 全不合格时报 unsupported', r.enforceResult.reject?.value === 'unsupported', r.enforceResult.reject?.value)
}

// T8：image 确认不支持 → 真删（否则它会静默忽略图片）
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ image: cap('supported') }),
    'xdpool/glm-5.3': view({ image: cap('unsupported') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasImage: true }, plans)
  t('T8 image 确认不支持的档被真删',
    r.enforceResult.reject === undefined && r.plans.length === 1 && r.plans[0].provider === 'trae',
    r.plans.map((p) => p.provider).join(','))
}

// T9：describe 抛错 → 未知，保留为候补
{
  const { gate, deps } = mkGate({ 'trae/glm-5.3': view({ tools: cap('supported') }) })
  const plans = plansOf('trae/glm-5.3', 'gone/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T9 查询失败档保留为候补(不砍)',
    r.enforceResult.reject === undefined && r.plans.length === 2 && r.plans[0].provider === 'trae',
    r.plans.map((p) => p.provider).join(','))
}

// T10：tools 有档支持、reasoning 谁都没有 → 拒绝必须指向 reasoning
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('supported'), reasoning: cap('unknown') }),
    'xdpool/glm-5.3': view({ tools: cap('supported'), reasoning: cap('unknown') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true, hasReasoningEffort: true }, plans)
  const ok = r.enforceResult.reject?.capability === 'reasoning' && r.capsView?.tools?.value === 'supported'
  t('T10 拒绝指向真正缺失的能力',
    ok,
    r.enforceResult.reject?.capability + '/' + r.capsView?.tools?.value)
}

// T11：软参数不参与分组
{
  const { gate, deps } = mkGate({
    'trae/glm-5.3': view({ tools: cap('supported'), temperature: cap('unknown') }),
    'xdpool/glm-5.3': view({ tools: cap('supported'), temperature: cap('unsupported') }),
  })
  const plans = plansOf('trae/glm-5.3', 'xdpool/glm-5.3')
  const r = await gate(deps, target, { hasTools: true, hasTemperature: true }, plans)
  t('T11 软参数不缩链(保故障转移)',
    r.enforceResult.reject === undefined && r.plans.length === 2,
    'len=' + r.plans.length)
}

// T12：多硬能力 → 只有全确认的排首选，其余按配置顺序排候补
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('supported'), reasoning: cap('unknown') }),
    'b/glm-5.3': view({ tools: cap('supported'), reasoning: cap('supported') }),
    'c/glm-5.3': view({ tools: cap('unknown'), reasoning: cap('supported') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3', 'c/glm-5.3')
  const r = await gate(deps, target, { hasTools: true, hasReasoningEffort: true }, plans)
  t('T12 全确认的排首选、其余按配置顺序候补',
    r.enforceResult.reject === undefined
      && r.plans.map((p) => p.provider).join(',') === 'b,a,c',
    r.plans.map((p) => p.provider).join(','))
}

// T13：确认不支持的档被排除，且不计入候选
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('unsupported') }),
    'b/glm-5.3': view({ tools: cap('supported') }),
    'c/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3', 'c/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T13 确认不支持的 excluded、未知的留候补',
    r.plans.map((p) => p.provider).join(',') === 'b,c',
    r.plans.map((p) => p.provider).join(','))
  t('T13b Ineligible 报 2（1 未知 + 1 不支持）',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === '2',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'])
}

// T14：闸门判断只看首选组——候补里的 unknown 不能把已确认的能力拉回 unknown
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('supported') }),
    'b/glm-5.3': view({ tools: cap('unknown') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T14 候补的 unknown 不连坐首选的 supported',
    r.enforceResult.reject === undefined && r.capsView?.tools?.value === 'supported',
    String(r.capsView?.tools?.value))
}

// T15：全部确认不支持的档 → 链回退到原 plans（不返回空链让上层炸）
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('unsupported') }),
    'b/glm-5.3': view({ tools: cap('unsupported') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T15 全不支持时仍拒绝且不返回空链',
    r.enforceResult.reject?.capability === 'tools' && r.plans.length === 2,
    'len=' + r.plans.length)
}

// T16：链上既有确认不支持、也有未知 → 未知的必须在候补里（保住可用性）
//      这是本次改造最重要的一条：不能因为"有档确认不行"就放弃"没证据的档"。
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('unsupported') }),
    'b/glm-5.3': view({ tools: cap('unknown') }),
    'c/glm-5.3': view({ tools: cap('unsupported') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3', 'c/glm-5.3')
  const r = await gate(deps, target, { hasTools: true }, plans)
  t('T16 未知档在候补里而未被一并砍掉',
    r.plans.length === 1 && r.plans[0].provider === 'b',
    r.plans.map((p) => p.provider).join(','))
}

// T17：请求不带硬能力时，确认不支持的档也不该被排除（没有要求就没有冲突）
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ tools: cap('unsupported') }),
    'b/glm-5.3': view({ tools: cap('unsupported') }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, {}, plans)
  t('T17 无硬能力时 unsupported 也不排除',
    r.enforceResult.reject === undefined && r.plans.length === 2,
    'len=' + r.plans.length)
}


// T18-T23 reasoning 档位按值筛链
//
// ⚠ 第十轮把这里改成两套规则，所以旧断言要跟着改：
//   A 类（minimal/low/medium/high）→ 契约词，各家词表里几乎都没有，只能靠映射；
//   B 类（xhigh/MAX/off/light…）→ 具体私有词，必须严格匹配。
//
// 旧断言把 xhigh（B 类）当契约词测“字符串精确”，
// 现在 B 类的保护一字未改；A 类的语义升级由 test-effort-contract-gate.mjs 验证。
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low', 'high', 'max'] } }),
    'b/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low', 'high', 'xhigh'] } }),
    'c/glm-5.3': view({ reasoning: { value: 'unknown', source: null } }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3', 'c/glm-5.3')
  const r = await gate(deps, target, { hasReasoningEffort: true, reasoningEffort: 'xhigh' }, plans)
  t('T18 reasoning(B类): xhigh 只留声明了它的档 + 无档案的候补',
    r.enforceResult.reject === undefined && r.plans.map((p) => p.provider).join(',') === 'b,c',
    r.plans.map((p) => p.provider).join(','))
  t('T19 reasoning(B类): 明确不认这个值的档被排除（a 没有 xhigh）',
    r.plans.some((p) => p.provider === 'a') === false)
  // 第十轮：Ineligible 现在同时计入“候补”与“排除”。
  // 这与它公开的语义一致（头名不变，含义早已从“被剔除”放宽为“没排进首选”）。
  t('T20 reasoning: Ineligible 报非首选档数（候补 1 + 排除 1 = 2）',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === '2',
    JSON.stringify(r.enforceResult.headers))
}
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low', 'max'] } }),
    'b/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['none', 'high', 'xhigh'] } }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasReasoningEffort: true, reasoningEffort: 'MAX' }, plans)
  // 第十一轮：`MAX` 归一到契约档 `max`，而 max 的语义是"该家最强档"。
  // 两个后端都认得出强度（a 有 max、b 有 xhigh），所以**两个都该留下** ——
  // 这是修复后的正确行为，不是回归。旧断言按"字面命中 max"写的，已过时。
  t('T21 reasoning: MAX 归一到 max 契约档，两个后端都留（各自发自己最强的档）',
    r.enforceResult.reject === undefined && r.plans.length === 2,
    r.plans.map((p) => p.provider).join(','))
}
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low'] } }),
    'b/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low'] } }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasReasoningEffort: true, reasoningEffort: 'ultra' }, plans)
  // 全都不认这个值时，**闸门不负责拒绝**：它只把 capsView.reasoning.efforts
  // 算成并集（['low']），下游四档契约/旧校验会 400 invalid_reasoning_effort。
  // 这里要断言的是“efforts 没有被抹成空”：一旦为空，就没人能给出 allowed 列表。
  t('T22 reasoning: 全都不认值 → efforts 仍是并集（交由下游拒绝，不能变空）',
    JSON.stringify(r.capsView?.reasoning?.efforts) === JSON.stringify(['low']) && r.plans.length === 2,
    JSON.stringify(r.capsView?.reasoning?.efforts) + '/len=' + r.plans.length)
}
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['off', 'high'] } }),
    'b/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['high'] } }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasReasoningEffort: true, reasoningEffort: 'off' }, plans)
  t('T23 reasoning(B类): off 只发给声明了 off 的档（Anthropic thinking=disabled）',
    r.enforceResult.reject === undefined && r.plans.length === 1 && r.plans[0].provider === 'a',
    r.plans.map((p) => p.provider).join(','))
}
{
  const { gate, deps } = mkGate({
    'a/glm-5.3': view({ reasoning: { value: 'supported', source: 'declared', efforts: ['low', 'max'] } }),
    'b/glm-5.3': view({ reasoning: { value: 'unknown', source: null } }),
  })
  const plans = plansOf('a/glm-5.3', 'b/glm-5.3')
  const r = await gate(deps, target, { hasReasoningEffort: true }, plans)
  t('T24 reasoning: 没有档位值时不筛链（只要能力声明）',
    r.enforceResult.reject === undefined && r.plans.length === 2,
    'len=' + r.plans.length)
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ': ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
