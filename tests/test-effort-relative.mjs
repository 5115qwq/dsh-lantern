// 第十一轮：四档从"字面匹配"改成"相对位置"后的语义护栏。
//
// 用户的原话是判据：
//   "设 max 肯定是最高了，轮询的模型肯定是按照他们的可选推理档位参数，
//    那我们就对照着来呗 —— 选 max 就是 xhigh、就是 extra_high"
//
// 所以核心断言只有一条：**用户选 max，每个后端都要拿到它自己最强的那档。**
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const P = `${LANTERN_DIR}/lib/`
const mod = await import('file:///' + P + 'effort-contract.js')
const { CONTRACT_LEVELS, toContractLevel, mapLevelToBackend, resolveChainLevel, rankOf } = mod

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + detail)) }
}

console.log('=== L1 四档改名：最高档叫 max ===')
t('L1a 四档是 minimal/low/medium/max',
  JSON.stringify(CONTRACT_LEVELS) === JSON.stringify(['minimal', 'low', 'medium', 'max']),
  JSON.stringify(CONTRACT_LEVELS))
t('L1b 旧名 high 向后兼容 -> max', toContractLevel('high') === 'max')
t('L1c xhigh/extra_high 也归到 max',
  toContractLevel('xhigh') === 'max' && toContractLevel('extra_high') === 'max')

console.log('\n=== L2 用户的核心诉求：选 max 就是该家最强 ===')
const REAL = {
  'glm-5.3': ['low', 'high', 'max', 'light', 'extra_high', 'none', 'medium', 'xhigh'],
  'Qwen-3.8-Max': ['none', 'low', 'medium', 'high', 'xhigh'],
  'Seed-2.1-Pro': ['light', 'high'],
  hy4: ['high', 'low', 'medium', 'xhigh', 'max'],
  'deepseek-v4.1-flash': ['light', 'high', 'extra_high', 'none', 'low', 'medium', 'xhigh'],
  // 一个只有三档的假想后端
  tiny: ['low', 'medium', 'high'],
}
for (const [name, efforts] of Object.entries(REAL)) {
  const r = mapLevelToBackend(efforts, 'max')
  // 该家最强的那档 = 词表里 rank 最大的那个
  const strongest = efforts.reduce((a, b) => ((rankOf(b) ?? -1) > (rankOf(a) ?? -1) ? b : a))
  t(`L2 max -> ${name} 的最强档（${strongest}）`, r.ok && r.word === strongest,
    `got=${r.word} want=${strongest} pos=${r.position}/${r.total}`)
}

console.log('\n=== L3 其余三档也按位置落位 ===')
{
  const qwen = REAL['Qwen-3.8-Max']  // 词表含 none，但 none 是「关思考」不是强度档
  // #160：off/none/disabled 被排除出分位池。实测 minimal→none 会让某些上游
  // 挂死 100 秒后返空。所以 minimal 现在落 low（池里最弱的真·强度档）。
  t('L3a minimal -> 最弱的**强度档**（不含 none/off）',
    !['none', 'off', 'disabled'].includes(mapLevelToBackend(qwen, 'minimal').word),
    mapLevelToBackend(qwen, 'minimal').word)
  // #161：medium 的目标位置是 2/3（不是 1/2）。
  // 这样在池 ≥4 档时它能落到真正的"中间偏上"而不是正好撞到 high 的下一档；
  // 在 4 档池 [low,medium,high,xhigh] 上 medium 落 index 2 = high，这是
  // 均匀分布的正确结果（2/3 × 3 = 2）。
  // 断言改成"medium 不比 low 弱、且不比 max 强"，不再钉死某个词。
  const midW = mapLevelToBackend(qwen, 'medium').word
  const lowW = mapLevelToBackend(qwen, 'low').word
  const maxW = mapLevelToBackend(qwen, 'max').word
  t('L3b medium 落在 low 与 max 之间（不在两端）',
    qwen.indexOf(midW) > qwen.indexOf(lowW) && qwen.indexOf(midW) < qwen.indexOf(maxW),
    `${lowW} < ${midW} < ${maxW}`)
  t('L3c low -> 不落到开关档', !['none', 'off', 'disabled'].includes(mapLevelToBackend(qwen, 'low').word),
    mapLevelToBackend(qwen, 'low').word)
  t('L3c2 max -> 拿到最强（xhigh）',
    mapLevelToBackend(qwen, 'max').word === 'xhigh', mapLevelToBackend(qwen, 'max').word)
  const onlySwitch = ['none', 'off']
  t('L3c3 只有开关档时**不下发**（#223：不能把开关当强度档）',
    mapLevelToBackend(onlySwitch, 'minimal').ok === false && mapLevelToBackend(onlySwitch, 'minimal').reason === 'switch-only',
    mapLevelToBackend(onlySwitch, 'minimal').word)

  // 两档后端：light < high
  const seed = REAL['Seed-2.1-Pro']
  t('L3d 两档后端 minimal -> light', mapLevelToBackend(seed, 'minimal').word === 'light')
  t('L3e 两档后端 max -> high', mapLevelToBackend(seed, 'max').word === 'high')
  t('L3f 两档后端 medium 落在两者之一（都算合理）',
    ['light', 'high'].includes(mapLevelToBackend(seed, 'medium').word))
}

