import { LANTERN_DIR } from './paths.mjs'
/**
 * 第十轮：统一调用契约（call-contract）护栏。
 *
 * 核心事实：三类参数差异只有一类能被"对照表"控制。
 *   · 枚举型（档位、格式）→ 能映射；
 *   · 能力型（tools/图片）→ 只能筛链；
 *   · 标量型（temperature/top_p/max_tokens）→ 只能封顶 + 如实标注。
 *
 * 把 temperature 也做成"对照表"是错的：没有上游会告诉你它的温度刻度，
 * 强行归一就是替用户改值，而他看到的还是原值 —— 最坏的一种静默失真。
 */
const P = `${LANTERN_DIR}/lib/`
const cc = await import('file:///' + P + 'call-contract.js')
const ec = await import('file:///' + P + 'effort-contract.js')

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

console.log('=== C1 枚举型契约清单 ===')
t('C1a reasoning 已登记', cc.ENUM_CONTRACTS.reasoning !== undefined)
t('C1b reasoning 的四档与 effort-contract 同源',
  JSON.stringify(cc.ENUM_CONTRACTS.reasoning.levels) === JSON.stringify(ec.CONTRACT_LEVELS))
t('C1c 默认档是 medium', cc.ENUM_CONTRACTS.reasoning.defaultLevel === 'medium')
t('C1d 头前缀已声明', cc.ENUM_CONTRACTS.reasoning.headerPrefix === 'X-Lantern-Effort')

console.log('\n=== C2 标量表：只封顶，不归一 ===')
t('C2a temperature 区间 0-2', cc.SCALAR_LIMITS.temperature.min === 0 && cc.SCALAR_LIMITS.temperature.max === 2)
t('C2b top_p 区间 0-1', cc.SCALAR_LIMITS.top_p.min === 0 && cc.SCALAR_LIMITS.top_p.max === 1)
t('C2c stop 条数上限 4', cc.SCALAR_LIMITS.stop.max === 4)
t('C2d 每个标量都带 note（说明为什么不归一）',
  Object.values(cc.SCALAR_LIMITS).every((s) => typeof s.note === 'string' && s.note.length > 0))

console.log('\n=== C3 clampScalar ===')
t('C3a 区间内原样返回', cc.clampScalar('temperature', 0.7).value === 0.7)
t('C3b 越界被钳到下界', cc.clampScalar('temperature', -5).value === 0)
t('C3c 越界被钳到上界', cc.clampScalar('temperature', 99).value === 2)
t('C3d clamped 标记为真', cc.clampScalar('temperature', 99).clamped === true)
t('C3e 区间内 clamped 为假', cc.clampScalar('temperature', 0.7).clamped === false)
t('C3f NaN 拒绝（不是当成 0）', cc.clampScalar('temperature', Number.NaN).ok === false)
t('C3g Infinity 拒绝', cc.clampScalar('temperature', Number.POSITIVE_INFINITY).ok === false)
t('C3h 字符串拒绝', cc.clampScalar('temperature', '0.7').ok === false)
t('C3i 未知参数拒绝', cc.clampScalar('banana', 1).ok === false)
t('C3j 外部 cap 更小时以 cap 为准', cc.clampScalar('max_tokens', 999999, { cap: 8192 }).value === 8192)
t('C3k cap 为 0/负数时忽略（不当成不封顶）',
  cc.clampScalar('max_tokens', 100, { cap: 0 }).value === 100)
t('C3l cap 为非有限数时忽略',
  cc.clampScalar('max_tokens', 100, { cap: Number.NaN }).value === 100)

console.log('\n=== C4 clipStopSequences ===')
const s4 = cc.clipStopSequences(['a', 'b'])
t('C4a 未超限原样', JSON.stringify(s4.value) === JSON.stringify(['a', 'b']) && s4.dropped.length === 0)
const s4b = cc.clipStopSequences(['a', 'b', 'c', 'd', 'e', 'f'])
t('C4b 超限截到 4 条', s4b.value.length === 4)
t('C4c 丢掉的 2 条被报告', s4b.dropped.length === 2 && s4b.dropped[0] === 'e')
t('C4d 非字符串项被过滤', JSON.stringify(cc.clipStopSequences(['a', 42, null, 'b']).value) === JSON.stringify(['a', 'b']))
t('C4e 空数组 → undefined（不下发空 stop）', cc.clipStopSequences([]).value === undefined)
t('C4f 非数组 → undefined', cc.clipStopSequences('abc').value === undefined)
t('C4g 全是空串 → undefined', cc.clipStopSequences(['', '']).value === undefined)

console.log('\n=== C5 describeContracts ===')
const d5 = cc.describeContracts({ reasoning: { contract: 'high', word: 'max', mode: 'fallback' } })
t('C5a 有契约档', d5['X-Lantern-Effort-Contract'] === 'high')
t('C5b 有实发词', d5['X-Lantern-Effort-Served'] === 'max')
t('C5c 非 native 时有 mode', d5['X-Lantern-Effort-Mode'] === 'fallback')
const d5b = cc.describeContracts({ reasoning: { contract: 'high', word: 'high', mode: 'native' } })
t('C5d native 不写 mode（避免噪音）', d5b['X-Lantern-Effort-Mode'] === undefined)
t('C5e 空输入不炸', Object.keys(cc.describeContracts({})).length === 0)
t('C5f undefined 不炸', Object.keys(cc.describeContracts(undefined)).length === 0)

console.log('\n=== C6 isStrongerThan（认不出时返回 undefined 而不是 false） ===')
t('C6a max 强于 low', cc.isStrongerThan('max', 'low') === true)
t('C6b low 不强于 max', cc.isStrongerThan('low', 'max') === false)
t('C6c 跨词表比较（xhigh > light）', cc.isStrongerThan('xhigh', 'light') === true)
t('C6d 相同档位为假', cc.isStrongerThan('high', 'high') === false)
t('C6e 认不出返回 undefined', cc.isStrongerThan('banana', 'high') === undefined)

console.log('\n=== C7 能力型参数清单与 capabilities.js 同源 ===')
const capsSrc = (await import('node:fs')).readFileSync(P + 'capabilities.js', 'utf8')
t('C7a tools 在列', cc.CAPABILITY_PARAMS.includes('tools'))
t('C7b 六项与 capabilities.KEYS 的子集一致',
  cc.CAPABILITY_PARAMS.every((k) => capsSrc.includes(`'${k}'`)))
t('C7c 不包含 streaming（它不是"请求参数"）', !cc.CAPABILITY_PARAMS.includes('streaming'))

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
