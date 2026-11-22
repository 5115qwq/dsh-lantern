// #230：DSH 消息构造守卫 —— `createSystemMessage` 必须**单参数 + 字符串**。
//
// ## 事故背景
//
// 用户实测「性能测试」报：`上游错误：content.some is not a function`
//
// 排查结论（两处都改）：
//   1. content 就该是 **string** —— DSH 内核自己全是
//      `createSystemMessage(rendered)` 单参数调用
//      （app.asar 里 @deepseek-ai/dsh-agent-loop 的用法）；
//   2. **不要传第二个参数** —— dsh-llm 的 stub 是
//      `createSystemMessage(t, p) => { content: t, provider: p }`，
//      而我们原来传的是 `'dsh-lantern-perftest'` 这种**不存在的 provider id**。
//      内核按 message.provider 归属归组时找不到 → content 被置空 → `.some()` TypeError。
//
// 对照证据：「功能测试」(`bindingTest`) 一直正常，因为它**没有 system message**，
// 只用 `createUserMessage({ content: [...] })`（对象 + 数组 content）。
//
// 本测试静态守住这两条规则。
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync, readdirSync } from 'node:fs'

const LIB = `${LANTERN_DIR}/lib`

let pass = 0
let fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

console.log('════════ DSH 消息构造守卫（#230）════════')
console.log('')

const files = readdirSync(LIB).filter((f) => f.endsWith('.js') && !f.includes('.bak'))

const arrayForm = []
const twoArgForm = []
let total = 0

for (const f of files) {
  const src = readFileSync(`${LIB}/${f}`, 'utf8')
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i]
    if (/^\s*(\/\/|\*)/.test(L)) continue
    if (!/createSystemMessage\s*\(/.test(L)) continue
    if (/import|const \{/.test(L)) continue
    total += 1

    // 取调用实参（可能跨行）
    const after = L.slice(L.indexOf('createSystemMessage') + 'createSystemMessage'.length)
    const multi = after.trim() === '(' || after.trim().endsWith('(')
    const argText = multi ? (lines[i + 1] ?? '') : after
    const trimmed = argText.trim().replace(/^\(/, '')

    // 规则 1：不能是数组
    if (trimmed.startsWith('[')) arrayForm.push({ file: f, line: i + 1, text: L.trim().slice(0, 80) })

    // 规则 2：不能有两个参数
    // 单参数形式形如 createSystemMessage(EXPR)  或  createSystemMessage('...')
    // 计数：去掉字符串字面量后，顶层逗号个数
    const stripped = trimmed.replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``')
    const inner = stripped.slice(0, stripped.lastIndexOf(')'))
    let depth = 0
    let commas = 0
    for (const ch of inner) {
      if ('([{'.includes(ch)) depth += 1
      else if (')]}'.includes(ch)) depth -= 1
      else if (ch === ',' && depth === 0) commas += 1
    }
    if (commas > 0) twoArgForm.push({ file: f, line: i + 1, text: L.trim().slice(0, 80) })
  }
}

t(`扫描到 ${total} 处 createSystemMessage 调用`, total > 0, { total })
t('全部用字符串 content（不传数组）', arrayForm.length === 0, arrayForm)
t('全部单参数（不传 provider id）', twoArgForm.length === 0, twoArgForm)

// 反向确认：createUserMessage 必须"对象 + 数组 content"
// ⚠ 只用**明确的错误形态**做判据（`createUserMessage([` 直接传数组）。
//    不要用 `createUserMessage(` 后面"不是 {" 当判据 —— 注释里提到过
//    `createUserMessage(input)` 这种说明文字，会造成误报（第一版就踩了）。
console.log('')
console.log('【参考】createUserMessage 的正确写法：对象 + content 数组')
let userObj = 0
let userArrayForm = 0
for (const f of files) {
  const src = readFileSync(`${LIB}/${f}`, 'utf8')
  userObj += (src.match(/createUserMessage\(\{\s*content:\s*\[/g) ?? []).length
  // 真错：把数组直接当参数传（#177 踩过的坑）
  userArrayForm += (src.match(/createUserMessage\(\s*\[/g) ?? []).length
}
t(`${userObj} 处 createUserMessage 用了对象+数组形式`, userObj > 0, { userObj })
t('没有 createUserMessage 直接传数组（#177 的坑）', userArrayForm === 0, { userArrayForm })

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0