console.log('\n=== L4 位置信息必须外显（用户要能看到"是不是最高"）===')
{
  const r = mapLevelToBackend(REAL['hy4'], 'max')  // [high,low,medium,xhigh,max] 排序后 5 档
  t('L4a max 的 position 等于总档数（就是最后一档）', r.position === r.total,
    `pos=${r.position} total=${r.total} word=${r.word}`)
  const r2 = mapLevelToBackend(REAL['hy4'], 'minimal')
  t('L4b minimal 的 position 是 1', r2.position === 1, `pos=${r2.position} word=${r2.word}`)
}

console.log('\n=== L5 scaled 不是降级（不该再报"没有后端精确支持"）===')
{
  // 认不出强度的私有词（turbo）**不参与分位**：它既不该被当成最强，
  // 也不该顶掉真正的最强档。所以 ['low','turbo'] 选 max 会落到 low。
  // 这是刻意的保守方向 —— 宁可承认"我只知道它有 low"，也不假装 turbo 是最强。
  const resolved = resolveChainLevel([{ label: '#1', efforts: ['low', 'turbo'] }], 'max')
  // #167：认不出的私有词不再被一脚踢出池子。
  // `['low','turbo']` 里 `low` 认得出、`turbo` 认不出——但认得出的只有 1 个，
  // 不足以表达档位差，于是按原位置把 `turbo` 并回来（池 = [low, turbo]）。
  // 选 max 就落到最后一个 = `turbo`。这是对的：厂商把它排在 low 之后，
  // 相信厂商自己的顺序，比"当作不存在"更接近真实。
  t('L5a 私有词按原位置并入池（#167）', resolved.word === 'turbo', resolved.word)
  // 全表一个都认不出时才退回裸分位
  const allUnknown = resolveChainLevel([{ label: '#1', efforts: ['turbo', 'ultra'] }], 'max')
  t('L5b 全表认不出时退回裸分位（取最后一个）', allUnknown.word === 'ultra', allUnknown.word)
  const note = mod.effortNote(resolved)
  // scaled 不该产生"降级"note：它不是降级，只是档名叫法不是标准词
  t('L5c scaled 不报降级（它不是降级）', note === undefined, String(note))
  // 真正该报 note 的是单档词表（#163）
  const single = resolveChainLevel([{ label: '#1', efforts: ['turbo'] }], 'max')
  t('L5c2 单档词表要出声（#163 降级可见）',
    single.word === undefined && typeof mod.effortNote(single) === 'string',
    `${single.word}/${mod.effortNote(single)}`)
  t('L5d degraded 才算偏差（整链无词表）',
    mod.effortNote(resolveChainLevel([{ label: '#1', efforts: [] }], 'max')) !== undefined)
  t('L5e 词表里真有 max 时 mode=native',
    resolveChainLevel([{ label: '#1', efforts: ['low', 'max'] }], 'max').mode === 'native')
  t('L5f xhigh 也算法定标准词（native）',
    resolveChainLevel([{ label: '#1', efforts: ['low', 'xhigh'] }], 'max').mode === 'native')

  // 混着未知词时，真正的最强档仍然要被选中
  const mixed = resolveChainLevel([{ label: '#1', efforts: ['low', 'turbo', 'xhigh'] }], 'max')
  t('L5g 混有未知词时 max 仍取 xhigh（不被打断）', mixed.word === 'xhigh', mixed.word)
}

console.log('\n=== L6 多后端聚合：票数相同取更强 ===')
{
  const resolved = resolveChainLevel([
    { label: '#1', efforts: ['low', 'medium', 'high'] },        // max -> high
    { label: '#2', efforts: ['low', 'medium', 'xhigh'] },       // max -> xhigh
  ], 'max')
  t('L6a 两个不同词时取更强的（xhigh > high）', resolved.word === 'xhigh', resolved.word)
  const same = resolveChainLevel([
    { label: '#1', efforts: ['low', 'high'] },
    { label: '#2', efforts: ['light', 'high'] },
  ], 'max')
  t('L6b 两个都是 high 时用 high', same.word === 'high', same.word)
}

console.log('\n=== L7 大小写与未知词 ===')
{
  t('L7a MAX 大写也认', mapLevelToBackend(['low', 'max'], 'MAX').word === 'max')
  t('L7b 词表里的大写项也能被选中',
    mapLevelToBackend(['low', 'XHIGH'], 'max').word === 'XHIGH')
  t('L7c 完全空词表 -> empty-list', mapLevelToBackend([], 'max').reason === 'empty-list')
  t('L7d 未知契约档 -> unknown-level', mapLevelToBackend(['low'], 'banana').reason === 'unknown-level')
}

console.log('\n=== L8 index.js 接线 ===')
{
  const idx = readFileSync(P + 'index.js', 'utf8')
  t('L8a 三态判断已含 scaled',
    idx.includes("resolved.mode === 'native' || resolved.mode === 'scaled'"))
  t('L8b 外显 Position 头', idx.includes("headers['X-Lantern-Effort-Position']"))
  t('L8c Position 头在 CORS 暴露表里', idx.includes("'X-Lantern-Effort-Position'"))
}

console.log('\nALL PASS: ' + pass + ' passed / ' + fail + ' failed')
if (fail > 0) process.exitCode = 1
