// 静态检查：流式转发路径里不能有重复的 push / yield / write。
//
// 背景（第十八轮 #184）：`pending.push(chunk)` 曾被写成两行，
// 导致每一帧都发两遍 → 文本重复（TheThe）、tool_calls 重复 → 死循环。
// 这种 bug 不报错、不崩溃，回归测不出来，只能靠静态检查兜住。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync } from 'node:fs'

const LIB = `${LANTERN_DIR}/lib`
const FILES = ['index.js', 'protocol.js', 'messages.js', 'anthropic.js', 'responses.js']

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))) }
}

console.log('=== 静态检查：转发路径不能有重复行 ===')

for (const file of FILES) {
  const lines = readFileSync(`${LIB}/${file}`, 'utf8').split('\n')
  const dups = []
  for (let i = 0; i < lines.length - 1; i += 1) {
    const a = lines[i].trim()
    const b = lines[i + 1].trim()
    // 只看"会产出数据"的语句，且忽略纯注释、短语句
    if (a !== b || a.length < 10) continue
    if (!/push\(|yield |writeFrame|res\.write|frames\.push/.test(a)) continue
    if (a.startsWith('//') || a.startsWith('*')) continue
    dups.push({ line: i + 1, code: a })
  }
  t(`${file} 无重复转发语句`, dups.length === 0, dups)
}

console.log('\n=== 语义检查：pending 只用一行 push ===')
{
  const src = readFileSync(`${LIB}/index.js`, 'utf8')
  const matches = src.match(/^\s*pending\.push\(chunk\)\s*$/gm) ?? []
  t('index.js 中 pending.push(chunk) 恰好 1 处', matches.length === 1, { count: matches.length })
}

console.log('\n=== 语义检查：每个 pending 提交点都必须清空或立即返回 ===')
{
  const src = readFileSync(`${LIB}/index.js`, 'utf8')
  const lines = src.split('\n')
  const problems = []
  let yields = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (!/for \(const buffered of pending\) yield buffered/.test(lines[i])) continue
    if (lines[i].trim().startsWith('//')) continue   // 注释里的说明不算
    yields += 1
    // 提交后必须满足其一：紧随的几行里清空 pending，或者直接 return
    const tail = lines.slice(i, i + 4).join('\n')
    const cleared = /pending\.length = 0/.test(tail)
    const returned = /^\s*return\b/m.test(tail)
    if (!cleared && !returned) problems.push({ line: i + 1, snippet: lines[i].trim() })
  }
  t('每处 yield pending 后都清空或立即 return', problems.length === 0, { yields, problems })
}

console.log('\n=== 语义检查：writeFrame 是唯一写流出口 ===')
{
  const src = readFileSync(`${LIB}/index.js`, 'utf8')
  // 除了 writeFrame 定义内部，不应有裸 res.write(frame)
  const bare = (src.match(/res\.write\(frame\)/g) ?? []).length
  t('没有裸 res.write(frame)（应走 writeFrame）', bare <= 1, { bare })
}

console.log(`\n═══ ${pass} passed / ${fail} failed ═══`)
process.exitCode = fail > 0 ? 1 : 0
