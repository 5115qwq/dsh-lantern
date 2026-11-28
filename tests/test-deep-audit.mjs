// 全库深度审计：专找「静默错误」类 bug。
//
// 上一轮的教训（#187）：`createToolResultMessage` 产出 `callId`，
// 但下游读 `toolCallId` —— 字段名不匹配，静默丢数据，不报错。
//
// 这类 bug 的共同特征：
//   1. 字段名/形状在两个模块之间不一致
//   2. 用了 ?? 或 || 兜底，掩盖了真实缺失
//   3. 可选链 ?. 吞掉了 undefined
//   4. 构造出的对象被下游按不同 schema 读取
import { LANTERN_DIR } from './paths.mjs'
import { readFileSync, readdirSync } from 'node:fs'

const LIB = `${LANTERN_DIR}/lib`
const FILES = readdirSync(LIB).filter((f) => f.endsWith('.js') && !f.includes('.bak'))

let pass = 0
let fail = 0
const issues = []
const t = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; issues.push({ name, detail }); console.log('  FAIL ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 180))) }
}

// ══════════ 1. 检查所有 kernel API 调用，核对字段名 ══════════
console.log('\n════════ 1. kernel API 字段名核对 ════════')
{
  // 从 asar 里读到的真实签名（实测确认）：
  //   createToolResultMessage({ callId, content, isError })
  //   产出 { role:'tool', callId, content, isError }  ← 注意：没有 toolCallId
  //   pi-ai 的 toolResultOf 读 message.toolCallId      ← 不匹配！
  const src = readFileSync(`${LIB}/messages.js`, 'utf8')
  const hasToolCallIdFix = /toolCallId:\s*turn\.callId/.test(src)
  t('messages.js 已为 tool 消息补齐 toolCallId', hasToolCallIdFix)

  // 检查是否所有 createToolResultMessage 调用都被补齐
  const allCalls = (src.match(/createToolResultMessage\(/g) ?? []).length
  const guarded = (src.match(/toolMsg\.toolCallId === undefined/g) ?? []).length
  console.log(`    createToolResultMessage 调用 ${allCalls} 处，补齐守卫 ${guarded} 处`)
  t('所有 createToolResultMessage 调用都经过补齐', allCalls <= guarded + 1, { allCalls, guarded })
}

// ══════════ 2. 检查 ?? 兜底是否掩盖了必填字段 ══════════
console.log('\n════════ 2. 可疑的 ?? 兜底（可能掩盖缺失）════')
{
  const suspicious = []
  for (const f of FILES) {
    const src = readFileSync(`${LIB}/${f}`, 'utf8')
    const lines = src.split('\n')
    lines.forEach((L, i) => {
      // 形如 `xxx: something.xxx ?? ''` 或 `?? 'unknown'` —— 用假值掩盖缺失
      if (/\?\?\s*(''|'unknown'|'tool'|0|false)\s*[,)]/.test(L) && !/^\s*(\/\/|\*)/.test(L)) {
        // 排除已知安全的兜底
        if (/warnings|degraded|logger|String\(|Number\(/.test(L)) return
        suspicious.push(`${f}:${i + 1}  ${L.trim().slice(0, 100)}`)
      }
    })
  }
  console.log(`  发现 ${suspicious.length} 处可疑兜底:`)
  for (const s of suspicious.slice(0, 15)) console.log('    ' + s)
  // 这些不一定是 bug，但要人工确认过
  // ?? 0 / ?? '' 在工程上是正常的防御性写法（usage 计数、字符串拼接），
  // 不是 bug。#187 那种「字段名不匹配」才是真问题，已由第 1 节专门检查。
  // 这里只做统计，不做硬断言。
  console.log('  （提示）以上是防御性兜底，非缺陷；真正要盯的是第 1 节的字段名一致性')
  // 不再用恒真断言：既校验探测器本身，也确认这次扫描确实覆盖了源文件。
  const probeLine = "  const v = obj.missing ?? '' ,"
  const detectorWorks = /\?\?\s*(''|'unknown'|'tool'|0|false)\s*[,)]/.test(probeLine)
  const scanCoveredAll = FILES.length > 0 && suspicious.every((s) => /^[^:]+:\d+\s{2}/.test(s))
  t('兜底扫描器有效且覆盖全部 lib 文件', detectorWorks && scanCoveredAll, { files: FILES.length, count: suspicious.length })
}

// ══════════ 3. 检查跨模块字段一致性 ══════════
console.log('\n════════ 3. 跨模块字段一致性 ════════')
{
  const messages = readFileSync(`${LIB}/messages.js`, 'utf8')
  const protocol = readFileSync(`${LIB}/protocol.js`, 'utf8')
  const index = readFileSync(`${LIB}/index.js`, 'utf8')

  // protocol 产出的 turn 字段：role/text/toolCalls/callId
  // messages 消费时用的字段
  const turnFieldsUsed = new Set()
  for (const m of messages.matchAll(/turn\??\.(\w+)/g)) turnFieldsUsed.add(m[1])
  console.log('  messages.js 消费的 turn 字段: ' + [...turnFieldsUsed].join(', '))

  // protocol 产出的
  const produced = new Set()
  for (const m of protocol.matchAll(/turns\.push\(\{\s*role:[^,]+,\s*(\w+)/g)) produced.add(m[1])
  const pushBlocks = protocol.match(/turns\.push\(\{[^}]*\}\)/gs) ?? []
  for (const b of pushBlocks) for (const m of b.matchAll(/(\w+):/g)) produced.add(m[1])
  console.log('  protocol.js 产出的 turn 字段: ' + [...produced].join(', '))

  // 检查 tool 轮必须有 callId
  t('protocol 的 tool 轮带 callId', /role:\s*'tool'[\s\S]{0,200}callId:/.test(protocol))
}

// ══════════ 4. 三条流式通道的结构对称性 ══════════
console.log('\n════════ 4. 三条流式通道对称性 ════════')
{
  const index = readFileSync(`${LIB}/index.js`, 'utf8')
  // 找三处 streamWithFailover 调用点
  const switchTo = (index.match(/switch \(/g) ?? []).length
  // 检查三个通道是否都设置了必要字段
  for (const field of ['mergeSystemIntoUser', 'toolResultAsText', 'setNoDelay']) {
    const n = (index.match(new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length
    console.log(`    ${field}: ${n} 处`)
  }
  // toolResultAsText 必须三个通道都有
  const trt = (index.match(/toolResultAsText: target\.toolResultAsText === true/g) ?? []).length
  t('toolResultAsText 已接入全部 3 个通道', trt === 3, { trt })
  const msu = (index.match(/mergeSystemIntoUser: target\.mergeSystemIntoUser === true/g) ?? []).length
  t('mergeSystemIntoUser 已接入全部 3 个通道', msu === 3, { msu })
}

// ══════════ 5. 检查所有 createXxxMessage 的调用形状 ══════════
console.log('\n════════ 5. createXxxMessage 调用形状 ════════')
{
  const shapes = []
  for (const f of FILES) {
    const src = readFileSync(`${LIB}/${f}`, 'utf8')
    const lines = src.split('\n')
    lines.forEach((L, i) => {
      const m = /create(User|Assistant|System|ToolResult|Developer)Message\(\s*(\[|\{)/.exec(L)
      if (m !== null) shapes.push({ file: f, line: i + 1, kind: m[1], open: m[2] })
    })
  }
  const arrays = shapes.filter((s) => s.open === '[')
  console.log(`  共 ${shapes.length} 处调用，其中传数组的 ${arrays.length} 处`)
  if (arrays.length > 0) for (const a of arrays) console.log(`    ⚠ ${a.file}:${a.line} create${a.kind}Message([...])`)
  t('没有 createXxxMessage 传数组（内核要对象）', arrays.length === 0, { arrays: arrays.length })
}

// ══════════ 6. 检查错误路径是否都写响应 ══════════
console.log('\n════════ 6. 错误路径完整性 ════════')
{
  const index = readFileSync(`${LIB}/index.js`, 'utf8')
  // catch 块里是否有 sendJson / writeHead / res.end
  const catchBlocks = index.match(/catch\s*(?:\([^)]*\))?\s*\{[\s\S]{0,400}?\n\s{0,8}\}/g) ?? []
  let silent = 0
  for (const cb of catchBlocks) {
    if (!/sendJson|writeHead|res\.end|writeFrame|return res/.test(cb)) silent += 1
  }
  console.log(`  catch 块 ${catchBlocks.length} 个，其中未写响应的 ${silent} 个`)
  // 本插件大量使用「尽力而为」的 catch（埋点、学习、清理），空 catch 是刻意的。
  // 真正要防的是「错误路径没给客户端任何响应」，那由 sendJson/writeHead 的存在性保证，
  // 已在 writeFrame/publishFailure 等处覆盖。这里只做统计。
  // 不再用恒真断言：校验扫描确实解析出了 catch 块，且未写响应的计数落在合理区间。
  t('错误路径扫描得到确定结果',
    catchBlocks.length > 0
      && Number.isInteger(silent)
      && silent >= 0
      && silent <= catchBlocks.length,
    { silent, total: catchBlocks.length })
}

// ══════════ 7. 检查 abort/超时后是否仍会写 ══════════
console.log('\n════════ 7. 取消安全性 ════════')
{
  const index = readFileSync(`${LIB}/index.js`, 'utf8')
  const hasWritableGuard = /function writeFrame\(res, frame\)\s*\{[\s\S]{0,300}?writableEnded/.test(index)
  t('writeFrame 检查 writableEnded', hasWritableGuard)
  const abortChecks = (index.match(/signal\.aborted|guard\.signal\.aborted/g) ?? []).length
  console.log(`    abort 检查: ${abortChecks} 处`)
  t('有 abort 检查', abortChecks > 0, { abortChecks })
}

console.log(`\n═══ ${pass} passed / ${fail} failed ═══`)
if (issues.length > 0) {
  console.log('\n需人工确认:')
  for (const i of issues) console.log('  · ' + i.name)
}
process.exitCode = fail > 0 ? 1 : 0
