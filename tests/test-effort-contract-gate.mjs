/**
 * 第十轮：统一四档推理契约 —— 闸门侧语义护栏。
 *
 * 这一套把「A 类契约词 / B 类具体词」两套规则的边界钉死。
 * 它替代 test-capability-gate.mjs 里 T18-T23 的旧口径：
 * 旧断言按"字符串严格匹配"写，而契约词（medium/minimal）在各家词表里
 * 本来就不存在，严格匹配会把整条链排空 —— 那正是本轮要修的东西。
 *
 * 保留的旧保护（必须在）：
 *   · B 类具体词（xhigh/MAX/off）→ 明确不认的档必须排除；
 *   · 无档案的档 → 只降为候补，不剥夺候选资格；
 *   · 不传档位 → 一档不动。
 *
 * 新增的保护：
 *   · A 类契约词 → 能映射就放行（不再排空链）；
 *   · 契约词认不出的后端 → 候补而非排除。
 */
import { LANTERN_DIR } from './paths.mjs'
import fs from 'node:fs'

const P = `${LANTERN_DIR}/lib/`
const idx = fs.readFileSync(P + 'index.js', 'utf8')

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

function extract(name, src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.includes('function ' + name + '('))
  if (start < 0) throw new Error('not found ' + name)
  let depth = 0, end = start
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1 }
    if (depth === 0 && i > start) { end = i; break }
  }
  return lines.slice(start, end + 1).join('\n')
}

const mod = await import('file:///' + P + 'effort-contract.js')
const VALUE = { supported: 'supported', unsupported: 'unsupported', unknown: 'unknown' }
// 注入的全局必须活到全部用例跑完：函数体里的自由变量在**调用时**解析，
// 提前 delete 会产生 ReferenceError 并被闸门自己的 try/catch 吞掉，
// 表现为"闸门完全没生效"——第八轮踩过同型假失败。
for (const [k, v] of Object.entries({ ...mod, VALUE })) globalThis[k] = v

const src = `
  const VALUE = ${JSON.stringify(VALUE)}
  ${extract('enforceCapabilityGate', idx)}
  ${extract('intersectCapabilityViews', idx)}
  ${extract('mergeReasoningCell', idx)}
  return { enforceCapabilityGate }`
const { enforceCapabilityGate } = new Function(src)()

const view = (o) => ({
  text: { value: 'supported' }, image: { value: 'supported' }, tools: { value: 'supported' },
  jsonMode: { value: 'supported' }, temperature: { value: 'supported' }, stop: { value: 'supported' }, ...o,
})
const plansOf = (...ids) => ids.map((s) => { const [provider, model] = s.split('/'); return { provider, model, binding: s } })
const target = { custom: true, name: 'glm-5.3' }
const mkDeps = (map) => ({
  capabilities: { describe: async (p, m) => map[p + '/' + m], enforce: () => ({ ignored: [], headers: {} }) },
})
const run = async (map, effort, ids) => enforceCapabilityGate(
  mkDeps(map), target,
  effort === undefined ? {} : { hasReasoningEffort: true, reasoningEffort: effort },
  plansOf(...ids),
)

console.log('=== G1 B 类具体词：旧保护必须原样保留 ===')
{
  // a 没有 xhigh → 必须排除；c 没档案 → 候补留在链上
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high', 'max'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high', 'xhigh'] } }),
    'c/g': view({ reasoning: { value: 'unknown' } }),
  }, 'xhigh', ['a/g', 'b/g', 'c/g'])
  t('G1a 明确不认 xhigh 的 a 被排除', r.plans.map((p) => p.provider).join(',') === 'b,c',
    r.plans.map((p) => p.provider).join(','))
  t('G1b Ineligible = 候补(1) + 排除(1) = 2',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === '2',
    r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'])
}
{
  // 第十一轮：`MAX` 归一到契约档 `max` = "该家最强档"。
  // 两个后端都认得出强度（a 有 max、b 有 xhigh），所以都留 —— 各自发自己最强的。
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['low', 'max'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['none', 'high', 'xhigh'] } }),
  }, 'MAX', ['a/g', 'b/g'])
  t('G1c MAX 归一到 max 契约档，两个后端都留', r.plans.length === 2,
    r.plans.map((p) => p.provider).join(','))
}
{
  // off 只发给声明了 off 的档（Anthropic thinking=disabled）
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['off', 'low', 'high'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high'] } }),
  }, 'off', ['a/g', 'b/g'])
  t('G1d off 只发给声明了 off 的档', r.plans.length === 1 && r.plans[0].provider === 'a',
    r.plans.map((p) => p.provider).join(','))
}
{
  // 完全不认识的词 → 两个都不认 → 无首选，原链返回（交给下游 400）
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['low'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['low'] } }),
  }, 'ultra', ['a/g', 'b/g'])
  t('G1e 全都认不出 → 不筛链（原链返回，下游负责 400）',
    r.plans.map((p) => p.provider).join(',') === 'a,b', r.plans.map((p) => p.provider).join(','))
  t('G1f 并集没有被抹空（下游才能给出 allowed 列表）',
    JSON.stringify(r.capsView?.reasoning?.efforts) === JSON.stringify(['low']),
    JSON.stringify(r.capsView?.reasoning?.efforts))
}

