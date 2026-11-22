// 面板字段完整性自检：client.js 里 `usage.X` 的每个引用，RPC 都必须返回。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const LIB = `${LANTERN_DIR}/lib`

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 200))) }
}

const client = readFileSync(`${LIB}/client.js`, 'utf8')
const rpc = readFileSync(`${LIB}/rpc.js`, 'utf8')

console.log('════════ 面板字段完整性 ════════')
console.log('')

// ── 1. state 变量的作用域自检（#236 的核心教训）──
console.log('【1】state 变量作用域（防"依赖数组引用了别的组件的 state"）')
{
  // 找到所有 StatusPage / ProviderPage / CustomModelsPage / LanternPage 的边界
  const lines = client.split('\n')
  const comps = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^    function (\w+)\(props\)/.exec(lines[i])
    if (m) {
      // 找该函数的结束（下一行的 `    }` 且缩进为 4）
      let end = lines.length
      for (let k = i + 1; k < lines.length; k += 1) {
        if (/^    \}$/.test(lines[k])) { end = k; break }
      }
      comps.push({ name: m[1], start: i + 1, end })
    }
  }
  console.log(`    组件: ${comps.map((c) => `${c.name}(${c.start}-${c.end})`).join(' ')}`)

  const inComp = (line, name) => {
    const c = comps.find((x) => x.name === name)
    return c !== undefined && line >= c.start && line <= c.end
  }

  // 收集每个组件的 useState 变量
  const stateVars = new Map() // varName -> componentName
  for (const c of comps) {
    for (let i = c.start - 1; i < c.end; i += 1) {
      const m = /const \[(\w+), set(\w+)\] = React\.useState/.exec(lines[i])
      if (m) stateVars.set(m[1], c.name)
    }
  }
  console.log(`    state 变量: ${[...stateVars.keys()].join(', ')}`)

  // 检查每个依赖数组 `}, [a, b])` 里的变量引用
  const bad = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s{6}\}, \[([^\]]*)\]\)/.exec(lines[i])
    if (!m || m[1].trim() === '') continue
    const names = m[1].split(',').map((x) => x.trim()).filter(Boolean)
    for (const n of names) {
      if (!stateVars.has(n)) continue // 不是 state（可能是 useCallback 的返回值等），跳过
      const owner = stateVars.get(n)
      if (!inComp(i + 1, owner)) {
        bad.push({ line: i + 1, name: n, owner, deps: m[1] })
      }
    }
  }
  t('依赖数组里的 state 都在自己组件内声明', bad.length === 0, bad)

  // 反向：usageRange 只应在 StatusPage 内
  const urRefs = []
  lines.forEach((L, i) => { if (/\busageRange\b/.test(L) && !/^\s*(\/\/|\*)/.test(L)) urRefs.push(i + 1) })
  const urOutside = urRefs.filter((ln) => !inComp(ln, 'StatusPage'))
  t('usageRange 只在 StatusPage 内引用', urOutside.length === 0, urOutside)
}

// ── 2. usage 字段完整性 ──
console.log('')
console.log('【2】usage.* 字段与 RPC 返回对齐')
{
  const used = new Set()
  for (const m of client.matchAll(/\busage\.(\w+)/g)) used.add(m[1])
  console.log(`    面板引用: ${[...used].sort().join(', ')}`)

  // RPC 的 usage/summary 返回字段：取 okEnvelope({ ... }) 里 usage 分支的顶层键
  const i = rpc.indexOf("case 'usage/summary':")
  const j = rpc.indexOf("case '", i + 10)
  const block = rpc.slice(i, j)
  const provided = new Set()
  for (const m of block.matchAll(/^\s{10}(\w+):/gm)) provided.add(m[1])
  console.log(`    RPC 返回: ${[...provided].sort().join(', ')}`)

  const missing = [...used].filter((k) => !provided.has(k) && k !== 'cards' && k !== 'empty' && k !== 'totals' && k !== 'keys'
    && k !== 'models' && k !== 'kinds' && k !== 'cross' && k !== 'requested' && k !== 'monthDailyAvg'
    && k !== 'modelTrends' && k !== 'rangeDays' && k !== 'rangeFrom' && k !== 'rangeTo' && k !== 'modelCount')
  t('无未知字段引用', missing.length === 0, missing)

  const need = ['totals', 'keys', 'kinds', 'models', 'cross', 'requested', 'modelCount', 'monthDailyAvg', 'modelTrends', 'rangeDays']
  const notProvided = need.filter((k) => !provided.has(k))
  t('RPC 提供了全部必需字段', notProvided.length === 0, notProvided)
}

// ── 3. 关键标识符是否都有定义 ──
console.log('')
console.log('【3】关键函数定义')
for (const fn of ['fmtTime', 'fmtAgo', 'fmtMTokens', 'unwrap', 'installStyles', 'MiniStat', 'Pill', 'Notice', 'Modal']) {
  const defRe = new RegExp(`function ${fn}\\(|const ${fn} = `)
  t(`${fn} 有定义`, defRe.test(client))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0