#!/usr/bin/env node
/**
 * 守卫：失效绑定可移除 + 用量不显示匿名/下线
 *
 * 这三条都是"看起来只是显示问题、实际让用户卡住"的缺陷：
 *   1. 绑定失效后不在候选下拉里 → 用户**无法移除**（数据死锁）
 *   2. 未开启匿名访问，用量表里却有一行「匿名访问」
 *   3. 模型已从绑定里删除，用量表里还留着它的排行
 *
 * 它们都不会让测试报错，只在真实使用中才暴露 —— 所以用源码形状钉死。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')

const client = readFileSync(join(LIB, 'client.js'), 'utf8')
const usage = readFileSync(join(LIB, 'usage.js'), 'utf8')
const rpc = readFileSync(join(LIB, 'rpc.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

console.log('════════ A. 失效绑定必须可移除 ════════')
{
  // 失效项在候选里找不到，所以必须有独立按钮
  ok('BindingRow 有失效移除按钮',
    /ok === false[\s\S]{0,200}bindRemoveBtn/.test(client))
  ok('按钮调用 onRemove',
    /bindRemoveBtn[\s\S]{0,320}onRemove\(index\)/.test(client))
  ok('有对应 CSS',
    client.includes('.dim-lt-bindRemoveBtn'))
  // 健康的项不需要额外按钮（避免占位）
  ok('只在失效时渲染',
    /ok === false && onRemove !== undefined/.test(client))

  // ⚠ 关键回归：绑定列表是常驻的，回调不能只在"展开"时才有动作。
  // 曾经的写法是 `onRemove: open ? (idx) => {...} : () => {}` ——
  // 收起状态下点 ✕ 进空函数，表现为"点了没反应"（用户实测）。
  ok('onRemove 收起态也生效（不依赖 open）',
    /onRemove: \(idx\) => \{[\s\S]{0,500}Array\.isArray\(m\.bindings\)/.test(client))
  ok('onRemove 不再有空函数分支',
    !/onRemove: open\s*\n?\s*\?/.test(client))
  ok('onMove 同样不再有空函数分支',
    !/onMove: open\s*\n?\s*\?/.test(client))
}

console.log('')
console.log('════════ B. 用量表默认不显示匿名 ════════')
{
  ok('面板 keys 过滤排除 anonymous',
    /k\.id !== 'anonymous'/.test(client))
  ok('面板 keys 过滤排除 unknown',
    /k\.id !== 'unknown'/.test(client))
  ok('报表 Key 表排除 anonymous',
    /x\.id !== 'anonymous'/.test(usage))
  // 统计口径要与过滤一致
  ok('折叠提示的统计含匿名',
    /k\.id === 'anonymous' \|\| k\.id === 'unknown'/.test(client))
}

console.log('')
console.log('════════ C. 用量表默认不显示已下线模型 ════════')
{
  ok('面板 models 过滤 offline',
    /showStale \|\| x\.offline !== true/.test(client))
  ok('报表 models 只留 online',
    /\.filter\(\(x\) => x\.live\)/.test(usage))
  ok('服务端先过滤再截断（不被下线项挤占 Top12）',
    /online\.slice\(0, 12\)\.concat\(offline\.slice\(0, 12\)\)/.test(rpc))
  ok('modelCount 只算在线',
    /rows\.filter\(\(x\) => live\.has\(x\.name\)\)\.length/.test(rpc))
}

console.log('')
console.log('════════ D. 开关仍能看历史（不是硬删）════════')
{
  ok('showStale 开关存在', client.includes('const [showStale, setShowStale] = React.useState(false)'))
  ok('开关能放开 keys 过滤', /showStale \|\| \(k\.deleted !== true/.test(client))
  // 独立验证开关本身：checkbox 必须真的读写 showStale，否则过滤里的
  // showStale 永远为 false，历史条目无法展开（与 C 节的过滤正则区分开）。
  ok('开关能放开 models 过滤（checkbox 双向绑定 showStale）',
    /checked: showStale[\s\S]{0,200}onChange: \(e\) => setShowStale\(e\.target\.checked\)/.test(client))
}

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0