console.log('\n=== G2 A 类契约词：本轮新增的自适应 ===')
{
  // 各家词表都没有 medium，但都能映射 → 一档不该被排除
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high', 'max'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['light', 'high'] } }),
  }, 'medium', ['a/g', 'b/g'])
  t('G2a medium 不再把整条链排空', r.plans.map((p) => p.provider).join(',') === 'a,b',
    r.plans.map((p) => p.provider).join(','))
  t('G2b 无排除时不该有 Ineligible 头', r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === undefined)
}
{
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['off', 'low', 'high'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high'] } }),
  }, 'minimal', ['a/g', 'b/g'])
  t('G2c minimal 两档都留（a 有 off，b 映射到 low）',
    r.plans.map((p) => p.provider).join(',') === 'a,b', r.plans.map((p) => p.provider).join(','))
}
{
  // 第十一轮：全陌生动词时 `mapLevelToBackend` 会退回"裸分位"（按原序取），
  // 于是它**能给出一个词**而不是 unknown —— 这是刻意的：
  // 某家自造了 turbo/ultra 两档，选 max 就该发 ultra（最后一个），
  // 而不是"不知道所以不给"。所以 a 不再是候补。
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['turbo', 'ultra'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['low', 'high'] } }),
  }, 'max', ['a/g', 'b/g'])
  t('G2d 全陌生动词的后端也能出档（裸分位），不被排除',
    r.plans.map((p) => p.provider).join(',') === 'a,b', r.plans.map((p) => p.provider).join(','))
}

console.log('\n=== G3 不传档位：一档不动 ===')
{
  const r = await run({
    'a/g': view({ reasoning: { value: 'supported', efforts: ['low'] } }),
    'b/g': view({ reasoning: { value: 'supported', efforts: ['high'] } }),
  }, undefined, ['a/g', 'b/g'])
  t('G3a 不传时不筛链', r.plans.map((p) => p.provider).join(',') === 'a,b',
    r.plans.map((p) => p.provider).join(','))
  t('G3b 不传时无 Ineligible 头', r.enforceResult.headers?.['X-Lantern-Backends-Ineligible'] === undefined)
}

console.log('\n=== G4 硬能力与档位互不连坐 ===')
{
  // tools + medium：tools 全支持、档位都能映射 → 全留
  const r = await run({
    'a/g': view({ tools: { value: 'supported' }, reasoning: { value: 'supported', efforts: ['low', 'high'] } }),
    'b/g': view({ tools: { value: 'supported' }, reasoning: { value: 'supported', efforts: ['low', 'high'] } }),
  }, 'medium', ['a/g', 'b/g'])
  t('G4a tools + medium：两档都留', r.plans.length === 2)
  t('G4b 不误报 tools 被拒', r.enforceResult.reject === undefined)
}

console.log('\n=== G5 源码级接线护栏 ===')
t('G5a wantsContract 用 isContractLevel 判定边界（不靠"能不能映射"）',
  /const wantsContract = wantEffort !== undefined && isContractLevel\(wantEffort\)/.test(idx))
t('G5b B 类仍走严格字符串匹配', /list\.some\(\(e\) => e === wantEffort\)/.test(idx))
t('G5c A 类走 mapLevelToBackend', /const mapped = mapLevelToBackend\(list, wantEffort\)/.test(idx))

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
