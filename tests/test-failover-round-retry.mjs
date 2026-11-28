#!/usr/bin/env node
/**
 * 守卫：1.1.3「全冷却不再直接 503」的整轮重试，以及最近新增的面板/拖拽修复。
 *
 * 这些都是「测试全绿、但功能悄悄退化」的盲区，所以用 lib 源码的形状钉死：
 *   · 两条故障转移执行器都要能撤销本轮冷却、复位状态、整轮再试一次
 *   · 流式路径在已经吐字后绝不重跑
 *   · 全冷却时按原序放行整条链，而不是直接返回不可用
 *   · 面板测速列与拖拽插入位置不能退回旧写法
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')
const index = readFileSync(join(LIB, 'index.js'), 'utf8')
const health = readFileSync(join(LIB, 'backend-health.js'), 'utf8')
const client = readFileSync(join(LIB, 'client.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

/** 按「函数/方法声明」把源码切成互不重叠的片段，避免断言误命中别处的同名字符串。 */
const section = (src, start, end) => {
  const s = src.indexOf(start)
  if (s < 0) return ''
  const e = end === undefined ? src.length : src.indexOf(end, s + start.length)
  return src.slice(s, e < 0 ? src.length : e)
}

const streamFn = section(index, 'async function* streamWithFailover(', 'async function collectWithFailover(')
const collectFn = section(index, 'async function collectWithFailover(', 'function summarizeCapabilities(')
const orderFn = section(index, 'function orderByHealth(', 'function triggerBackgroundSweep(')
const healthOrderFn = section(health, 'order(plans) {', 'clearCooldowns(plans) {')
const clearFn = section(health, 'clearCooldowns(plans) {', 'snapshot() {')

console.log('════════ A. 两条故障转移执行器都能整轮重试 ════════')
for (const [label, fn] of [
  ['流式 streamWithFailover', streamFn],
  ['非流式 collectWithFailover', collectFn],
]) {
  const retry = section(fn, 'fullRoundRetried = true', 'state.failure = finalFailure')
  ok(label + '：源码片段存在', fn.length > 0)
  ok(label + '：声明 fullRoundRetried', /let fullRoundRetried = false/.test(fn))
  ok(label + '：重试前调用 clearCooldowns(plans)', /clearCooldowns\?\.\(plans\)/.test(retry))
  ok(label + '：重试时 index = 0', /\bindex = 0\b/.test(retry))
  // budget 变量已随「同后端重试」一起删除；整轮重试的复位改为
  // 归零 attempts / round（避免对外报双倍尝试次数、retry 标记误报）。
  ok(label + '：重试时归零 attempts / round', /attempts\.length = 0/.test(retry) && /\bround = 0\b/.test(retry))
  ok(label + '：重试时还原 baseOptions', /baseOptions = originalBaseOptions/.test(retry))
}

console.log('')
console.log('════════ B. 流式：已吐字不重跑 + 请求级状态复位 ════════')
{
  ok('alreadyStreamed 由 committed 派生',
    /const alreadyStreamed = attempts\.some\(\(a\) => a\.committed === true\)/.test(streamFn))
  ok('整轮重试以「未吐字」为前提',
    /alreadyStreamed === false/.test(streamFn) && /fullRoundRetried === false/.test(streamFn))
  const retry = section(streamFn, 'fullRoundRetried = true', 'state.failure = finalFailure')
  ok('重试时 resumeText = ""', /resumeText = ''/.test(retry))
  ok('重试时 strippedOptions.clear()', /strippedOptions\.clear\(\)/.test(retry))
  ok('重试时 baseOptions = originalBaseOptions', /baseOptions = originalBaseOptions/.test(retry))
}

console.log('')
console.log('════════ C. orderByHealth：全冷却按原序放行 ════════')
{
  const branch = /ordered\.allCooling === true\)[\s\S]{0,4000}?return list/.exec(orderFn)
  const body = branch === null ? '' : branch[0]
  ok('全冷却分支 return list（不是 return []）', branch !== null && !/return\s*\[\]/.test(body))
  ok('全冷却分支仍调用 triggerBackgroundSweep(deps, list)', /triggerBackgroundSweep\(deps, list\)/.test(body))
  ok('orderByHealth 片段存在', orderFn.length > 0)
}

console.log('')
console.log('════════ D. backend-health：撤销冷却 + 全冷却标记 ════════')
{
  ok('存在 clearCooldowns(plans) 方法', /clearCooldowns\(plans\)\s*\{/.test(health))
  ok('clearCooldowns 清 cooldownUntil', /entry\.cooldownUntil = 0/.test(clearFn))
  ok('clearCooldowns 清 streak', /entry\.streak = 0/.test(clearFn))
  ok('clearCooldowns 清 breakStreak', /entry\.breakStreak = 0/.test(clearFn))
  ok('clearCooldowns 返回撤销条数', /return cleared/.test(clearFn))
  const branch = /healthy\.length === 0\)\s*\{([\s\S]*?)\n\s*\}/.exec(healthOrderFn)
  const body = branch === null ? '' : branch[0]
  ok('全冷却分支返回 allCooling:true，不再 return []',
    branch !== null && /allCooling:\s*true/.test(body) && !/return\s*\[\]/.test(body))
}

console.log('')
console.log('════════ E. 面板：测速列三列网格 + 拖拽插入无修正 ════════')
{
  ok('存在 .dim-lt-bindTestMs 样式', /\.dim-lt-bindTestMs\s*\{/.test(client))
  const msRule = /\.dim-lt-bindTestMs\s*\{([\s\S]*?)\}/.exec(client)
  ok('.dim-lt-bindTestMs 通过态规则不设 max-width', msRule !== null && !/max-width\s*:/.test(msRule[1]))
  ok('失败态才限宽（.dim-lt-bindTestMs.dim-lt-red 含 max-width）',
    /\.dim-lt-bindTestMs\.dim-lt-red\s*\{[^}]*max-width/.test(client))
  ok('.dim-lt-bindRow.dim-lt-bindRowTest 为三列网格',
    /\.dim-lt-bindRow\.dim-lt-bindRowTest\s*\{[\s\S]{0,200}grid-template-columns:\s*20px minmax\(0, 1fr\) auto/.test(client))
  ok('拖拽插入用 list.splice(to, 0, item)', /list\.splice\(to, 0, item\)/.test(client))
  ok('拖拽插入不做 to-1 修正', !/list\.splice\(to\s*-\s*1,\s*0,\s*item\)/.test(client))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0
