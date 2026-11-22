// test-effort-contract.mjs —— 四档推理契约的行为测试（对齐真实签名）。
//
// 关键签名（读源码确认，不是猜的）：
//   mapLevelToBackend(declared: string[], level) -> { ok, word?, contract, mode?, ... }
//   resolveChainLevel(backends: Array<{efforts:string[]}>, level) -> { mode, word?, ... }
//   supportedContractLevels(backends: Array<{efforts:string[]}>) -> string[]
//   describeChainLevels(backends: Array<{efforts:string[]}>) -> Array<{level,word,mode}>
//
// 契约在第十三轮改过名：最高档 high → max。`high` 作为**上游私有词**仍合法，
// 且必须能归一到 max 桶 —— 所以本文件里 `max` 与 `high` 都会出现，位置不同。
import {
  CONTRACT_LEVELS, DEFAULT_CONTRACT_LEVEL, rankOf, isContractLevel,
  toContractLevel, mapLevelToBackend, resolveChainLevel, effortNote,
  supportedContractLevels, describeChainLevels,
} from '../lib/effort-contract.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}
const section = (n) => console.log('\n【' + n + '】')

/** 构造一个 backend（词表）。 */
const be = (efforts) => ({ efforts })

// ── E1 契约本身 ──
section('E1 四档契约')
ok('E1a 四档顺序',
  JSON.stringify(CONTRACT_LEVELS) === JSON.stringify(['minimal', 'low', 'medium', 'max']),
  JSON.stringify(CONTRACT_LEVELS))
ok('E1b 默认档是 medium', DEFAULT_CONTRACT_LEVEL === 'medium', DEFAULT_CONTRACT_LEVEL)
ok('E1c 四档都 isContractLevel', CONTRACT_LEVELS.every((l) => isContractLevel(l) === true))
ok('E1d high 不再是契约档（已改名 max）', isContractLevel('high') === false)
ok('E1e 空串不是契约档', isContractLevel('') === false)
ok('E1f undefined 不是契约档', isContractLevel(undefined) === false)

// ── E2 rankOf ──
section('E2 rankOf 强弱序')
ok('E2a off/none/disabled 都是 0',
  rankOf('off') === 0 && rankOf('none') === 0 && rankOf('disabled') === 0)
ok('E2b 四档递增',
  rankOf('minimal') < rankOf('low') && rankOf('low') < rankOf('medium') && rankOf('medium') < rankOf('max'),
  [rankOf('minimal'), rankOf('low'), rankOf('medium'), rankOf('max')].join('<'))
ok('E2c max 比 extra_high 更强（max 是契约里的最强档）', rankOf('max') > rankOf('extra_high'), rankOf('max') + '>' + rankOf('extra_high'))
ok('E2d light 比 minimal 强', rankOf('light') > rankOf('minimal'))
ok('E2e 未知词不是有效位次', !(rankOf('bogus') > 0), String(rankOf('bogus')))

// ── E3 toContractLevel ──
section('E3 toContractLevel 归一化')
ok('E3a 四档原样',
  CONTRACT_LEVELS.every((l) => toContractLevel(l) === l),
  CONTRACT_LEVELS.map((l) => toContractLevel(l)).join(','))
ok('E3b high → max', toContractLevel('high') === 'max', String(toContractLevel('high')))
ok('E3c xhigh → max', toContractLevel('xhigh') === 'max', String(toContractLevel('xhigh')))
ok('E3d extra_high → max', toContractLevel('extra_high') === 'max', String(toContractLevel('extra_high')))
ok('E3e light → low（比 minimal 强一档）', toContractLevel('light') === 'low', String(toContractLevel('light')))
ok('E3f off → minimal（关思考归最弱档）', toContractLevel('off') === 'minimal', String(toContractLevel('off')))
ok('E3g 未知词 → undefined', toContractLevel('whatever') === undefined, String(toContractLevel('whatever')))

