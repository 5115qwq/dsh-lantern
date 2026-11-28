#!/usr/bin/env node
/**
 * 守卫：用量统计的**所有**表格都要默认隐藏匿名 / 已删除 / 已下线条目。
 *
 * 真实事故：上一轮只给「按 Key」「按模型」两张表加了过滤，
 * 漏了「Key × 模型」交叉表 —— 面板里（匿名访问）行铺满整张表，
 * 而折叠提示却说「已隐藏 1 个 Key」。
 *
 * 另一个坑：交叉表的 model 是 **上游真实模型名**（agg.cells 的 model），
 * 不是「按模型」表里的用户请求名。拿自定义模型名集合判 offline 会把
 * 整张表都标成下线并隐藏，所以这里也钉死「交叉表不按模型判 offline」。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const LIB = join(here, '..', 'lib')
const client = readFileSync(join(LIB, 'client.js'), 'utf8')
const rpc = readFileSync(join(LIB, 'rpc.js'), 'utf8')
const usage = readFileSync(join(LIB, 'usage.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name) }
  else { fail += 1; console.log('  ✗ ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 160))) }
}

// 取 cross 的构造块
const crossStart = rpc.indexOf('cross: (() => {')
const crossEnd = rpc.indexOf('// #228：环比', crossStart)
const cross = crossStart >= 0 && crossEnd > crossStart ? rpc.slice(crossStart, crossEnd) : ''

console.log('════════ A. 交叉表服务端标记 ════════')
ok('cross 构造块存在', cross.length > 0)
ok('有 isStaleKey 判定', cross.includes('const isStaleKey'))
ok('活跃/历史分开取', cross.includes('const active = rows.filter((r) => !isStaleKey(r.keyId))')
  && cross.includes('const activeSet = new Set(active)'))
ok('每行有 deleted 标记', cross.includes('deleted: isStaleKey(r.keyId)'))
// ⚠ 关键回归：不能用自定义模型名集合判交叉表的 offline
ok('交叉表不按模型判 offline', !cross.includes('live.has(r.model)') && !cross.includes('offline:'))

console.log('')
console.log('════════ B. 面板三张表都有过滤 ════════')
{
  const modelTbody = client.indexOf('usage.models\n')
  const keyTbody = client.indexOf('usage.keys\n')
  const crossTbody = client.indexOf('usage.cross\n')
  ok('按模型表过滤 offline', /usage\.models[\s\S]{0,300}\.filter\(\(x\) => showStale \|\| x\.offline !== true\)/.test(client))
  ok('按 Key 表过滤匿名/删除', /usage\.keys[\s\S]{0,400}k\.deleted !== true && k\.id !== 'anonymous'/.test(client))
  ok('交叉表过滤匿名/删除', /usage\.cross[\s\S]{0,700}x\.deleted !== true[\s\S]{0,200}x\.keyId !== 'anonymous'/.test(client))
  ok('交叉表过滤条件不含 x.offline', !/\.filter\(\(x\) => showStale \|\| \([\s\S]{0,200}x\.offline/.test(client))
  ok('三个渲染点都存在', modelTbody > 0 && keyTbody > 0 && crossTbody > 0)
}

console.log('')
console.log('════════ C. 报表 HTML 也过滤 ════════')
ok('报表 Key 表排除匿名', /x\.id !== 'anonymous'/.test(usage))
ok('报表模型表只留在线', /\.filter\(\(x\) => x\.live\)/.test(usage))
ok('报表内嵌 JSON 全量转义 <', usage.includes('replace(/</g'))

console.log('')
console.log('════════ D. 折叠提示统计口径 ════════')
ok('统计含匿名/未知/内部测试 Key', /k\.deleted === true \|\| k\.id === 'anonymous' \|\| k\.id === 'unknown' \|\| k\.id === 'internal'/.test(client))
ok('统计含下线模型', /m\.offline === true/.test(client))
ok('提示文案说明含内部测试', client.includes('其中含内部功能测试或未带 Key 的请求'))

console.log('')
console.log('════════ D2. 内部功能测试不再伪装成匿名访问 ════════')
{
  // 真实事故：面板自己发的功能测试探针（capabilities.onUsage）拿不到 key，
  // recordCall 落成 keyId='anonymous'，用户以为有人绕过鉴权在用额度。
  // 归一化已收紧：只在「本来就没有 Key」时把探测归到 internal，
  // 带真实 Key 的 test/perf 记录必须保留原 keyId（否则真实用量会被吞）。
  ok('聚合层条件归一化 internal',
    /const rawKey = String\(rec\.keyId \?\? 'anonymous'\)/.test(usage)
    && /rawKey === 'anonymous'\s*\?\s*'internal'/.test(usage))
  ok('聚合层无重复 const kind 声明', (usage.match(/const kind = String\(rec\.kind/g) ?? []).length === 1)
  ok('报表显示名含内部功能测试', usage.includes("id === 'internal') return { label: '（内部功能测试）'"))
  ok('面板显示名含内部功能测试', rpc.includes("id === 'internal') return { label: '（内部功能测试）'"))
  ok('报表 Key 表排除 internal', usage.includes("x.id !== 'internal'"))
  ok('keys deleted 判定统一为「非活跃 Key」', rpc.includes('deleted: !keyLabels.has(k.id)'))
  ok('cross isStaleKey 排除 internal', rpc.includes("id === 'internal' || !keyLabels.has(id)"))
  ok('按 Key 表过滤 internal', /usage\.keys[\s\S]{0,500}k\.id !== 'internal'/.test(client))
  ok('交叉表过滤 internal', /usage\.cross[\s\S]{0,700}x\.keyId !== 'internal'/.test(client))
  ok('探测源头显式给 key', /kind: 'test',[\s\S]{0,220}key: \{ id: 'internal'/.test(readFileSync(join(LIB, 'index.js'), 'utf8')))
}

console.log('')
console.log('════════ E. 过时文案 ════════')
ok('不再写「用 ↑ ↓ 调整」', !client.includes('用 ↑ ↓ 调整'))
ok('改为拖拽说明', client.includes('拖动绑定行即可调整'))

console.log('')
console.log(`════════ ${pass} passed / ${fail} failed ════════`)
process.exitCode = fail > 0 ? 1 : 0