// ── E4 mapLevelToBackend ──
section('E4 mapLevelToBackend 按相对位置落词')
{
  const three = ['light', 'high', 'extra_high']
  const rMax = mapLevelToBackend(three, 'max')
  ok('E4a max → 最后一个词', rMax.ok === true && rMax.word === 'extra_high', JSON.stringify(rMax))
  const rMin = mapLevelToBackend(three, 'minimal')
  ok('E4b minimal → 第一个词', rMin.ok === true && rMin.word === 'light', JSON.stringify(rMin))
  const rLow = mapLevelToBackend(three, 'low')
  const rMid = mapLevelToBackend(three, 'medium')
  // #161：3 档词表无法表达 4 个不同档位（抽屉原理）。原来这条断言要求
  // "3 档上不撞车"，那是做不到的——除非放弃"max 拿最强"或"minimal 拿最弱"。
  // 现在把它拆成两条更准的：
  //   · 3 档：允许撞车，但 low 不得比 medium 强（方向正确即可）
  //   · 4 档：必须四档全不同（这才是用户能感知的"档位有效"）
  ok('E4c 3 档上 low 不弱于…（允许重合，方向必须对）',
    three.indexOf(rLow.word) <= three.indexOf(rMid.word),
    rLow.word + ' vs ' + rMid.word)
  {
    const four = ['minimal', 'low', 'medium', 'max']
    const slots = CONTRACT_LEVELS.map((l) => mapLevelToBackend(four, l).word)
    ok('E4c2 4 档词表上四档全不同（#161）',
      new Set(slots).size === 4, slots.join(','))
    const five = ['low', 'medium', 'high', 'xhigh', 'max']
    const s5 = CONTRACT_LEVELS.map((l) => mapLevelToBackend(five, l).word)
    ok('E4c3 5 档词表上四档全不同（#161）',
      new Set(s5).size === 4, s5.join(','))
    const six = ['light', 'high', 'extra_high', 'low', 'medium', 'xhigh']
    const s6 = CONTRACT_LEVELS.map((l) => mapLevelToBackend(six, l).word)
    ok('E4c4 6 档词表上四档全不同（#161）',
      new Set(s6).size === 4, s6.join(','))
  }
  ok('E4d low 不比 medium 强',
    three.indexOf(rLow.word) <= three.indexOf(rMid.word),
    rLow.word + ' vs ' + rMid.word)
  // 单调性：四档落点下标不减
  let mono = true
  let prev = -1
  for (const l of CONTRACT_LEVELS) {
    const idx = three.indexOf(mapLevelToBackend(three, l).word)
    if (idx < prev) mono = false
    prev = idx
  }
  ok('E4e 四档落点单调不减', mono)
  // 空词表 = 不知道，不是不支持
  const rEmpty = mapLevelToBackend([], 'max')
  ok('E4f 空词表 → ok:false / empty-list（不谎称不支持）',
    rEmpty.ok === false && rEmpty.reason === 'empty-list', JSON.stringify(rEmpty))
  // 未知档
  const rBad = mapLevelToBackend(three, 'nonsense')
  ok('E4g 未知档 → unknown-level', rBad.ok === false && rBad.reason === 'unknown-level', JSON.stringify(rBad))
}

// ── E5 resolveChainLevel ──
section('E5 resolveChainLevel 多档链')
{
  const chain = [be(['light', 'high', 'extra_high'])]
  for (const l of CONTRACT_LEVELS) {
    const r = resolveChainLevel(chain, l)
    ok('E5-' + l + ' 能落词', typeof r.word === 'string' && r.word.length > 0, JSON.stringify(r))
  }
  // 多档链：取每档都能兑现的词
  const multi = [be(['light', 'high', 'extra_high']), be(['low', 'high', 'max'])]
  for (const l of CONTRACT_LEVELS) {
    const r = resolveChainLevel(multi, l)
    ok('E5m-' + l + ' 多档链也有落点', typeof r.word === 'string' && r.word.length > 0, JSON.stringify(r))
  }
  const empty = resolveChainLevel([], 'max')
  ok('E5e 空链 → degraded（不假装成功）', empty.mode === 'degraded', JSON.stringify(empty))
}

// ── E6 supportedContractLevels ──
section('E6 supportedContractLevels')
{
  const four = supportedContractLevels([be(['minimal', 'low', 'medium', 'max'])])
  ok('E6a 四档齐全 → 四档全有',
    JSON.stringify(four) === JSON.stringify(['minimal', 'low', 'medium', 'max']), JSON.stringify(four))
  const onlyLight = supportedContractLevels([be(['light'])])
ok('E6b 只有 light 时四档仍有落点（位置映射按相对位置铺满）', onlyLight.length === 4, JSON.stringify(onlyLight))
  const emptyList = supportedContractLevels([be([])])
  ok('E6c 空词表 → 空档表', emptyList.length === 0, JSON.stringify(emptyList))
  const bogus = supportedContractLevels([be(['nonsense'])])
ok('E6d 全陌生词时四档仍有落点（不因词不认识就把档判死）', bogus.length === 4, JSON.stringify(bogus))
  // 并集：两档各覆盖一半 → 合起来四档都有
  const union = supportedContractLevels([be(['minimal', 'low']), be(['medium', 'max'])])
  ok('E6e 多档并集覆盖四档', union.length === 4, JSON.stringify(union))
}

// ── E7 describeChainLevels ──
section('E7 describeChainLevels')
{
  const levels = describeChainLevels([be(['light', 'high', 'extra_high'])])
  ok('E7a 四个元素', Array.isArray(levels) && levels.length === 4, String(levels?.length))
  ok('E7b 每项都有 level/word/mode',
    levels.every((x) => typeof x.level === 'string' && typeof x.word === 'string' && typeof x.mode === 'string'),
    JSON.stringify(levels))
  ok('E7c level 序列就是四档',
    levels.map((x) => x.level).join(',') === 'minimal,low,medium,max',
    levels.map((x) => x.level).join(','))
  ok('E7d max 落到该家最强词',
    levels.find((x) => x.level === 'max')?.word === 'extra_high',
    JSON.stringify(levels.find((x) => x.level === 'max')))
}

// ── E8 effortNote ──
section('E8 effortNote')
{
  const native = resolveChainLevel([be(['minimal', 'low', 'medium', 'max'])], 'max')
  const note = effortNote(native)
  ok('E8a native 不产生降级说明',
    note === undefined || !/degrad/i.test(String(note)), String(note))
  const deg = resolveChainLevel([], 'max')
  const dnote = effortNote(deg)
  ok('E8b degraded 要出声', typeof dnote === 'string' && dnote.length > 0, String(dnote))
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
